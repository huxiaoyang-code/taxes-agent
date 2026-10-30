import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {evaluateAgencyAccounting,replayAgencyFinancials} from '../server/agency-business-rules.mjs';
import {callDirectFinanceTool} from '../server/direct-finance.mjs';
import {withFinanceCall,readFinanceCall} from '../server/finance-call-chain.mjs';
import {DIRECT_RECORD,RECORD_EXAMPLES,validateDirectInput} from '../server/direct-finance-contracts.mjs';
import {DIRECT_TOOLS} from '../../05-reconstruction/codex/mcp/finance-mcp/direct-tools.mjs';
import {toolsForProfile} from '../../05-reconstruction/codex/mcp/finance-mcp/tool-profile.mjs';
import {resolveDirectFinanceTarget} from '../server/direct-finance-target.mjs';
import {currentFinanceCall} from '../server/finance-call-chain.mjs';
import {hash,stable} from '../server/offline-material-adapters.mjs';
const root=mkdtempSync(join(tmpdir(),'direct-finance-synthetic-'));
const scope={enterpriseKey:'SYNTHETIC-DIRECT',accountSetId:1,databaseInstanceId:'synthetic-db',period:'2026-03',currency:'CNY'};
const entity={kind:'company',industry:'trade',profileId:'small-2011-basic-v1',businessStartDate:'2026-03-01',vatStatus:'general',vatPeriod:'monthly',vatReliefWaived:false,incomeLevyMethod:'actual_accounts',bookkeepingMethod:'double_entry'};
const ref={kind:'source',locator:'synthetic-original.json#records',digest:'a'.repeat(64)};
function fixture(selected=true){
 const base=(id,type,date,data={})=>({...structuredClone(RECORD_EXAMPLES[type]??{}),id,type,date,enterpriseKey:scope.enterpriseKey,businessIdentity:{issuerKey:'PRIVATE-ISSUER-SENTINEL',documentNumber:id,event:type},originalRefs:[{originalId:'original',locator:`记录 ${id}`,extractionReason:'合成原件中该记录明确列示本业务字段'}],...(type==='purchase'?{certifiedDate:date}:{}),...data});
 return [base('E','entity','2026-03-01',{entity}),base('OPEN','opening_inventory','2026-02-28',{itemId:'PRIVATE-SKU-SENTINEL',inventoryType:'inventory',quantity:'1000',documentCost:'20000.00',stocktakeVerified:true,asOfPeriod:'2026-03'}),
 base('P01','purchase','2026-03-08',{itemId:'PRIVATE-SKU-SENTINEL',inventoryType:'inventory',quantity:'2000',net:'44000.00',invoiceTax:'5720.00',gross:'49720.00',inputVatTreatment:'deductible',settlement:'unpaid'}),
 base('S01','sale','2026-03-20',{taxJurisdiction:'domestic',specialVatTreatment:'ordinary',delivered:true,collectionRight:true,principal:true,settlement:'unpaid',invoiceKind:'special',lines:[{itemId:'PRIVATE-SKU-SENTINEL',quantity:'2500',unitPrice:'35.00',priceIncludesVat:false,vatCategory:'goods'}]}),
 base('P02','purchase','2026-03-25',{itemId:'PRIVATE-SKU-SENTINEL',inventoryType:'inventory',quantity:'1000',net:'24000.00',invoiceTax:'3120.00',gross:'27120.00',inputVatTreatment:'deductible',settlement:'unpaid'}),
 base('R01','sale_return','2026-03-26',{taxJurisdiction:'domestic',specialVatTreatment:'ordinary',originalSaleId:'S01',goodsReceived:true,originalInvoiceVerified:true,invoiceKind:'special',settlement:'receivable_reduction',lines:[{originalLine:0,quantity:'100',...(selected?{originalPurchaseId:'P01'}:{})}]}),
 base('S02','sale','2026-03-29',{taxJurisdiction:'domestic',specialVatTreatment:'ordinary',delivered:true,collectionRight:true,principal:true,settlement:'unpaid',invoiceKind:'unissued',lines:[{itemId:'PRIVATE-SKU-SENTINEL',quantity:'500',unitPrice:'36.00',priceIncludesVat:false,vatCategory:'goods'}]})];
}
const document=records=>({scope,entity,records:records.map(r=>({...r,sourceRefs:[ref]}))});
const returnCost=a=>a.vouchers.find(v=>v.sourceVoucherId.endsWith(':return_cost'))?.entries[0].debit??a.vouchers.find(v=>v.summary.startsWith('退货验收'))?.entries[0].debit;
test('原件指定采购批次恢复2200；未指定保留旧比例2120',()=>{
 const selected=evaluateAgencyAccounting(document(fixture(true))),legacy=evaluateAgencyAccounting(document(fixture(false)));
 assert.deepEqual(selected.issues,[]);assert.equal(returnCost(selected),'2200.00');assert.equal(selected.inventory[0].cost,'26200.00');
 assert.equal(returnCost(legacy),'2120.00');assert.equal(legacy.inventory[0].cost,'26120.00');
 assert.equal(selected.returnCostTrace[0].mode,'identified_purchase_lot');assert.equal(selected.returnCostTrace[0].allocations[0].originalPurchaseId,'P01');
});
test('拒绝不在原销售中的采购批次及批次超退，不猜当前采购价',()=>{
 for(const [field,value,code] of [['originalPurchaseId','P02','agency_return_purchase_not_in_original_sale'],['quantity','1600','agency_return_purchase_quantity_exceeded']]){
  const rows=fixture(true);rows.find(r=>r.type==='sale_return').lines[0][field]=value;
  assert(evaluateAgencyAccounting(document(rows)).issues.some(i=>i.code===code));
 }
});
test('重复指定批次累计恢复受限，同一原销售行不得混用成本依据',()=>{
 const rows=fixture(true),first=rows.find(r=>r.type==='sale_return'),again=structuredClone(first);again.id='R02';again.date='2026-03-27';again.businessIdentity.documentNumber='R02';again.lines[0].quantity='1450';rows.push(again);
 assert(evaluateAgencyAccounting(document(rows)).issues.some(i=>i.code==='agency_return_purchase_quantity_exceeded'));
 again.lines[0].quantity='50';delete again.lines[0].originalPurchaseId;
 assert(evaluateAgencyAccounting(document(rows)).issues.some(i=>i.code==='agency_return_cost_basis_conflict'));
});
test('坏第二行/非法结算/超应收拒绝整笔，库存VAT和后续有效退货不被污染',()=>{
 for(const kind of ['second_line','settlement','receivable']){
  const rows=fixture(true),r=rows.find(x=>x.type==='sale_return');
  if(kind==='second_line')r.lines.push({originalLine:99,quantity:'1',originalPurchaseId:'P01'});
  if(kind==='settlement')r.settlement='unknown';
  if(kind==='receivable')rows.push({...structuredClone(rows[0]),id:'C0',type:'collection',date:'2026-03-24',businessIdentity:{issuerKey:'SYNTHETIC-BANK',documentNumber:'C0',event:'collection'},relatedFactId:'S01',bankAccountId:'B',bankReference:'BANK-C0',amount:'98875.00'});
  const failed=evaluateAgencyAccounting(document(rows)),baseline=evaluateAgencyAccounting(document(rows.filter(x=>x.id!=='R01')));
  assert.deepEqual(failed.inventory,baseline.inventory,kind);assert.deepEqual(failed.vatTransactions,baseline.vatTransactions,kind);assert.deepEqual(failed.vouchers,baseline.vouchers,kind);assert.equal(failed.returnCostTrace.length,0,kind);
  const later={...structuredClone(r),id:'R-VALID',date:'2026-03-28',settlement:kind==='receivable'?'refunded':'receivable_reduction',businessIdentity:{issuerKey:'SYNTHETIC-ISSUER',documentNumber:'R-VALID',event:'sale_return'},lines:[{originalLine:0,quantity:'100',originalPurchaseId:'P01'}]};rows.push(later);
  const recovered=evaluateAgencyAccounting(document(rows));assert.equal(recovered.returnCostTrace.length,1);assert.equal(recovered.returnCostTrace[0].cost,'2200.00');
 }
});
test('direct默认只暴露真实可用直接业务，不带Harness或占位接口',()=>{
 const names=toolsForProfile().map(t=>t.name);for(const t of DIRECT_TOOLS)assert(names.includes(t.name));
 assert(names.includes('voucher_create'));assert(names.includes('finance_query'));assert(!names.some(n=>n.startsWith('harness_')));assert(!names.includes('invoice_issue'));assert(!names.includes('update_plan'));
 assert(toolsForProfile('harness').some(t=>t.name==='harness_run'));assert(toolsForProfile('legacy').some(t=>t.name==='harness_run'));
});
test('字段类型错误在计算前定位；不把金额字符串转为boolean',()=>{
 const contract={...fixture()[0],type:'contract',separatelyStatedVat:'13000.00'};
 assert.throws(()=>validateDirectInput(DIRECT_RECORD,contract),e=>e.code==='finance_input_invalid'&&e.details.problems.some(p=>p.inputPointer==='/separatelyStatedVat'));
 const expense={...fixture()[0],type:'expense',use:'taxable_sales_delivery',gross:'1090.00',net:'1000.00',invoiceTax:'90.00',inputVatTreatment:'deductible',settlement:'unpaid',benefitPeriod:'2026-03'};
 assert.throws(()=>validateDirectInput(DIRECT_RECORD,expense),e=>e.details.problems.some(p=>p.inputPointer==='/use'));
 assert.throws(()=>validateDirectInput(DIRECT_RECORD,{...fixture()[0],date:'2026-02-31'}));
});
test('所有真实类型可发现，工资/车辆/义务清单有字段指导，未知与未披露区分',async()=>{
 const inventory=await callDirectFinanceTool('finance_record_contract',{});assert(inventory.recordTypes.length>60);
 for(const type of ['payroll','vehicle_acquisition','obligation_inventory','contribution_notice','income_evidence']){const schema=DIRECT_TOOLS.find(t=>t.name==='finance_record_contract').inputSchema;validateDirectInput(schema,{recordType:type});const guide=await callDirectFinanceTool('finance_record_contract',{recordType:type});assert(Object.keys(guide.fields).length>0);assert.notEqual(guide.status,'unsupported');assert(guide.codeReferences.length>0);}
 const fallback=await callDirectFinanceTool('finance_record_contract',{recordType:'extraction'});assert.equal(fallback.contractCompleteness,'common_schema_and_rule_references_only');assert(fallback.rules.length>0);
 await assert.rejects(callDirectFinanceTool('finance_record_contract',{recordType:'invented_unknown'}),{code:'finance_record_type_unknown'});
});
function makeInput(records=fixture()){const path=join(root,`original-${readdirSync(root).length}.json`);writeFileSync(path,JSON.stringify({synthetic:true,records}));return {scope,originals:[{id:'original',path}],records};}
test('缺开业日期先返回结构化字段问题，原生月度/年度重放也不抛slice异常',async()=>{
 const rows=fixture();rows[0].entity={...entity};delete rows[0].entity.businessStartDate;
 const args=makeInput(rows),auditDir=join(root,'audit-missing-start-date');
 await assert.rejects(withFinanceCall({tool:'finance_tax_calculate',args,auditDir},()=>callDirectFinanceTool('finance_tax_calculate',args)),error=>error.code==='finance_input_invalid'&&error.details.problems.some(p=>p.inputPointer==='/records/0/entity/businessStartDate'&&p.field==='arguments/records/0/entity/businessStartDate'));
 assert(!readdirSync(join(auditDir,'artifacts')).some(id=>existsSync(join(auditDir,'artifacts',id,'workpaper.json'))));
 for(const annual of [false,true])assert.throws(()=>replayAgencyFinancials({...document(rows),entity:rows[0].entity},{annual}),{code:'agency_date_invalid'});
 for(const [field,value] of [['businessStartDate','2026-02-31'],['accountingReplayFrom','2026-13']])assert.throws(()=>validateDirectInput(DIRECT_RECORD,{...fixture()[0],entity:{...entity,[field]:value}}),error=>error.code==='finance_input_invalid'&&error.details.problems.some(p=>p.inputPointer===`/entity/${field}`));
 for(const businessStartDate of ['2019-06-15','2025-12-01']){const original={...fixture()[0],entity:{...entity,businessStartDate,accountingReplayFrom:'2026-03'}};validateDirectInput(DIRECT_RECORD,original);assert.deepEqual(evaluateAgencyAccounting({...document(fixture()),entity:original.entity}).issues,[]);}
 assert.equal(rows[0].entity.businessStartDate,undefined);
});
test('真实entity承接字段及tax_location分类合同可发现，三种所在地分类进入原生附加计算',async()=>{
 const entityGuide=await callDirectFinanceTool('finance_record_contract',{recordType:'entity'}),locationGuide=await callDirectFinanceTool('finance_record_contract',{recordType:'tax_location'});
 assert(entityGuide.fields['entity.businessStartDate']);assert(entityGuide.fields['entity.accountingReplayFrom']);assert(entityGuide.fields['entity.region']);assert(entityGuide.fields['entity.registrationNumber']);
 assert(locationGuide.fields.classification.includes('county_town'));assert(locationGuide.fields.localityKey);assert.equal(locationGuide.examples.tax_location.classification,'city');
 for(const [classification,due,rate] of [['city','35.70',700],['county_town','25.50',500],['other','5.10',100]]){
  const rows=fixture();rows[0].entity={...entity,vatStatus:'small'};
  const extra=(id,type,fields)=>({...structuredClone(RECORD_EXAMPLES[type]??{}),id,type,date:'2026-03-31',enterpriseKey:scope.enterpriseKey,originalRefs:[{originalId:'original',locator:`合成原件记录 ${id}`,extractionReason:'本回归的明确合成事实'}],...fields});
  rows.push(extra('COVER','period_coverage',{period:'2026-03',complete:true,accountsCovered:true,unbilledSalesCovered:true,bankCovered:true}),extra('ACTIVITIES','obligation_inventory',{activities:{consumption:{present:false,reason:'合成商贸事实明确无消费税业务'}}}),extra('LOCATION','tax_location',{classification}));
  const args=makeInput(rows),auditDir=join(root,`audit-location-${classification}`),result=await withFinanceCall({tool:'finance_tax_calculate',args,auditDir},()=>callDirectFinanceTool('finance_tax_calculate',{...args,obligationIds:['vat','urban_maintenance']}));
  const native=JSON.parse(readFileSync(join(auditDir,'artifacts',result.evidence.callRef,'workpaper.json'),'utf8')),urban=native.obligations.find(o=>o.obligationId==='urban_maintenance');
  assert.equal(native.obligations.find(o=>o.obligationId==='vat').due,'1020.00');assert.equal(urban.status,'calculated');assert.equal(urban.due,due);assert.equal(urban.calculations[0].rateBasisPoints,rate);
 }
});
test('同一原单据多明细不能仅改id绕过判重，用原始行身份区分event',()=>{
 const rows=fixture(),second=structuredClone(rows.find(r=>r.id==='P01'));second.id='P01-LINE-2';second.quantity='5';second.net='110.00';second.invoiceTax='14.30';second.gross='124.30';rows.push(second);
 assert(evaluateAgencyAccounting(document(rows)).issues.some(i=>i.code==='agency_original_business_duplicate'));
 second.businessIdentity.event='purchase:原始单据行2';assert.deepEqual(evaluateAgencyAccounting(document(rows)).issues,[]);
 assert.equal(second.businessIdentity.documentNumber,'P01');
});
test('直接底稿实际重放；自动保存人读账本/原件/规则，模型只得受限投影',async()=>{
 const args=makeInput(),auditDir=join(root,'audit');let callId;
 const result=await withFinanceCall({tool:'finance_workpaper',args,auditDir},()=>callDirectFinanceTool('finance_workpaper',args));
 assert.equal(result.ledgerAmounts.inventory,26200);assert.equal(result.ledgerAmounts.revenue,102000);assert.equal(result.ledgerAmounts.scopeMeaning,'replay_range_cumulative_not_single_month');
 assert.equal(result.ledgerAmounts.mainCost,61800);assert.equal(result.ledgerAmounts.receivable,115260);assert.equal(result.ledgerAmounts.payable,76840);
 assert.equal(result.vouchers.posted,false);assert.equal(result.review.submittable,false);
 assert(!JSON.stringify(result).includes('PRIVATE-SKU-SENTINEL'));assert(!JSON.stringify(result).includes('PRIVATE-ISSUER-SENTINEL'));assert(!JSON.stringify(result).includes(args.originals[0].path));
 callId=result.evidence.callRef;const artifact=join(auditDir,'artifacts',callId);
 const native=JSON.parse(readFileSync(join(artifact,'workpaper.json'),'utf8'));assert.equal(returnCost(native.accounting),'2200.00');
 const markdown=readFileSync(join(artifact,'review.md'),'utf8');assert(markdown.indexOf('## 账本金额')<markdown.indexOf('## 凭证与计算结果'));assert(markdown.indexOf('## 凭证与计算结果')<markdown.indexOf('## 规则依据'));assert(markdown.includes('PRIVATE-SKU-SENTINEL'));
 assert(existsSync(join(artifact,'evidence-index.json')));assert.equal(native.scope.enterpriseKey,scope.enterpriseKey);
 const record=await readFinanceCall({auditDir,callId});assert(record);
 writeFileSync(args.originals[0].path,JSON.stringify({synthetic:true,changed:true}));const changed=await readFinanceCall({auditDir,callId});assert(changed.changedSources.includes(args.originals[0].path));
});
test('target后台只读绑定真实两企业，不向模型披露企业键或名称，不覆盖冲突记录',async()=>{
 const dataDir=join(root,'target-db');process.env.WORKBENCH_DATA_DIR=dataDir;
 const accounting=await import('../server/accounting.mjs');
 const a=accounting.createAccountSet({name:'PRIVATE-CUSTOMER-A',start_period:'2026-03',enterprise:{enterpriseKey:'PRIVATE-ENTERPRISE-A'},profileId:entity.profileId});
 const b=accounting.createAccountSet({name:'PRIVATE-CUSTOMER-B',start_period:'2026-03',enterprise:{enterpriseKey:'PRIVATE-ENTERPRISE-B'},profileId:entity.profileId});
 const dbPath=join(dataDir,'workbench.db'),previous=process.env.FINANCE_DATABASE_PATH;process.env.FINANCE_DATABASE_PATH=dbPath;
 try{for(const set of [a,b]){const rows=fixture().map(({enterpriseKey,...record})=>record),base=makeInput(rows),args={target:{accountSetId:set.id,period:'2026-03'},originals:base.originals,records:rows};validateDirectInput(DIRECT_TOOLS.find(t=>t.name==='finance_workpaper').inputSchema,args);
  const auditDir=join(root,`target-audit-${set.id}`),result=await withFinanceCall({tool:'finance_workpaper',args,auditDir},()=>callDirectFinanceTool('finance_workpaper',args));assert.equal(result.ledgerAmounts.inventory,26200);assert(!JSON.stringify(result).includes('PRIVATE-ENTERPRISE'));assert(!JSON.stringify(result).includes('PRIVATE-CUSTOMER'));
  const native=JSON.parse(readFileSync(join(auditDir,'artifacts',result.evidence.callRef,'workpaper.json'),'utf8'));assert.equal(native.scope.accountSetId,set.id);assert.equal(native.scope.enterpriseKey,set.id===a.id?'PRIVATE-ENTERPRISE-A':'PRIVATE-ENTERPRISE-B');}
  const bad=makeInput();await assert.rejects(withFinanceCall({tool:'finance_workpaper',args:bad,auditDir:join(root,'bad-target')},()=>callDirectFinanceTool('finance_workpaper',{target:{accountSetId:b.id,period:'2026-03'},originals:bad.originals,records:bad.records})),{code:'finance_record_scope_conflict'});
  assert.throws(()=>resolveDirectFinanceTarget({accountSetId:99999,period:'2026-03'}),{code:'finance_target_account_set_missing'});
  const schema=DIRECT_TOOLS.find(t=>t.name==='finance_workpaper').inputSchema;assert.throws(()=>validateDirectInput(schema,{target:{accountSetId:a.id,period:'2026-03'},...bad}));
 }finally{if(previous===undefined)delete process.env.FINANCE_DATABASE_PATH;else process.env.FINANCE_DATABASE_PATH=previous;}
});
test('固定profile角色用于企业准则成本，不以小企业科目号硬编码',async()=>{
 const rows=fixture();rows[0].entity={...entity,profileId:'enterprise-2019-general-basic-v1'};
 const args=makeInput(rows),result=await withFinanceCall({tool:'finance_workpaper',args,auditDir:join(root,'audit-enterprise')},()=>callDirectFinanceTool('finance_workpaper',args));
 assert.equal(result.ledgerAmounts.mainCost,61800);assert.equal(result.ledgerAmounts.receivable,115260);assert.equal(result.ledgerAmounts.payable,76840);
});
test('原件月份不足不猜认证日，VAT未知且空库存不当作0',async()=>{
 const args=makeInput([fixture()[0]]),auditDir=join(root,'audit-empty');
 const result=await withFinanceCall({tool:'finance_tax_calculate',args,auditDir},()=>callDirectFinanceTool('finance_tax_calculate',{...args,obligationIds:['vat']}));
 assert.equal(result.ledgerAmounts.inventory,null);assert.equal(result.ledgerAmounts.outputVat,null);const vat=result.calculationResults.taxes[0];assert.equal(vat.status,'missing');assert(!Object.hasOwn(vat,'due'));
});
test('按合同示例构造的真实商贸/费用/合同/核销记录可进入原生计算',async()=>{
 const rows=fixture();let n=0;
 for(const type of ['expense','contract','collection','supplier_payment']){
  const example=structuredClone(RECORD_EXAMPLES[type]);example.id=`EX${++n}`;example.enterpriseKey=scope.enterpriseKey;example.date='2026-03-30';example.businessIdentity={issuerKey:'SYNTHETIC-ISSUER',documentNumber:example.id,event:type};example.originalRefs=rows[0].originalRefs;
  if(type==='expense')example.certifiedDate='2026-03-30';
  if(type==='collection'){example.relatedFactId='S01';example.bankAccountId='SYNTHETIC-BANK';example.bankReference='COLLECT-1';}
  if(type==='supplier_payment'){example.relatedFactId='P01';example.bankAccountId='SYNTHETIC-BANK';example.bankReference='PAY-1';}
  validateDirectInput(DIRECT_RECORD,example);rows.push(example);
 }
 const args=makeInput(rows),result=await withFinanceCall({tool:'finance_workpaper',args,auditDir:join(root,'audit-examples')},()=>callDirectFinanceTool('finance_workpaper',args));
 assert(!result.review.issues.some(i=>['agency_business_fact_uncovered','agency_expense_facts_missing','agency_cash_source_missing','stamp_contract_missing'].includes(i.code)));assert.equal(result.vouchers.count,11);
 assert.equal(result.ledgerAmounts.mainCost,61800);assert.equal(result.ledgerAmounts.salesExpense,1000);assert.equal(result.ledgerAmounts.receivable,114260);assert.equal(result.ledgerAmounts.payable,76930);assert.equal(result.ledgerAmounts.bank,0);
});
test('进项转出真实非零重放，原采购/费用不得直接冒用transfer_out',async()=>{
 const rows=fixture(),base=rows[0],transfer={...structuredClone(RECORD_EXAMPLES.input_vat_adjustment),id:'TRANSFER-1',date:'2026-03-30',enterpriseKey:scope.enterpriseKey,businessIdentity:{issuerKey:'SYNTHETIC-ISSUER',documentNumber:'TRANSFER-1',event:'input_vat_adjustment'},originalRefs:base.originalRefs,originalInvoiceId:'P01',transferReason:'合成原件明确列示用途变化',destination:'admin',invoiceTax:'130.00'};
 validateDirectInput(DIRECT_RECORD,transfer);
 for(const type of ['purchase','expense']){const record=type==='purchase'?structuredClone(rows.find(r=>r.type==='purchase')):{...base,type:'expense',use:'admin',gross:'1130.00',net:'1000.00',invoiceTax:'130.00',settlement:'unpaid',benefitPeriod:'2026-03'};record.inputVatTreatment='transfer_out';assert.throws(()=>validateDirectInput(DIRECT_RECORD,record),error=>error.code==='finance_input_invalid'&&error.details.problems.some(p=>p.inputPointer==='/inputVatTreatment'));}
 const missing={...transfer};delete missing.originalInvoiceId;assert.throws(()=>validateDirectInput(DIRECT_RECORD,missing));
 rows.push({...base,id:'COVER-TRANSFER',type:'period_coverage',date:'2026-03-31',period:'2026-03',complete:true,accountsCovered:true,unbilledSalesCovered:true,bankCovered:true},{...base,id:'OPEN-VAT',type:'opening_vat',date:'2026-03-01',asOfPeriod:'2026-03',declarationVerified:true,amount:'0.00'},transfer);
 const args=makeInput(rows),auditDir=join(root,'audit-transfer'),result=await withFinanceCall({tool:'finance_tax_calculate',args,auditDir},()=>callDirectFinanceTool('finance_tax_calculate',{...args,obligationIds:['vat']}));
 const vat=result.calculationResults.taxes[0];assert.equal(vat.due,4550);
 const native=JSON.parse(readFileSync(join(auditDir,'artifacts',result.evidence.callRef,'workpaper.json'),'utf8')),originalVat=native.obligations.find(o=>o.obligationId==='vat');assert.equal(originalVat.replay.at(-1).certifiedInput,'8840.00');assert.equal(originalVat.replay.at(-1).transferOut,'130.00');assert.equal(originalVat.replay.at(-1).due,'4550.00');
 const journal=native.accounting.vouchers.find(v=>v.factId==='TRANSFER-1');assert(journal);assert.equal(journal.entries[0].debit,'130.00');assert.equal(journal.entries[1].credit,'130.00');
 const report=readFileSync(join(auditDir,'artifacts',result.evidence.callRef,'review.md'),'utf8');assert(report.includes('"transferOut": "130.00"'));
});
test('年末成立企业真实非零年度重放，含年度调整/承接/规则/聚合证据',async()=>{
 const decemberScope={...scope,period:'2026-12'},rows=fixture().filter(r=>['entity','purchase','sale'].includes(r.type)&&r.id!=='P02'&&r.id!=='S02');
 rows[0].entity={...entity,businessStartDate:'2026-12-01'};
 for(const r of rows){r.date=r.date.replace('2026-03','2026-12');if(r.certifiedDate)r.certifiedDate=r.certifiedDate.replace('2026-03','2026-12');if(r.type==='purchase'){r.quantity='10';r.net='100.00';r.invoiceTax='13.00';r.gross='113.00';}if(r.type==='sale'){r.lines[0].quantity='4';r.lines[0].unitPrice='20.00';}}
 rows.push({...structuredClone(rows[0]),id:'COVER',type:'period_coverage',date:'2026-12-31',period:'2026-12',complete:true,accountsCovered:true,unbilledSalesCovered:true,bankCovered:true});
 const dir=join(root,'annual-input');await import('node:fs/promises').then(fs=>fs.mkdir(dir));
 const original=join(dir,'original.json'),raw=join(dir,'raw.json'),manifest=join(dir,'manifest.json');
 writeFileSync(original,JSON.stringify({synthetic:true,records:rows}));writeFileSync(raw,JSON.stringify({version:'agency-raw-facts/1',scope:decemberScope,records:rows}));writeFileSync(manifest,JSON.stringify({version:'agency-business-materials/1',scope:decemberScope,originals:[{id:'original',path:original}],sources:[{path:raw}]}));
 const args={manifestPaths:[manifest]},auditDir=join(root,'audit-annual'),result=await withFinanceCall({tool:'finance_annual_workpaper',args,auditDir},()=>callDirectFinanceTool('finance_annual_workpaper',args));
 assert.equal(result.period,'2026');assert.equal(result.ledgerAmounts.inventory,60);assert.equal(result.ledgerAmounts.revenue,80);assert.equal(result.ledgerAmounts.mainCost,40);assert.equal(result.annualCalculation.nextYearCarryPresent,true);assert(result.rules.trace.length>0);
 const artifact=join(auditDir,'artifacts',result.evidence.callRef);assert(existsSync(join(artifact,'evidence-index.json')));
 const markdown=readFileSync(join(artifact,'review.md'),'utf8');assert(markdown.includes('年度调整与次年承接'));assert(markdown.includes('https://'));assert(markdown.includes('nextYearCarryState'));
 const native=JSON.parse(readFileSync(join(artifact,'workpaper.json'),'utf8')),digest=native.contentDigest;delete native.contentDigest;assert.equal(hash(stable(native)),digest);assert(!Object.hasOwn(native,'ruleSelection'));assert(existsSync(join(artifact,'adapter-result.json')));assert.match(result.rules.codeDigest,/^[a-f0-9]{64}$/);
});
test('年度凭证覆盖11月与12月，不只展示年末月',async()=>{
 const annualEntity={...entity,businessStartDate:'2026-11-01'},dir=join(root,'annual-two-month');await import('node:fs/promises').then(fs=>fs.mkdir(dir));const manifests=[];
 const e={...fixture()[0],id:'E-ANNUAL',date:'2026-11-01',entity:annualEntity,originalRefs:[{originalId:'original',locator:'/records/0',extractionReason:'合成原始登记记录'}]},all=[e];
 for(const month of ['11','12'])all.push({...fixture()[0],id:`EXP-${month}`,type:'expense',date:`2026-${month}-10`,businessIdentity:{issuerKey:'SYNTHETIC',documentNumber:`EXP-${month}`,event:'expense'},originalRefs:[{originalId:'original',locator:`/records/${all.length}`,extractionReason:'合成原始费用记录'}],use:'admin',gross:'100.00',net:'100.00',invoiceTax:'0.00',inputVatTreatment:'non_deductible',settlement:'unpaid',benefitPeriod:`2026-${month}`});
 const original=join(dir,'original.json'),entityRaw=join(dir,'entity.json');writeFileSync(original,JSON.stringify({synthetic:true,records:all}));writeFileSync(entityRaw,JSON.stringify({version:'agency-raw-facts/1',scope:{...scope,period:'2026-11'},records:[e]}));
 for(const [i,month] of ['11','12'].entries()){const s={...scope,period:`2026-${month}`},raw=join(dir,`raw-${month}.json`),manifest=join(dir,`manifest-${month}.json`);writeFileSync(raw,JSON.stringify({version:'agency-raw-facts/1',scope:s,records:[all[i+1]]}));writeFileSync(manifest,JSON.stringify({version:'agency-business-materials/1',scope:s,originals:[{id:'original',path:original}],sources:[{path:entityRaw},{path:raw}]}));manifests.push(manifest);}
 const args={manifestPaths:manifests},auditDir=join(root,'annual-two-audit'),result=await withFinanceCall({tool:'finance_annual_workpaper',args,auditDir},()=>callDirectFinanceTool('finance_annual_workpaper',args));assert.equal(result.vouchers.count,2);assert.equal(result.ledgerAmounts.profitBeforeTax,-200);const report=readFileSync(join(auditDir,'artifacts',result.evidence.callRef,'review.md'),'utf8');assert(report.includes('EXP-11'));assert(report.includes('EXP-12'));
});
test('HTTP真实返回身份只本机记录，存在原生ID也不冒充成功',async()=>{
 const previous=globalThis.fetch;let sent;
 globalThis.fetch=async(_url,options)=>{sent=options;return new Response('{}',{status:200,headers:{'X-Workbench-Operation-Id':'actual-native-operation'}});};
 const {callBackend}=await import('../../05-reconstruction/codex/mcp/finance-mcp/backend.mjs'),auditDir=join(root,'http-identity');let callId;
 try{await assert.rejects(withFinanceCall({tool:'voucher_create',args:{operationId:'original-request-id'},auditDir},()=>{callId=currentFinanceCall().callId;return callBackend('voucher_create',{operationId:'original-request-id'},{});}));assert.equal(sent.headers['X-Workbench-Operation-Id'],'original-request-id');const record=await readFinanceCall({auditDir,callId});assert.equal(record.end.nativeOperationId,'actual-native-operation');assert.equal(record.status,'failed');assert.equal(record.end.executionCompleted,false);}finally{globalThis.fetch=previous;}
});
test('规则分页合同与原生50上限一致，金额超界保留原生拒绝',async()=>{
 const schema=DIRECT_TOOLS.find(t=>t.name==='finance_rules').inputSchema;assert.throws(()=>validateDirectInput(schema,{filters:{limit:51}}));validateDirectInput(schema,{filters:{limit:50}});
 const rows=fixture();rows.find(r=>r.id==='S01').lines[0].unitPrice='1000000000.00';
 const args=makeInput(rows),result=await withFinanceCall({tool:'finance_workpaper',args,auditDir:join(root,'audit-bounds')},()=>callDirectFinanceTool('finance_workpaper',args));
 assert.equal(result.ledgerAmounts.revenue,18000);assert(result.review.issues.some(i=>i.code==='agency_amount_invalid'));assert.equal(result.modelBoundary.numberLimit,1e12);assert.equal(result.review.submittable,false);
});
test('实际MCP默认直接连接，工具校验拒绝也自动留下调用记录',()=>{
 const auditDir=join(root,'mcp-audit'),server=resolve(import.meta.dirname,'../../05-reconstruction/codex/mcp/finance-mcp/server.mjs');
 const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'finance_record_contract',arguments:{recordType:'purchase'}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'finance_workpaper',arguments:{scope}}}];
 const run=spawnSync(process.execPath,[server],{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8',env:{...process.env,FINANCE_AUDIT_DIR:auditDir,FINANCE_MCP_PROFILE:'direct'},timeout:30000});
 assert.equal(run.status,0,run.stderr);const responses=run.stdout.trim().split('\n').map(line=>JSON.parse(line));
 assert(!responses.find(r=>r.id===1).result.tools.some(t=>t.name.startsWith('harness_')));
 assert(responses.find(r=>r.id===2).result._meta.financeCall.callId);assert.equal(responses.find(r=>r.id===3).result.isError,true);
 assert.equal(readdirSync(auditDir).filter(name=>/^\d{8}T/.test(name)).length,2);
});
