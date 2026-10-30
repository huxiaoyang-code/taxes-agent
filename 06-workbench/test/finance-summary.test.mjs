import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {callFinanceTaxSummaryCalculate,getFinanceSummarySafeDiagnostics} from '../server/finance-summary.mjs';
import {calculateFinanceSummary} from '../server/finance-summary-engine.mjs';
import {financeSummaryContract,FINANCE_SUMMARY_INPUT_SCHEMA,isFinanceSummaryAmountPointer} from '../server/finance-summary-contracts.mjs';
import {validateSchemaValue} from '../server/harness-schema-validation.mjs';
const root=mkdtempSync(join(tmpdir(),'finance-summary-synthetic-')),dbPath=join(root,'synthetic.db'),auditDir=join(root,'audit');
const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE audit_database_instances(instance_id TEXT,is_active INTEGER); CREATE TABLE account_sets(id INTEGER); CREATE TABLE import_enterprise_account_sets(account_set_id INTEGER,enterprise_key TEXT)');db.prepare('INSERT INTO audit_database_instances VALUES(?,1)').run('SYNTHETIC-INSTANCE');for(const id of [1,2]){db.prepare('INSERT INTO account_sets VALUES(?)').run(id);db.prepare('INSERT INTO import_enterprise_account_sets VALUES(?,?)').run(id,`PRIVATE-SUBJECT-${id}`);}db.close();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),dbBefore=sha(readFileSync(dbPath));let counter=0;
const scope=(period='2026-03',accountSetId=1)=>({enterpriseKey:`PRIVATE-SUBJECT-${accountSetId}`,accountSetId,databaseInstanceId:'SYNTHETIC-INSTANCE',period,currency:'CNY'});
function make(kind,inputs,{period='2026-03',accountSetId=1,sourcePeriod,sourceScope=true}={}){const path=join(root,`original-${++counter}.json`),raw={...(sourceScope?{scope:scope(period,accountSetId)}:{}),...(sourcePeriod?{period:sourcePeriod}:{}),inputs,privateName:'PRIVATE-PERSON-NAME',api_key:'PRIVATE-CREDENTIAL-SENTINEL'};writeFileSync(path,JSON.stringify(raw));return {target:{accountSetId,period},kind,dbPath,originals:[{id:'original',path}],inputs,bindings:[{inputPointer:'',originalId:'original',locator:{jsonPointer:'/inputs'}}]};}
const run=args=>callFinanceTaxSummaryCalculate(args,{auditDir});
const pathFor=result=>join(auditDir,'artifacts',result.evidence.callRef,'summary.json');
const full=result=>JSON.parse(readFileSync(pathFor(result),'utf8'));
const general=()=>({outputVat:20000,certifiedInputVat:10000,inputVatTransferOut:100,openingCarryCredit:300,prepaidVat:200});
const small=sales=>({periodType:'monthly',salesExcludingVat:sales,specialInvoiceSalesExcludingVat:0,specialInvoiceVat:0,reliefElection:'reduced',taxpayerCategory:'small',ordinaryDomesticScopeConfirmed:true,remainingSalesEligibleForThresholdExemption:true,allSalesEligibleForOnePercentRelief:true,noPropertyOrLandTransactions:true});
const cit=()=>({profitTotalYtd:200000,validPriorYearLossOffset:20000,otherPrepaymentAdjustments:0,prepaidThisYear:2500,quarterAverageEmployees:20,quarterAverageAssetsYuan:4500000,restrictedOrProhibitedIndustry:false,prepaymentMethod:'actual_profit_quarterly'});
const salary=()=>({monthlyGrossSalary:20000,monthlyValidSpecialDeductions:3000,monthlyValidAdditionalDeductions:2000,monthsToPeriod:3,priorWithholding:500,otherRelief:0,residentIndividual:true,salaryPaidInSameMonth:true,specialFullYear60000DeductionApplicable:false,firstEmploymentExceptionApplicable:false});
test('合同披露六分支及条件边界，缺汇总操作数保持needs_inputs',async()=>{
 assert.equal(financeSummaryContract().kinds.length,6);const args=make('cit_prepayment',{});args.bindings=[];assert.deepEqual(validateSchemaValue(FINANCE_SUMMARY_INPUT_SCHEMA,args),[]);const r=await run(args);assert.equal(r.status,'needs_inputs');assert.equal(r.needsInputs.length,4);assert.deepEqual(r.amounts,{});assert.equal(r.review.posted,false);assert.equal(r.review.booksVerified,false);assert.equal(r.review.submittable,false);
});
test('一般VAT精确汇总、期初转出预缴分开，完整来源和本机人读页留档且模型无原值/凭据',async()=>{
 const args=make('vat_general',general()),r=await run(args),native=full(r);assert.equal(r.status,'conditional_calculated');assert.equal(r.amounts.due,9600);assert.equal(r.amounts.dueBeforePrepayment,9800);assert.equal(r.resultOrigin,'conditional_summary_engine');
 const projected=JSON.stringify(r);for(const value of ['PRIVATE-SUBJECT','PRIVATE-PERSON','PRIVATE-CREDENTIAL',args.originals[0].path,'employeeId'])assert(!projected.includes(value));
 assert.equal(native.scope.enterpriseKey,'PRIVATE-SUBJECT-1');assert.equal(native.input.sourceRefs.length,5);assert(native.input.sourceRefs.every(s=>s.sha256===sha(readFileSync(args.originals[0].path))&&s.jsonPointer.startsWith('/inputs/')&&s.sourceType==='original'));
 const dir=join(auditDir,'artifacts',r.evidence.callRef),index=JSON.parse(readFileSync(join(dir,'evidence-index.json'),'utf8'));for(const file of index.files)assert.equal(sha(readFileSync(join(dir,file.snapshot))),file.sha256);assert(index.files.some(f=>f.kind==='code'));
 const review=readFileSync(join(dir,'review.md'),'utf8');assert(review.indexOf('## 账本金额')<review.indexOf('## 计算结果'));assert(review.includes('未核条件'));
 const end=JSON.parse(readFileSync(join(auditDir,r.evidence.callRef,'end.json'),'utf8'));assert.equal(end.businessOutcome,'conditional_calculated');assert(end.loadedSources.some(s=>s.path===args.originals[0].path&&s.sha256===sha(readFileSync(s.path))));
 assert.equal(sha(readFileSync(dbPath)),dbBefore);
});
test('货物原始单据逐单汇总后舍入，并由原生固定13%计算，拒绝同时给冲突汇总替代值',async()=>{
 const inputs={goodsSalesDocuments:[{lines:[{quantity:1,unitPrice:0.04},{quantity:1,unitPrice:0.04},{quantity:1,unitPrice:0.04}]}],certifiedInputVat:0};const r=await run(make('vat_general',inputs));assert.equal(r.amounts.due,0.02);assert.equal(r.amounts.salesExcludingVat,0.12);assert.equal(r.amounts.outputVat,0.02);assert.equal(r.amounts.certifiedInputVat,0);assert(r.conditions.some(c=>c.code==='goods_price_excludes_vat_assumption'));assert(r.conditions.some(c=>c.code==='openingCarryCredit_zero_assumption'));
 const conflict=await run(make('vat_general',{...inputs,outputVat:999}));assert.equal(conflict.status,'unsupported');assert.deepEqual(conflict.amounts,{});
 const transfer=await run(make('vat_general',{...general(),inputVatTransferOut:20000}));assert.equal(transfer.status,'unsupported');assert.equal(transfer.unsupportedReason,'negative_available_input_credit');
});
test('2026小规模恰月10万/季30万全额，未达到才免；原件数列固定求和而不是模型合计',async()=>{
 for(const [sales,periodType,due]of [[99999.99,'monthly',0],[100000,'monthly',1000],[299999.99,'quarterly',0],[300000,'quarterly',3000]]){const r=await run(make('vat_small',{...small(sales),periodType}));assert.equal(r.amounts.due,due);}
 const r=await run(make('vat_small',{...small([90000,80000,110000,50000]),periodType:'quarterly',specialInvoiceSalesExcludingVat:20000,specialInvoiceRate:0.01,specialInvoiceVat:200,specialInvoiceWaiverOfExemption:true}));assert.equal(r.amounts.due,3300);assert(full(r).steps.some(s=>s.id==='salesExcludingVat_sum'));
});
test('明确否定的小规模身份/范围/免税资格不被未核说明掩盖；未知减征不默认1%',async()=>{
 for(const changed of [{taxpayerCategory:'general'},{noPropertyOrLandTransactions:false},{ordinaryDomesticScopeConfirmed:false},{remainingSalesEligibleForThresholdExemption:false},{allSalesEligibleForOnePercentRelief:false}]){const r=await run(make('vat_small',{...small(90000),...changed}));assert.equal(r.status,'unsupported');assert.deepEqual(r.amounts,{});}
 const inputs=small(110000);delete inputs.reliefElection;const r=await run(make('vat_small',inputs));assert.equal(r.scenarios.length,2);assert(!Object.hasOwn(r.amounts,'due'));assert.deepEqual(r.scenarios.map(s=>s.amounts.due),[3300,1100]);
});
test('附加教育免征边界含等号，福建地方2%且六税未知列双条件，消费税本体不在此计算',async()=>{
 const inputs={periodType:'monthly',vatBase:1000,consumptionTaxBase:0,salesExcludingVat:100000,classification:'city'};const r=await run(make('surcharges',inputs));assert.equal(r.scenarios.length,2);assert.deepEqual(r.scenarios.map(s=>s.amounts.educationSurcharge),[0,0]);assert.deepEqual(r.scenarios.map(s=>s.amounts.urbanMaintenance),[70,35]);assert(!Object.hasOwn(r.amounts,'total'));
 const upper=await run(make('surcharges',{...inputs,salesExcludingVat:100000.01,taxpayerCategory:'small'}));assert.equal(upper.amounts.total,60);assert(upper.conditions.some(c=>c.code==='local_education_standard_scope_unverified'));assert(!Object.hasOwn(full(upper),'entries'));
});
test('CIT接受有源Q1利润/亏损/平均人数资产；资格缺件不默选优惠，后续不误用单季平均',async()=>{
 const r=await run(make('cit_prepayment',cit()));assert.equal(r.amounts.taxableBase,180000);assert.equal(r.amounts.due,6500);
 const inputs=cit();delete inputs.quarterAverageEmployees;const unknown=await run(make('cit_prepayment',inputs));assert.equal(unknown.scenarios.length,2);assert(!Object.hasOwn(unknown.amounts,'due'));
 const q2=await run(make('cit_prepayment',cit(),{period:'2026-06'}));assert.equal(q2.scenarios.length,2);assert(q2.conditions.some(c=>c.code==='cit_ytd_small_profit_qualification_unverified'));
 const edge=cit();delete edge.quarterAverageEmployees;delete edge.quarterAverageAssetsYuan;edge.quarterProfiles=[300,300,300.000001].map((averageEmployees,i)=>({quarter:i+1,averageEmployees,averageAssetsYuan:1000000}));const q3=await run(make('cit_prepayment',edge,{period:'2026-09'}));assert.equal(q3.scenarios.length,1);assert.equal(q3.scenarios[0].scenario,'ordinary_25_percent');
});
test('PIT固定月汇总由引擎累计，普通居民梯度与负预扣暂不退；排除例外和月额数组重复累计',async()=>{
 const r=await run(make('salary_pit_cumulative',salary()));assert.equal(r.amounts.cumulativeIncome,60000);assert.equal(r.amounts.taxableBase,30000);assert.equal(r.amounts.currentWithholding,400);
 const over=await run(make('salary_pit_cumulative',{...salary(),priorWithholding:2000}));assert.equal(over.amounts.currentWithholding,0);assert.equal(over.amounts.overwithheldNotRefunded,1100);
 for(const patch of [{residentIndividual:false},{specialFullYear60000DeductionApplicable:true},{firstEmploymentExceptionApplicable:true},{salaryPaidInSameMonth:false}])assert.equal((await run(make('salary_pit_cumulative',{...salary(),...patch}))).status,'unsupported');
 const cumulative={cumulativeIncome:['20000','20000','20000'],cumulativeSpecialDeductions:[3000,3000,3000],cumulativeAdditionalDeductions:[2000,2000,2000],employmentMonths:3,priorWithholding:500,otherRelief:0};assert.equal((await run(make('salary_pit_cumulative',cumulative))).amounts.currentWithholding,400);
 await assert.rejects(run(make('salary_pit_cumulative',{...salary(),monthlyGrossSalary:[20000,20000,20000]})),{code:'finance_summary_input_invalid'});
 const branch=calculateFinanceSummary('salary_pit_cumulative',{cumulativeIncome:'51000.10',cumulativeSpecialDeductions:0,cumulativeAdditionalDeductions:0,employmentMonths:3,priorWithholding:0,otherRelief:0},scope());assert.equal(branch.amounts.currentWithholding,'1080.01');assert.equal(branch.withholdingRateBasisPoints,1000);
});
test('印花税只扣合同单列VAT，优惠未知不默选；税率由固定代码确定',async()=>{
 const r=await run(make('stamp_sale',{amountIncludingVat:113000,vatAmount:13000,separatelyStatedVat:true}));assert.equal(r.amounts.taxableBase,100000);assert.deepEqual(r.scenarios.map(s=>s.amounts.due),[30,15]);
 const no=await run(make('stamp_sale',{amountIncludingVat:113000,separatelyStatedVat:false,taxpayerCategory:'small'}));assert.equal(no.amounts.due,16.95);
 await assert.rejects(run(make('stamp_sale',{amountIncludingVat:100000,separatelyStatedVat:false,rate:0.0001})),{code:'finance_summary_input_invalid'});
});
test('单个已知人数或资产超限即可排除小微优惠，另一指标缺失不恢复优惠情景',async()=>{
 for(const inputs of [{...cit(),quarterAverageEmployees:301},{...cit(),quarterAverageAssetsYuan:50000001}]){if(inputs.quarterAverageEmployees===301)delete inputs.quarterAverageAssetsYuan;else delete inputs.quarterAverageEmployees;const r=await run(make('cit_prepayment',inputs));assert.equal(r.scenarios.length,1);assert.equal(r.scenarios[0].scenario,'ordinary_25_percent');assert.equal(r.amounts.due,42500);}
});
test('季度附加资格须覆盖整个季度，末月窗口不足则要求有源分期基数',async()=>{
 const inputs={periodType:'quarterly',vatBase:10000,consumptionTaxBase:0,salesExcludingVat:400000,classification:'city',taxpayerCategory:'general',sixTaxRelief:'eligible',reliefValidFrom:'2026-03-01',reliefValidThrough:'2026-12-31'},r=await run(make('surcharges',inputs));assert.equal(r.status,'unsupported');assert.equal(r.unsupportedReason,'relief_window_requires_period_split');assert.deepEqual(r.amounts,{});assert.equal(r.scenarios.length,0);assert(r.needsInputs.some(n=>n.field==='periodSplitBases'));
 const fullQuarter=await run(make('surcharges',{...inputs,reliefValidFrom:'2026-01-01'}));assert.equal(fullQuarter.status,'conditional_calculated');assert.equal(fullQuarter.amounts.total,600);
});
test('月度附加和印花资格未来/过期不减半，部分覆盖须拆期，完整窗口才条件减半',async()=>{
 for(const kind of ['surcharges','stamp_sale']){
  const base=kind==='surcharges'?{periodType:'monthly',vatBase:10000,consumptionTaxBase:0,salesExcludingVat:400000,classification:'city'}:{amountIncludingVat:100000,separatelyStatedVat:false};
  const common={...base,taxpayerCategory:'general',sixTaxRelief:'eligible'};
  for(const window of [{reliefValidFrom:'2026-01-01',reliefValidThrough:'2026-02-28'},{reliefValidFrom:'2026-04-01',reliefValidThrough:'2026-12-31'},{reliefValidFrom:'2026-04-01'}]){const r=await run(make(kind,{...common,...window}));assert.equal(r.status,'conditional_calculated');assert.equal(r.scenarios.length,1);assert.equal(kind==='surcharges'?r.amounts.total:r.amounts.due,kind==='surcharges'?1200:30);assert(r.conditions.some(c=>c.code==='six_tax_window_outside_period'));}
  for(const window of [{reliefValidFrom:'2026-03-15',reliefValidThrough:'2026-12-31'},{reliefValidFrom:'2026-01-01',reliefValidThrough:'2026-03-15'}]){const r=await run(make(kind,{...common,...window}));assert.equal(r.status,'unsupported');assert.equal(r.unsupportedReason,'relief_window_requires_period_split');assert.equal(r.scenarios.length,0);assert(!Object.hasOwn(r.amounts,'due'));assert(!Object.hasOwn(r.amounts,'total'));}
  const covered=await run(make(kind,{...common,reliefValidFrom:'2026-03-01',reliefValidThrough:'2026-03-31'}));assert.equal(covered.status,'conditional_calculated');assert.equal(kind==='surcharges'?covered.amounts.total:covered.amounts.due,kind==='surcharges'?600:15);
  const unknown=await run(make(kind,common));assert.equal(unknown.scenarios.length,2);
 }
});
test('只有有源VAT金额但缺合同单列布尔时，列两种基础而不猜true或借无关原件值',async()=>{
 const r=await run(make('stamp_sale',{amountIncludingVat:113000,vatAmount:13000,taxpayerCategory:'small'}));assert.equal(r.status,'conditional_calculated');assert.equal(r.scenarios.length,2);assert(!Object.hasOwn(r.amounts,'due'));assert.deepEqual(r.scenarios.map(s=>s.amounts.taxableBase),[113000,100000]);assert.deepEqual(r.scenarios.map(s=>s.amounts.due),[16.95,15]);assert(r.conditions.some(c=>c.code==='contract_vat_separate_statement_unverified'));assert(full(r).sourceRefs.every(s=>s.inputPointer!=='/separatelyStatedVat'));
 const missing=await run(make('stamp_sale',{amountIncludingVat:113000}));assert.equal(missing.status,'needs_inputs');assert.deepEqual(missing.amounts,{});
});
test('精确绑定拒绝模型派生合计、无源字段、三位decimal变换、原件摘要和跨账套冲突',async()=>{
 const changed=make('vat_general',general());changed.inputs={...changed.inputs,outputVat:20001};await assert.rejects(run(changed),{code:'finance_summary_binding_value_mismatch'});
 const missing=make('vat_general',general());missing.bindings=[];await assert.rejects(run(missing),{code:'finance_summary_input_source_missing'});
 const decimal=make('vat_general',{outputVat:'1.23',certifiedInputVat:0});writeFileSync(decimal.originals[0].path,JSON.stringify({value:1.234,zero:0}));decimal.bindings=[{inputPointer:'/outputVat',originalId:'original',locator:{jsonPointer:'/value'},transform:'decimal'},{inputPointer:'/certifiedInputVat',originalId:'original',locator:{jsonPointer:'/zero'}}];await assert.rejects(run(decimal),{code:'finance_summary_binding_transform_invalid'});
 const badSha=make('vat_general',general());badSha.originals[0].sha256='a'.repeat(64);await assert.rejects(run(badSha),{code:'finance_summary_source_digest_mismatch'});
 const cross=make('vat_general',general());cross.target.accountSetId=2;await assert.rejects(run(cross),{code:'finance_summary_source_scope_conflict'});
 const unscoped=await run(make('vat_general',general(),{sourceScope:false}));assert(unscoped.conditions.some(c=>c.code==='original_subject_association_unverified'));
});
test('原件期间冲突拒绝，季度及YTD范围内的逐月来源合法；不以全局hash代替逐值核对',async()=>{
 await assert.rejects(run(make('vat_general',general(),{sourcePeriod:'2025-03'})),{code:'finance_summary_source_period_conflict'});
 const args=make('vat_small',{...small([90000,80000,110000]),periodType:'quarterly'}),raw=JSON.parse(readFileSync(args.originals[0].path,'utf8'));raw.monthlySales=[{period:'2026-01',netSales:90000},{period:'2026-02',netSales:80000},{period:'2026-03',netSales:110000}];delete raw.inputs.salesExcludingVat;writeFileSync(args.originals[0].path,JSON.stringify(raw));args.bindings=Object.keys(raw.inputs).map(k=>({inputPointer:`/${k}`,originalId:'original',locator:{jsonPointer:`/inputs/${k}`}}));args.bindings.push(...raw.monthlySales.map((_,i)=>({inputPointer:`/salesExcludingVat/${i}`,originalId:'original',locator:{jsonPointer:`/monthlySales/${i}/netSales`}})));assert.equal((await run(args)).amounts.due,0);
 raw.monthlySales[2].period='2026-04';writeFileSync(args.originals[0].path,JSON.stringify(raw));await assert.rejects(run(args),{code:'finance_summary_source_period_conflict'});
 raw.monthlySales=[{scope:{period:'2026-01'},netSales:90000},{scope:{period:'2026-02'},netSales:80000},{scope:{period:'2026-03'},netSales:110000}];writeFileSync(args.originals[0].path,JSON.stringify(raw));assert.equal((await run(args)).amounts.due,0);
 raw.monthlySales[2].scope.period='2026-04';writeFileSync(args.originals[0].path,JSON.stringify(raw));await assert.rejects(run(args),{code:'finance_summary_source_period_conflict'});
});
function derivedArgs(parent,resultPointer,value,accountSetId=1){const rest={periodType:'monthly',consumptionTaxBase:0,salesExcludingVat:110000,classification:'city',taxpayerCategory:'small'},args=make('surcharges',rest,{accountSetId});args.bindings=Object.keys(rest).map(k=>({inputPointer:`/${k}`,originalId:'original',locator:{jsonPointer:`/inputs/${k}`}}));args.inputs={...rest,vatBase:value};args.bindings.push({inputPointer:'/vatBase',artifactRef:parent.evidence.result.artifactRef,resultPointer,transform:'decimal'});return args;}
test('派生基数仅接本进程同账套本期强摘要产物，继承选中情景条件和原始来源',async()=>{
 const inputs=small(110000);delete inputs.reliefElection;const parent=await run(make('vat_small',inputs)),args=derivedArgs(parent,'/scenarios/1/amounts/due','1100.00'),r=await run(args),native=full(r);assert.equal(r.amounts.urbanMaintenance,38.5);assert(r.conditions.some(c=>c.code==='inherited_scenario_ordinary_relief_reduced'));assert(r.conditions.some(c=>c.code==='derived_summary_conditions_inherited'));assert(native.sourceRefs.some(s=>s.sourceType==='engine_derived'&&s.derivedFrom.length>0));
 await assert.rejects(run(derivedArgs(parent,'/scenarios/1/amounts/due','1100.00',2)),{code:'finance_summary_derived_scope_conflict'});
 const fake=derivedArgs(parent,'/scenarios/1/amounts/due','1100.00');fake.bindings.at(-1).artifactRef='finance-summary:fake/summary.json';await assert.rejects(run(fake),{code:'finance_summary_derived_reference_untrusted'});
 const bypass=make('vat_general',{outputVat:'1100.00',certifiedInputVat:0});bypass.originals[0].path=pathFor(parent);await assert.rejects(run(bypass),{code:'finance_summary_generated_result_not_original'});
});
test('派生结果篡改或其原始来源改变时拒绝；自动审计包含拒绝并且从未写账',async()=>{
 const args=make('vat_general',general()),parent=await run(args),path=pathFor(parent),saved=readFileSync(path);writeFileSync(path,Buffer.concat([saved,Buffer.from(' ')]));await assert.rejects(run(derivedArgs(parent,'/amounts/due','9600.00')),{code:'finance_summary_derived_digest_mismatch'});writeFileSync(path,saved);
 writeFileSync(args.originals[0].path,JSON.stringify({changed:true}));await assert.rejects(run(derivedArgs(parent,'/amounts/due','9600.00')),{code:'finance_summary_derived_source_changed'});
 assert.equal(sha(readFileSync(dbPath)),dbBefore);const ends=readdirSync(auditDir).filter(n=>n!=='artifacts').map(id=>JSON.parse(readFileSync(join(auditDir,id,'end.json'),'utf8')));assert(ends.some(e=>e.status==='failed'));assert(ends.every(e=>e.nativeOperationId===null));
});
test('原生货物销售额扣退货后可直接供附加派生引用，消费税缺件仅显式零条件',async()=>{
 const parent=await run(make('vat_general',{goodsSalesDocuments:[{lines:[{quantity:100,unitPrice:100}]}],goodsReturnDocuments:[{lines:[{quantity:10,unitPrice:100}]}],certifiedInputVat:100}));assert.equal(parent.amounts.salesExcludingVat,9000);assert.equal(parent.amounts.outputVat,1170);assert.equal(parent.amounts.due,1070);
 const args=make('surcharges',{periodType:'monthly',classification:'city',taxpayerCategory:'small'});args.inputs={...args.inputs,vatBase:'1070.00',salesExcludingVat:'9000.00'};args.bindings=args.bindings.slice(0,0).concat(['periodType','classification','taxpayerCategory'].map(key=>({inputPointer:`/${key}`,originalId:'original',locator:{jsonPointer:`/inputs/${key}`}})),['vatBase','salesExcludingVat'].map(key=>({inputPointer:`/${key}`,artifactRef:parent.evidence.result.artifactRef,resultPointer:key==='vatBase'?'/amounts/due':'/amounts/salesExcludingVat',transform:'decimal'})));
 const r=await run(args);assert.equal(r.amounts.urbanMaintenance,37.45);assert(r.conditions.some(c=>c.code==='consumptionTaxBase_zero_assumption'));assert(r.conditions.some(c=>c.code==='red_invoice_original_sale_unreviewed'));assert(!full(r).sourceRefs.some(s=>s.inputPointer==='/consumptionTaxBase'));
});
test('decimal双侧严格分值匹配兼容number/string，原件identity仍保持类型严格且保留实读类型',async()=>{
 for(const [observed,inputValue]of [[13.7,'13.70'],['13.70',13.7],['13.7','13.70']]){const args=make('vat_general',{outputVat:observed,certifiedInputVat:0});args.inputs={...args.inputs,outputVat:inputValue};args.bindings=[{inputPointer:'/outputVat',originalId:'original',locator:{jsonPointer:'/inputs/outputVat'},transform:'decimal'},{inputPointer:'/certifiedInputVat',originalId:'original',locator:{jsonPointer:'/inputs/certifiedInputVat'}}];const result=await run(args),source=full(result).sourceRefs.find(s=>s.inputPointer==='/outputVat');assert.equal(result.amounts.due,13.7);assert.equal(source.actualValue,observed);assert.equal(source.inputValue,inputValue);assert.equal(source.transform,'decimal');}
 for(const transform of [undefined,'identity']){const args=make('vat_general',{outputVat:13.7,certifiedInputVat:0});args.inputs={...args.inputs,outputVat:'13.70'};args.bindings=[{inputPointer:'/outputVat',originalId:'original',locator:{jsonPointer:'/inputs/outputVat'},...(transform?{transform}:{})},{inputPointer:'/certifiedInputVat',originalId:'original',locator:{jsonPointer:'/inputs/certifiedInputVat'}}];await assert.rejects(run(args),error=>error.code==='finance_summary_binding_value_mismatch'&&getFinanceSummarySafeDiagnostics(error).problems[0].inputPointer==='/outputVat');}
});
test('decimal拒绝两侧subcent、不安全number和不同分值，不把规范化变成舍入或金额更改',async()=>{
 for(const [observed,inputValue,code]of [[1.234,'1.23','finance_summary_binding_transform_invalid'],['1.23',1.234,'finance_summary_binding_transform_invalid'],[Number.MAX_SAFE_INTEGER+1,'1.23','finance_summary_binding_transform_invalid'],['1.23',Number.MAX_SAFE_INTEGER+1,'finance_summary_binding_transform_invalid'],['1.23',1.24,'finance_summary_binding_value_mismatch']]){const args=make('vat_general',{outputVat:observed,certifiedInputVat:0});args.inputs={...args.inputs,outputVat:inputValue};args.bindings=[{inputPointer:'/outputVat',originalId:'original',locator:{jsonPointer:'/inputs/outputVat'},transform:'decimal'},{inputPointer:'/certifiedInputVat',originalId:'original',locator:{jsonPointer:'/inputs/certifiedInputVat'}}];await assert.rejects(run(args),error=>{assert.equal(error.code,code);const detail=getFinanceSummarySafeDiagnostics(error);assert.equal(detail.problems[0].inputPointer,'/outputVat');assert.equal(detail.problems[0].reason,code==='finance_summary_binding_value_mismatch'?'exact_decimal_value_mismatch':'strict_decimal_required');return true;});}
});
test('可信派生金额默认接受数字投影并记录有效decimal，显式identity及非金额月份字段不自动转换',async()=>{
 const parent=await run(make('vat_general',general())),args=derivedArgs(parent,'/amounts/due',9600);delete args.bindings.at(-1).transform;const result=await run(args),source=full(result).sourceRefs.find(s=>s.inputPointer==='/vatBase');assert.equal(result.amounts.urbanMaintenance,336);assert.equal(source.actualValue,'9600.00');assert.equal(source.inputValue,9600);assert.equal(source.transform,'decimal');
 const identity=derivedArgs(parent,'/amounts/due',9600);identity.bindings.at(-1).transform='identity';await assert.rejects(run(identity),error=>error.code==='finance_summary_binding_value_mismatch'&&getFinanceSummarySafeDiagnostics(error).problems[0].inputPointer==='/vatBase');
 assert.equal(isFinanceSummaryAmountPointer('salary_pit_cumulative','/employmentMonths'),false);assert.equal(isFinanceSummaryAmountPointer('cit_prepayment','/quarterProfiles/0/averageEmployees'),false);assert.equal(isFinanceSummaryAmountPointer('cit_prepayment','/quarterProfiles/0/averageAssetsYuan'),true);assert.equal(isFinanceSummaryAmountPointer('vat_general','/goodsSalesDocuments/0/lines/0/unitPrice'),true);
 const three=await run(make('vat_general',{outputVat:3,certifiedInputVat:0})),months=make('salary_pit_cumulative',salary());months.bindings=Object.keys(months.inputs).filter(k=>k!=='monthsToPeriod').map(k=>({inputPointer:`/${k}`,originalId:'original',locator:{jsonPointer:`/inputs/${k}`}}));months.bindings.push({inputPointer:'/monthsToPeriod',artifactRef:three.evidence.result.artifactRef,resultPointer:'/amounts/due'});await assert.rejects(run(months),error=>error.code==='finance_summary_binding_value_mismatch'&&getFinanceSummarySafeDiagnostics(error).problems[0].inputPointer==='/monthsToPeriod');
});
test('缺合同金额绑定只指出已校验字段和有源金额数组修复提示，不默许模型合计',async()=>{
 const args=make('stamp_sale',{amountIncludingVat:113000,separatelyStatedVat:false});args.bindings=[{inputPointer:'/separatelyStatedVat',originalId:'original',locator:{jsonPointer:'/inputs/separatelyStatedVat'}}];await assert.rejects(run(args),error=>{assert.equal(error.code,'finance_summary_input_source_missing');const detail=getFinanceSummarySafeDiagnostics(error);assert.deepEqual(detail.problems,[{inputPointer:'/amountIncludingVat',reason:'source_binding_required',repairHint:'bind_source_value_or_source_amount_array'}]);const shown=JSON.stringify({code:error.code,message:error.message,details:error.details,safe:detail});for(const forbidden of ['113000','PRIVATE',args.originals[0].path,'jsonPointer','originalPath'])assert(!shown.includes(forbidden));return true;});
 const fixed=await run(make('stamp_sale',{amountIncludingVat:[90000,23000],separatelyStatedVat:false}));assert.equal(fixed.status,'conditional_calculated');assert.equal(fixed.amounts.taxableBase,113000);assert(full(fixed).steps.some(s=>s.id==='amountIncludingVat_sum'));
});
test('诊断只来自核心WeakMap，未知字段名/源路径不反射，缺件列表有界且返回副本',async()=>{
 const invented=Object.assign(Error('PRIVATE-ERROR'),{safeDiagnostics:{problems:[{inputPointer:'/PRIVATE-KEY'}]},details:{safeDiagnostics:{problems:[{inputPointer:'/PRIVATE-KEY'}]}}});assert.equal(getFinanceSummarySafeDiagnostics(invented),undefined);
 const invalid=make('vat_general',general());invalid.bindings[0].inputPointer='/PRIVATE-UNKNOWN-KEY';await assert.rejects(run(invalid),error=>{const detail=getFinanceSummarySafeDiagnostics(error);assert.equal(detail.problems[0].inputPointer,'/bindings/0/inputPointer');assert(!JSON.stringify(detail).includes('PRIVATE'));detail.problems[0].reason='PRIVATE-TAMPER';assert.equal(getFinanceSummarySafeDiagnostics(error).problems[0].reason,'input_pointer_not_in_contract');return true;});
 const source=make('vat_general',{outputVat:13,certifiedInputVat:0});source.bindings=[{inputPointer:'/outputVat',originalId:'original',locator:{jsonPointer:'/PRIVATE-SOURCE-KEY'}}];await assert.rejects(run(source),error=>{const detail=getFinanceSummarySafeDiagnostics(error);assert.equal(detail.problems[0].inputPointer,'/outputVat');assert.equal(detail.problems[0].reason,'source_pointer_missing');assert(!JSON.stringify(detail).includes('PRIVATE'));return true;});
 const many=make('vat_general',{outputVat:Array.from({length:25},()=>1),certifiedInputVat:0});many.bindings=[];await assert.rejects(run(many),error=>{const detail=getFinanceSummarySafeDiagnostics(error);assert.equal(detail.problems.length,20);assert.equal(detail.omittedCount,6);return true;});
 const unknown=make('vat_general',{outputVat:1,certifiedInputVat:0,'PRIVATE-UNKNOWN-KEY':'PRIVATE-UNKNOWN-VALUE'});await assert.rejects(run(unknown),error=>error.code==='finance_summary_input_invalid'&&getFinanceSummarySafeDiagnostics(error)===undefined);
});
