// 后端合同与隐私负例：全部账库、原件及调用记录均在临时目录合成。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import * as Backend from '../server/business-baseline.mjs';
import {readBackendBaselinePages} from './helpers/business-baseline-backend-pages.mjs';
import {readFinanceCall} from '../server/finance-call-chain.mjs';
import {syntheticVoucherEvidence} from './helpers/synthetic-posting-evidence.mjs';
import {BUSINESS_MEMORY_DDL,inspectBusinessMemorySchema} from '../server/business-memory-storage.mjs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
const B={...Backend,readBaselineMaterials:readBackendBaselinePages};
const logical=db=>JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all().map(r=>r.type==='table'?[r,db.prepare('SELECT * FROM "'+r.name.replaceAll('"','""')+'"').all()]:r));
test('短基线的实际源值、税义、版本、只读与原生关系',{timeout:120000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'baseline-backend-')),data=join(root,'data'),sourceRoot=join(root,'sources'),auditDir=join(root,'calls');mkdirSync(data);mkdirSync(sourceRoot);
 Object.assign(process.env,{WORKBENCH_DATA_DIR:data,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:auditDir,FINANCE_BUSINESS_SESSION:''});delete process.env.WORKBENCH_DATABASE_MODE;
 const {db}=await import('../server/db.mjs'),A=await import('../server/accounting.mjs');
 const dbPath=join(data,'workbench.db'),options={dbPath,sourceRoot,auditDir,sessionPath:''};process.env.FINANCE_DATABASE_PATH=dbPath;
 const a=A.createAccountSet({name:'PRIVATE_合成甲',taxpayer_type:'一般纳税人',profileId:'enterprise-2019-general-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:'PRIVATE-A'}}).id;
 const b=A.createAccountSet({name:'PRIVATE_合成乙',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:'PRIVATE-B'}}).id;
 const target={accountSetId:a,period:'2026-07'},path=join(sourceRoot,'contract.json');
 const raw={enterpriseKey:'PRIVATE-A',contract:{合同编号:'LEASE-A-APR',业务类别:'租赁',提供方式:'均匀连续服务',服务开始日:'2026-04-01',服务结束日:'2026-09-30',净租金:60000,发票税额:5400,开票日:'2026-04-01',收款日:'2026-04-01'},costMethod:'月末一次加权平均法',returns:[
  {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-04',periodEnd:'2026-04',taxAmount:1800,sales:100000},
  {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-05',periodEnd:'2026-05',taxAmount:2400,sales:120000},
  {taxType:'增值税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'本期',periodStart:'2026-06',periodEnd:'2026-06',taxAmount:1760,sales:80000},
 ],cit:{taxType:'企业所得税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'累计',periodStart:'2026-01',periodEnd:'2026-06',减免后累计应纳税额:3000,累计实际已预缴:2500,累计营业收入:600000}};json(path,raw);
 A.addAccount(a,{code:'222101',name:'销项税','category':'负债',direction:'credit'});
 const posted=(period,amount,linked=true)=>{
  const voucher=syntheticVoucherEvidence({period,voucher_date:period+'-28',number:1,status:'posted',summary:'本月房屋租赁',entries:[{code:'2203',debit:amount,...(linked?{summary:'LEASE-A-APR'}:{})},{code:'6051',credit:amount,...(linked?{summary:'LEASE-A-APR'}:{})}]},sourceRoot);
  if(linked)for(const index of [0,1])voucher.businessEvidence.mappings.push({inputPointer:`/entries/${index}/summary`,parameterLabel:'合同编号',transform:'identity',sources:[{path,jsonPointer:'/contract/合同编号'}]});
  return A.createVoucher(a,voucher);
 };
 posted('2026-04',10000);posted('2026-05',10000);
 const selections=[];const add=(id,field,jsonPointer,group='lease')=>selections.push({id,field,originalId:'contract',group,locator:{jsonPointer}});
 for(const [field,key]of Object.entries({business_reference:'合同编号',business_kind:'业务类别',service_pattern:'提供方式',service_start:'服务开始日',service_end:'服务结束日',amount_net:'净租金',amount_tax:'发票税额',invoice_date:'开票日',receipt_date:'收款日'}))add('lease_'+field,field,'/contract/'+key);
 add('cost','inventory_cost','/costMethod','policy');
 for(let i=0;i<3;i++)for(const [field,key]of Object.entries({tax_type:'taxType',tax_measure:'measure',tax_stage:'stage',period_basis:'basis',accumulation:'accumulation',period_start:'periodStart',period_end:'periodEnd',tax_amount:'taxAmount',sales_ex_vat:'sales'}))add('vat'+i+'_'+field,field,'/returns/'+i+'/'+key,'vat'+i);
 for(const [field,key]of Object.entries({tax_type:'taxType',tax_measure:'measure',tax_stage:'stage',period_basis:'basis',accumulation:'accumulation',period_start:'periodStart',period_end:'periodEnd',tax_amount:'减免后累计应纳税额',revenue:'累计营业收入'}))add('cit_'+field,field,'/cit/'+key,'cit');
 const request={target,originals:[{id:'contract',path}],selections,limit:50};
 let material,saved,saveArgs;
 try{
  await t.test('未生成读取不建组件，资料读取不修改现库，安全发现不披露原文',async()=>{
   const before=logical(db),view=await B.readBusinessBaseline({target},options);assert.equal(view.status,'needs_generation');assert.equal(view.shortText,'');
   const discovered=await B.readBaselineMaterials({target,originals:request.originals,limit:50},options);
   assert(discovered.fields.some(f=>f.suggestedFields.includes('service_start')));assert(discovered.fields.every(f=>f.locator.fieldRef));
   assert.equal(logical(db),before);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='business_memory_versions'").get(),undefined);
   const safe=JSON.stringify(discovered);for(const secret of ['PRIVATE-A','PRIVATE_','LEASE-A-APR','2026-04-01',sourceRoot])assert(!safe.includes(secret),secret);
  });
  await t.test('完整材料核真实关系，VAT合计加权，CIT净应纳单列且原值仅在独立本机底稿',async()=>{
   material=await B.readBaselineMaterials(request,options);assert.equal(material.gaps.length,0,JSON.stringify(material.gaps));
   assert(material.principleSupport.some(p=>p.kind==='revenue_period'&&p.value==='service_period'&&p.when==='lease'&&p.allocationBasis==='monthly_equal'));
   assert(material.principleSupport.some(p=>p.kind==='business_classification'&&p.value==='other_income'&&p.when==='lease'));assert(!material.principleSupport.some(p=>p.kind==='business_classification'&&p.value==='main_income'&&p.when==='lease'));
   assert(material.facts.filter(f=>f.field==='historical_posting').every(f=>f.linkedBusinessRefs?.length));
   const record=await readFinanceCall({auditDir,callId:material.materialRef}),artifact=record.end.metadata.businessBaselineMaterials;
   assert.equal(artifact.file,'baseline-materials.json');assert(!JSON.stringify(record.end.metadata).includes('LEASE-A-APR'));
   const snapshot=JSON.parse(readFileSync(join(record.recordPath,artifact.file))),vat=snapshot.taxBurden.summaries.find(r=>r.taxType==='vat'),cit=snapshot.taxBurden.summaries.find(r=>r.taxType==='cit');
   assert.equal(vat.taxAmount,5960);assert.equal(vat.denominator,300000);assert.equal(vat.weightedRatio,5960/300000);assert.notEqual(vat.weightedRatio,0.02);assert.equal(cit.taxAmount,3000);assert.equal(cit.weightedRatio,0.005);
   const safe=JSON.stringify(material);for(const secret of ['LEASE-A-APR','2026-04-01','"taxAmount":','"denominator":','"originalCost":','"debit":','"credit":'])assert(!safe.includes(secret),secret);
   saveArgs={target,materialRefs:[{materialRef:material.materialRef,snapshotDigest:material.snapshotDigest}],expectedRevision:0,effectiveFrom:'2026-07',principles:material.principleSupport.filter(p=>['accounting_standard','inventory_cost'].includes(p.kind)||p.kind==='revenue_period'&&p.when==='lease'&&p.value==='service_period').map(p=>({supportRef:p.supportRef}))};
   saved=await B.saveBusinessBaseline(saveArgs,options);assert.equal(saved.status,'ready');assert.match(saved.shortText,/企业会计准则/);assert.match(saved.shortText,/整月均匀服务按月等额确认/);assert.match(saved.shortText,/1\.99%/);assert.match(saved.shortText,/0\.50%/);assert(Array.from(saved.shortText).length<=600);assert(saved.shortText.split('\n').length<=9);
   assert(inspectBusinessMemorySchema(db).ok);assert(BUSINESS_MEMORY_DDL.every(sql=>!sql.includes('baseline')),'已安装DDL-v1不为基线改写');
  });
  await t.test('幂等、旧方法隔离和只读写入拒绝',async()=>{
   const repeated=await B.saveBusinessBaseline({...saveArgs,expectedRevision:1},options);assert.equal(repeated.changed,false);assert.equal(repeated.revision,1);assert.equal(repeated.baselineRef,saved.baselineRef);
   await assert.rejects(B.saveBusinessBaseline(saveArgs,options),{code:'finance_baseline_revision_conflict'});
   await assert.rejects(B.saveBusinessBaseline({...saveArgs,expectedRevision:1},{...options,readOnly:true}),{code:'finance_baseline_readonly'});
   const M=await import('../server/business-memory.mjs');assert(!(await M.readCompanyContext({target},options)).methods.some(m=>m.methodRef===saved.baselineRef));
   await assert.rejects(M.readBusinessMethod({target,methodRef:saved.baselineRef},options),{code:'finance_memory_method_missing'});
   await assert.rejects(M.runBusinessMethod({target,methodRef:saved.baselineRef},options),{code:'finance_memory_method_missing'});
   const before=logical(db);await B.readBusinessBaseline({target},{...options,readOnly:true});assert.equal(logical(db),before);
  });
  await t.test('仅材料读取先发现changed，换两根仍保留；跨audit观察不挪材料ref或计算器底稿',async()=>{
   const before=logical(db),unavailable=join(root,'material-unavailable'),otherAudit=join(root,'material-other-audit'),lastAudit=join(root,'material-last-audit');for(const dir of [unavailable,otherAudit,lastAudit])mkdirSync(dir);
   for(const discoveryAudit of [auditDir,otherAudit]){
    json(path,{...raw,costMethod:'先进先出法'});
    const material=await Backend.readBaselineMaterials({target,originals:[{id:'changed',path}],extractKnownFields:true},{...options,auditDir:discoveryAudit});assert.equal(material.baseline.status,'stale');assert.equal(material.baseline.baselineRef,saved.baselineRef);
    const call=await readFinanceCall({auditDir:discoveryAudit,callId:material.materialRef});assert.equal(call.integrity,'verified');assert.equal(call.recordPath,join(discoveryAudit,material.materialRef));assert.equal(call.end.metadata.businessBaselineMaterials.file,'baseline-materials.json');
    // 只做materials觀察，没有先调用read来创建changed记录；实际材料ref仍能在原audit根消费。
    const local=await B.resolveBaselineCalculationFacts({target,materialRefs:[{materialRef:material.materialRef,snapshotDigest:material.snapshotDigest}],expectedReaderSha256:material.calculationReader.sha256},{...options,auditDir:discoveryAudit});assert(local.objects.length);
    const stale=await B.readBusinessBaseline({target},{...options,sourceRoot:unavailable,auditDir:lastAudit});assert.equal(stale.status,'stale');assert(stale.unresolved.some(g=>g.code==='source_changed'));assert.equal(stale.baselineRef,saved.baselineRef);
    json(path,raw);assert.equal((await B.readBusinessBaseline({target},options)).status,'ready');
   }
   assert.equal(logical(db),before);
  });
  await t.test('资料/历史整根不可达与单件缺失区分，真实MCP先重建共享根后二读仍未挂载',{timeout:60000},async()=>{
   const before=logical(db),recordRoot=join(data,'posting-attempts');
   const absent=async(source,run)=>{
    const full=resolve(source),preserved=full+'.unmounted-'+randomUUID(),recreated=full+'.reader-created-'+randomUUID();
    // 每次移动前核实绝对源/目标均在本测试合成根内，不递归删除或覆盖任何成果。
    for(const path of [full,preserved,recreated]){const part=relative(resolve(root),path);assert(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..\\')&&!part.startsWith('../'));}
    assert(existsSync(full));assert(!existsSync(preserved));assert(!existsSync(recreated));renameSync(full,preserved);
    try{return await run();}finally{if(existsSync(full))renameSync(full,recreated);renameSync(preserved,full);}
   };
   const ready=async()=>{const value=await B.readBusinessBaseline({target},options);assert.equal(value.status,'ready');assert.equal(value.baselineRef,saved.baselineRef);};
   const unavailable=value=>{assert.equal(value.status,'needs_review');assert(value.unresolved.some(g=>g.code==='source_unavailable'));assert(!value.unresolved.some(g=>g.code==='source_missing'));};
   await ready();
   for(const directory of [sourceRoot,recordRoot]){await absent(directory,async()=>{unavailable(await B.readBusinessBaseline({target},options));unavailable(await B.readBusinessBaseline({target},options));});await ready();}
   const call=await readFinanceCall({auditDir,callId:material.materialRef}),snapshot=JSON.parse(readFileSync(join(call.recordPath,call.end.metadata.businessBaselineMaterials.file))),proof=snapshot.facts.find(f=>f.source.kind==='ledger_voucher').source.relations[0].files[0].path;
   for(const file of [path,proof]){await absent(file,async()=>{const value=await B.readBusinessBaseline({target},options);assert.equal(value.status,'stale');assert(value.unresolved.some(g=>g.code==='source_missing'));});await ready();}
   // 只有原根不可达时才为unavailable；确证changed/missing后不可因整根不可访问洗掉既有观察。
   json(path,{...raw,costMethod:'先进先出法'});assert.equal((await B.readBusinessBaseline({target},options)).status,'stale');await absent(sourceRoot,async()=>{const value=await B.readBusinessBaseline({target},options);assert.equal(value.status,'stale');assert(value.unresolved.some(g=>g.code==='source_changed'));});json(path,raw);await ready();
   await absent(path,async()=>{assert((await B.readBusinessBaseline({target},options)).unresolved.some(g=>g.code==='source_missing'));await absent(sourceRoot,async()=>{const value=await B.readBusinessBaseline({target},options);assert.equal(value.status,'stale');assert(value.unresolved.some(g=>g.code==='source_missing'));});});await ready();
   // 真实stdio的外层记录器先mkdir；固定观察根内层必须继承该事实，下一独立调用也不能认新空根为原根。
   for(const shared of [sourceRoot,recordRoot]){
    const client=new McpStdioClient(fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url)),{cwd:root,env:{...process.env,FINANCE_MCP_PROFILE:'direct',FINANCE_DATABASE_PATH:dbPath,FINANCE_SOURCE_ROOT:sourceRoot,FINANCE_AUDIT_DIR:shared,FINANCE_API_BASE:'http://127.0.0.1:1',FINANCE_BUSINESS_SESSION:'',NODE_NO_WARNINGS:'1'},timeoutMs:30000}).start();
    try{await client.initialize('synthetic-shared-root');const read=async()=>{const result=await client.call('finance_baseline_read',{target});assert.equal(result.isError,false,result.text);return result.data;};assert.equal((await read()).status,'ready');await absent(shared,async()=>{unavailable(await read());assert(existsSync(shared),'外层记录器确实重建了空根');unavailable(await read());});assert.equal((await read()).status,'ready');}finally{await client.close();}
   }
   assert.equal(logical(db),before,'根可达观察不得修改实际账库或索引');
  });
  await t.test('其他企业、错日期语义、已预缴冒净应纳与伪造材料引用均不获ready',async()=>{
   const changedOwner={...request,target:{accountSetId:b,period:'2026-07'}};await assert.rejects(B.readBaselineMaterials(changedOwner,options),{code:'finance_baseline_source_scope_conflict'});
   const wrongDate=await B.readBaselineMaterials({...request,selections:[{id:'wrongdate',field:'confirmation_date',originalId:'contract',group:'x',locator:{jsonPointer:'/contract/开票日'}}]},options);assert(wrongDate.gaps.includes('unsupported_material'));assert(!wrongDate.facts.some(f=>f.id==='wrongdate'));
   const bad={...request,selections:request.selections.map(s=>s.id==='cit_tax_amount'?{...s,locator:{jsonPointer:'/cit/累计实际已预缴'}}:s)};
   const wrong=await B.readBaselineMaterials(bad,options);assert(wrong.taxBurden.gaps.includes('tax_basis_incomplete'));assert(!wrong.taxBurden.summaries.some(s=>s.taxType==='cit'));
   await assert.rejects(B.saveBusinessBaseline({...saveArgs,materialRefs:[{materialRef:material.materialRef,snapshotDigest:'0'.repeat(64)}],expectedRevision:1},options),{code:'finance_baseline_material_record_invalid'});
   await assert.rejects(B.saveBusinessBaseline({...saveArgs,principles:[{kind:'tax_choice',value:'vat_standard',evidenceRefs:[material.facts.find(f=>f.field==='taxpayer_type').factRef]}],expectedRevision:1},options),{code:'finance_baseline_principle_unsupported'});
  });
  await t.test('旧文件准则不能借另一value的现库准则事实背书，正确typed仍按实际准则保存',async()=>{
   const key='SYNTHETIC-STANDARD-TRUTH',id=A.createAccountSet({name:'合成准则同值约束',profileId:'enterprise-2019-general-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:key}}).id,target={accountSetId:id,period:'2026-07'},oldPath=join(sourceRoot,'old-standard.json'),taxPath=join(sourceRoot,'standard-tax.json');json(oldPath,{enterpriseKey:key,会计准则:'小企业会计准则'});json(taxPath,{enterpriseKey:key,returns:raw.returns,cit:raw.cit});
   const m=await B.readBaselineMaterials({target,originals:[{id:'old',path:oldPath},{id:'tax',path:taxPath}],extractKnownFields:true},options),ledger=m.facts.find(f=>f.field==='accounting_standard'&&f.source.kind==='ledger_configuration'),old=m.facts.find(f=>f.field==='accounting_standard'&&f.source.kind==='file'),materialRefs=[{materialRef:m.materialRef,snapshotDigest:m.snapshotDigest}];assert.equal(ledger.value,'enterprise');assert.equal(old.value,'small_enterprise');assert(!m.principleSupport.some(p=>p.kind==='accounting_standard'&&p.value==='small_enterprise'));
   const before=logical(db);await assert.rejects(B.saveBusinessBaseline({target,materialRefs,expectedRevision:0,effectiveFrom:'2026-07',principles:[{kind:'accounting_standard',value:'small_enterprise',evidenceRefs:[ledger.factRef,old.factRef]}]},options),{code:'finance_baseline_principle_unsupported'});assert.equal(logical(db),before,'错准则组合不能新增版本或改SQL');
   const saved=await B.saveBusinessBaseline({target,materialRefs,expectedRevision:0,effectiveFrom:'2026-07',principles:[{kind:'accounting_standard',value:'enterprise',evidenceRefs:[ledger.factRef]}]},options);assert.equal(saved.status,'needs_review');assert.equal(saved.coverage.businessPrinciplesMissing,true);assert.equal(saved.coverage.generationBasis,'configuration_and_tax_reference');assert(saved.unresolved.some(g=>g.code==='historical_evidence_missing'));assert.match(saved.shortText,/企业会计准则/);assert(!saved.shortText.includes('小企业会计准则'));assert.equal((await B.readBusinessBaseline({target},options)).status,'needs_review');
  });
  await t.test('来源修订阻断旧版，换根/prepare不能恢复ready，仍保留无影响的现库准则',async()=>{
   json(path,{...raw,costMethod:'先进先出法'});await assert.rejects(B.saveBusinessBaseline({...saveArgs,expectedRevision:1},options),{code:'finance_baseline_material_changed'});
   const changedAudit=join(root,'changed-audit');mkdirSync(changedAudit);const stale=await B.readBusinessBaseline({target},{...options,auditDir:changedAudit});assert.equal(stale.status,'stale');assert.match(stale.shortText,/企业会计准则/);assert(!stale.shortText.includes('月末一次加权平均'));
   const elsewhere=join(root,'elsewhere');mkdirSync(elsewhere);const unverified=await B.readBusinessBaseline({target},{...options,auditDir:changedAudit,sourceRoot:elsewhere});assert.equal(unverified.status,'stale');assert(unverified.unresolved.some(g=>g.code==='source_changed'));
   await (await import('../server/business-memory.mjs')).prepareBusinessMemory({target},options);assert.equal((await B.readBusinessBaseline({target},options)).status,'stale');
   json(path,raw);
  });
  await t.test('资产原价和历史同额关系不能仅凭caller选择冒充支持',async()=>{
   const standalone=await B.readBaselineMaterials({target},options);assert(!standalone.principleSupport.some(p=>p.kind==='revenue_period'));assert.equal(standalone.taxBurden.missing,true);
   const withoutReference=await B.readBaselineMaterials({...request,selections:request.selections.filter(s=>s.field!=='business_reference')},options);assert(!withoutReference.principleSupport.some(p=>p.kind==='revenue_period'&&p.value==='service_period'));
   const unlinkedArgs={...saveArgs,materialRefs:[{materialRef:withoutReference.materialRef,snapshotDigest:withoutReference.snapshotDigest}],expectedRevision:1,principles:[{kind:'revenue_period',value:'service_period',when:'lease',evidenceRefs:withoutReference.facts.filter(f=>f.field==='historical_posting'||f.id?.startsWith('lease_')).map(f=>f.factRef)}]};
   await assert.rejects(B.saveBusinessBaseline(unlinkedArgs,options),{code:'finance_baseline_principle_unsupported'});
  });
  await t.test('金额单位、币种与含税分母不默认转换；caller group不能拼接税表行',async()=>{
   for(const patch of [{currency:'USD'},{金额单位:'万元'},{销售额口径:'含税'}]){
    json(path,{...raw,...patch});const rejected=await B.readBaselineMaterials(request,options);assert(rejected.gaps.includes('unsupported_material'));assert(!rejected.taxBurden.summaries.some(s=>s.taxType==='vat'));
   }json(path,raw);
   const mixed={...request,selections:request.selections.map(s=>s.id==='vat0_sales_ex_vat'?{...s,locator:{jsonPointer:'/returns/1/sales'}}:s)};
   const m=await B.readBaselineMaterials(mixed,options);assert(m.taxBurden.gaps.includes('tax_basis_incomplete'));assert(m.taxBurden.summaries.every(s=>s.taxType!=='vat'||s.periodCount<3));
  });
  await t.test('税务选择覆盖整月，租赁政策不能因省略when泛化全账套',async()=>{
   const choicePath=join(sourceRoot,'choice.json'),choice={enterpriseKey:'PRIVATE-A',业务类别:'租赁',租赁税务计税选择:'一般计税',有效开始日:'2026-07-01',有效终止日:'2026-07-15',所得税租金口径:'合同约定应付期'};
   const original={id:'choice',path:choicePath},selections=Object.entries({business_kind:'业务类别',tax_choice:'租赁税务计税选择',choice_valid_from:'有效开始日',choice_valid_through:'有效终止日',income_tax_period:'所得税租金口径'}).map(([field,key],i)=>({id:'choice'+i,field,originalId:'choice',locator:{jsonPointer:'/'+key}}));
   json(choicePath,choice);const partial=await B.readBaselineMaterials({target,originals:[original],selections},options);assert(!partial.principleSupport.some(p=>p.kind==='tax_choice'));assert(!partial.principleSupport.some(p=>p.kind==='income_tax_period'&&p.when==='account_set'));
   json(choicePath,{...choice,有效终止日:'2026-12-31'});const complete=await B.readBaselineMaterials({target,originals:[original],selections},options);assert(complete.principleSupport.some(p=>p.kind==='tax_choice'&&p.when==='lease'));
   assert(!complete.principleSupport.some(p=>p.kind==='tax_choice'&&p.when==='account_set'));
  });
  await t.test('正式登记主体名可与账套别名不同，未登记显示名不能自认归属',async()=>{
   const c=A.createAccountSet({name:'合成会计内部别名',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:'REGISTRY-C',enterpriseName:'已登记合成主体正式名称'}}).id;
   const namePath=join(sourceRoot,'registered-name.json');json(namePath,{companyName:'已登记合成主体正式名称',costMethod:'先进先出法'});
   const request={target:{accountSetId:c,period:'2026-07'},originals:[{id:'registered',path:namePath}],selections:[{id:'registeredcost',field:'inventory_cost',originalId:'registered',locator:{jsonPointer:'/costMethod'}}]};
   const yes=await B.readBaselineMaterials(request,options);assert.equal(yes.facts.find(f=>f.id==='registeredcost').value,'fifo');
   json(namePath,{companyName:'合成会计内部别名',costMethod:'先进先出法'});await assert.rejects(B.readBaselineMaterials(request,options),{code:'finance_baseline_source_scope_conflict'});
  });
  await t.test('合并凭证的预收行关系不能给另一业务收入/费用/税额背书',async()=>{
   const lease=join(sourceRoot,'unearned.json'),other=join(sourceRoot,'unrelated.json');json(lease,{enterpriseKey:'PRIVATE-A',合同编号:'LEASE-NOT-EARNED',业务类别:'租赁',提供方式:'均匀连续服务',服务开始日:'2026-04-01',服务结束日:'2026-09-30',净租金:60000});json(other,{enterpriseKey:'PRIVATE-A',业务编号:'UNRELATED-SERVICE',业务类别:'维修'});
   for(const period of ['2026-04','2026-05']){
    const v=syntheticVoucherEvidence({period,voucher_date:period+'-28',number:2,status:'posted',summary:'两个业务合并凭证',entries:[{code:'1002',debit:10001},{code:'6001',credit:10000,summary:'UNRELATED-SERVICE'},{code:'2203',credit:1,summary:'LEASE-NOT-EARNED'}]},sourceRoot);
    v.businessEvidence.mappings.push({inputPointer:'/entries/1/summary',parameterLabel:'维修业务号',transform:'identity',sources:[{path:other,jsonPointer:'/业务编号'}]},{inputPointer:'/entries/2/summary',parameterLabel:'仅租赁预收行',transform:'identity',sources:[{path:lease,jsonPointer:'/合同编号'}]});A.createVoucher(a,v);
   }
   const selections=Object.entries({business_reference:'合同编号',business_kind:'业务类别',service_pattern:'提供方式',service_start:'服务开始日',service_end:'服务结束日',amount_net:'净租金'}).map(([field,key],i)=>({id:'combined'+i,field,originalId:'onlylease',locator:{jsonPointer:'/'+key}}));
   const m=await B.readBaselineMaterials({target,originals:[{id:'onlylease',path:lease}],selections,limit:50},options);
   assert(!m.principleSupport.some(p=>p.when==='lease'&&['revenue_period','business_classification'].includes(p.kind)));
   const evidenceRefs=m.facts.filter(f=>f.source.kind==='file'||f.field==='historical_posting').map(f=>f.factRef);for(const p of [{kind:'revenue_period',value:'service_period'},{kind:'business_classification',value:'main_income'}])await assert.rejects(B.saveBusinessBaseline({target,materialRefs:[{materialRef:m.materialRef,snapshotDigest:m.snapshotDigest}],expectedRevision:1,effectiveFrom:'2026-07',principles:[{...p,when:'lease',evidenceRefs}]},options),{code:'finance_baseline_principle_unsupported'});
  });
  await t.test('宽泛直接政策不能自带按月等额；仅累计VAT必须明确缺口',async()=>{
   const direct=join(sourceRoot,'generic-policy.json');json(direct,{enterpriseKey:'PRIVATE-A',业务类别:'租赁',revenue_period:'服务所属期'});
   const m=await B.readBaselineMaterials({target,originals:[{id:'generic',path:direct}],selections:[{id:'generic_kind',field:'business_kind',originalId:'generic',locator:{jsonPointer:'/业务类别'}},{id:'generic_policy',field:'revenue_period',originalId:'generic',locator:{jsonPointer:'/revenue_period'}}]},options),p=m.principleSupport.find(p=>p.kind==='revenue_period');assert(p);assert.equal(p.allocationBasis,undefined);
   await assert.rejects(B.saveBusinessBaseline({target,materialRefs:[{materialRef:m.materialRef,snapshotDigest:m.snapshotDigest}],expectedRevision:1,effectiveFrom:'2026-07',principles:[{kind:p.kind,value:p.value,when:p.when,allocationBasis:'monthly_equal',evidenceRefs:m.facts.filter(f=>f.source.kind==='file').map(f=>f.factRef)}]},options),{code:'finance_baseline_principle_unsupported'});
   json(path,{...raw,returns:raw.returns.map(r=>({...r,accumulation:'累计',periodStart:'2026-01'}))});const cum=await B.readBaselineMaterials({...request,selections:request.selections.filter(s=>s.id.startsWith('vat'))},options);assert.equal(cum.taxBurden.summaries.length,0);assert.equal(cum.taxBurden.missing,true);assert(cum.taxBurden.gaps.includes('tax_basis_incomplete'));
   const standard=cum.facts.find(f=>f.field==='accounting_standard'),saved=await B.saveBusinessBaseline({target,materialRefs:[{materialRef:cum.materialRef,snapshotDigest:cum.snapshotDigest}],expectedRevision:1,effectiveFrom:'2026-07',principles:[{kind:'accounting_standard',value:'enterprise',evidenceRefs:[standard.factRef]}]},options);assert.equal(saved.status,'needs_review');assert(saved.unresolved.some(g=>g.code==='tax_basis_incomplete'));json(path,raw);
  });
  await t.test('单税种范围可ready；本期空验收日不冒认预计日，也不污染已核历史原则',async()=>{
   const key='SYNTHETIC-NULL-ACCEPTANCE',id=A.createAccountSet({name:'合成小企业维修',profileId:'small-2011-basic-v1',start_period:'2026-01',enterprise:{enterpriseKey:key}}).id,target={accountSetId:id,period:'2026-07'},workPath=join(sourceRoot,'null-acceptance.json'),taxPath=join(sourceRoot,'single-tax.json');
   const work={enterpriseKey:key,业务性质:'一次性设备维修',业务类别:'维修',提供方式:'一次完工',costMethod:'先进先出法',工单:[
    {工单:'NULL-APR-COMPLETE',客户签收验收日:'2026-04-25',净价:4000},
    {工单:'NULL-MAY-COMPLETE',客户签收验收日:'2026-05-25',净价:5000},
    {工单:'NULL-JUL-COMPLETE',客户签收验收日:'2026-07-25',净价:40000},
    {工单:'NULL-JUL-WIP',客户签收验收日:null,预计验收日:'2026-08-04',净价:60000},
   ]},tax={enterpriseKey:key,returns:raw.returns};json(workPath,work);json(taxPath,tax);
   for(const [index,period,amount]of [[0,'2026-04',4000],[1,'2026-05',5000]]){
    const v=syntheticVoucherEvidence({period,voucher_date:period+'-25',number:1,status:'posted',entries:[{code:'1002',debit:amount,summary:work.工单[index].工单},{code:'5001',credit:amount,summary:work.工单[index].工单}]},sourceRoot);
    for(const i of [0,1])v.businessEvidence.mappings.push({inputPointer:`/entries/${i}/summary`,parameterLabel:'维修工单',transform:'identity',sources:[{path:workPath,jsonPointer:`/工单/${index}/工单`}]});A.createVoucher(id,v);
   }
   const originals=[{id:'work',path:workPath},{id:'vat',path:taxPath}],bytes=[readFileSync(workPath),readFileSync(taxPath)],m=await B.readBaselineMaterials({target,originals,extractKnownFields:true},options);assert.deepEqual(m.gaps,[]);assert.equal(m.coverage.taxHistory.vat.status,'included');assert.equal(m.coverage.taxHistory.cit.status,'not_in_supplied_materials');
   assert(m.principleSupport.some(p=>p.kind==='revenue_period'&&p.value==='delivery_acceptance'&&p.when==='repair'));
   const local=await B.resolveBaselineCalculationFacts({target,materialRefs:[{materialRef:m.materialRef,snapshotDigest:m.snapshotDigest}],expectedReaderSha256:m.calculationReader.sha256},options),unfinished=local.objects.find(o=>o.values.amount_net===60000),finished=local.objects.find(o=>o.values.amount_net===40000);
   assert(unfinished);assert.equal(unfinished.values.delivery_date,undefined);assert.equal(finished.values.delivery_date,'2026-07-25');assert(!JSON.stringify(local).includes('2026-08-04'),'预计验收日期未被取数桥误当已发生验收');
   const call=await readFinanceCall({auditDir,callId:m.materialRef}),snapshot=JSON.parse(readFileSync(join(call.recordPath,call.end.metadata.businessBaselineMaterials.file)));assert(snapshot.diagnostics.some(d=>d.field==='delivery_date'&&d.code==='value_not_provided'));
   const principles=m.principleSupport.filter(p=>['accounting_standard','inventory_cost','revenue_period'].includes(p.kind)).map(p=>({supportRef:p.supportRef})),saved=await B.saveBusinessBaseline({target,materialRefs:[{materialRef:m.materialRef,snapshotDigest:m.snapshotDigest}],expectedRevision:0,effectiveFrom:'2026-07',principles},options);assert.equal(saved.status,'ready');assert(!saved.unresolved.length);assert.equal(saved.coverage.taxHistory.cit.status,'not_in_supplied_materials');assert.match(saved.shortText,/交付验收期/);assert(!saved.shortText.includes('所得税截至'));
   for(const [index,file]of [workPath,taxPath].entries())assert.deepEqual(readFileSync(file),bytes[index],'读取与保存不改原件bytes');
   json(workPath,{...work,工单:work.工单.map((w,i)=>i===3?{...w,客户签收验收日:'预计2026-08-04'}:w)});const invalid=await B.readBaselineMaterials({target,originals,extractKnownFields:true},options);assert(invalid.gaps.includes('unsupported_material'));writeFileSync(workPath,bytes[0]);
   // 已实际提供的所得税表只有实缴列可用，不能靠另一税的有效summary掩盖应纳口径不完整。
   const partial={...tax,cit:{taxType:'企业所得税',measure:'应纳',stage:'减免后应纳',basis:'所属期',accumulation:'累计',periodStart:'2026-01',periodEnd:'2026-06',累计实际已预缴:2500,累计营业收入:600000}};json(taxPath,partial);
   const incomplete=await B.readBaselineMaterials({target,originals,extractKnownFields:true},options);assert.equal(incomplete.taxBurden.missing,false);assert.equal(incomplete.coverage.taxHistory.cit.status,'incomplete');const reviewed=await B.saveBusinessBaseline({target,materialRefs:[{materialRef:incomplete.materialRef,snapshotDigest:incomplete.snapshotDigest}],expectedRevision:1,effectiveFrom:'2026-07',principles:incomplete.principleSupport.filter(p=>p.kind==='accounting_standard').map(p=>({supportRef:p.supportRef}))},options);assert.equal(reviewed.status,'needs_review');assert(reviewed.unresolved.some(g=>g.code==='tax_basis_incomplete'));
   json(taxPath,{...tax,returns:tax.returns.map((r,i)=>i===0?{...r,taxAmount:null}:r)});const nullTax=await B.readBaselineMaterials({target,originals,extractKnownFields:true},options);assert(nullTax.gaps.includes('tax_basis_incomplete'),'税额空值不能当普通可选日期忽略');
  });
 }finally{db.close();}
});
