// 实际 stdio 工具，合成账套、原始表头/行及预算；全程不接模型或税局。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import ExcelJS from 'exceljs';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=(file,doc)=>writeFileSync(file,JSON.stringify(doc));
const key=key=>({key});
const ptr=jsonPointer=>({jsonPointer});
const assumption=(assume,reason)=>({assume,reason});
const columns=names=>Object.fromEntries(names.map((k,i)=>[k,{column:i+1}]));
const fields=names=>Object.fromEntries(names.map(k=>[k,key(k)]));
const owner='合成甲公司';
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'vat-plan-synthetic-')),audit=join(root,'audit'),materials=join(audit,'agent-materials');
 mkdirSync(materials,{recursive:true});
 const dbPath=join(root,'temporary.sqlite'),db=new DatabaseSync(dbPath);
 db.exec("CREATE TABLE audit_database_instances(instance_id,is_active); CREATE TABLE account_sets(id,taxpayer_type); CREATE TABLE import_enterprise_account_sets(account_set_id,enterprise_key,enterprise_name); CREATE TABLE import_source_bindings(enterprise_key,enterprise_name); INSERT INTO audit_database_instances VALUES('test-instance',1); INSERT INTO account_sets VALUES(1,'一般纳税人')");
 db.prepare('INSERT INTO import_enterprise_account_sets VALUES(?,?,?)').run(1,'synthetic-a',owner);db.close();
 const target={accountSetId:1,period:'2026-11'},inputPath=join(materials,'intake.json');
 const args={target,inputPath,asOf:'2026-12-05',through:'2027-01'};
 const xlsx=join(root,'进项收件.xlsx'),wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet('收件明细');
 sheet.addRows([[owner],['本方票号','销方标识','税额','收件月','用途资格'],['000001','PRIVATE-SUPPLIER',90,'2026-11','可抵扣'],
  ['000002','PRIVATE-SUPPLIER',20,'2026-09','可抵扣'],['000003','PRIVATE-SUPPLIER',10,'2026-10','可抵扣']]);
 await wb.xlsx.writeFile(xlsx);
 const doc={owner,known:'2026-11-30',closing:'2026-10',credit:5,budget:100,
  extra:[{issuer:'PRIVATE-SUPPLIER',invoiceNumber:'000001',taxAmount:'90.00',receipt:'2026-11',eligibility:'eligible'},
   {issuer:'PRIVATE-SUPPLIER',invoiceNumber:'PRIVATE-FUTURE',taxAmount:444,receipt:'2026-12-06',eligibility:'eligible'}],
  old:[{issuer:'PRIVATE-SUPPLIER',invoiceNumber:'000002',knownAt:'2026-10-12',taxPeriod:'2026-09'}],
  months:[{period:'2026-11',knownAt:'2026-12-01',basis:'actual',outputVat:50},
   {period:'2026-12',knownAt:'2026-11-30',basis:'forecast',outputVat:100},
   {period:'2026-12',knownAt:'2027-01-04',basis:'actual',outputVat:98765}]};
 const portalPath=join(root,'确认结果.xlsx'),portal=new ExcelJS.Workbook(),ps=portal.addWorksheet('抵扣清单');
 ps.addRows([[owner,202611],['票号','销方','开票日期','操作日期','状态'],
  ['000003','PRIVATE-SUPPLIER',new Date('2026-10-02T00:00:00Z'),'2026-12-04 19:32:36','已勾选'],
  ['000001','PRIVATE-SUPPLIER','2026-11-03','','未勾选'],['合计','','','','汇总']]);
 ps.getCell('C3').numFmt='yyyy-mm-dd';await portal.xlsx.writeFile(portalPath);
 const data=join(root,'月报及预算.json');
 const zero=assumption(0,'所给普通境内预算按无此项推演'),scope=assumption('monthly_general_domestic','本账套经营及税种口径');
 const shared={state:assumption('open','待报场景'),otherEffects:assumption('none','普通境内情景'),inputVatTransferOut:zero,prepaidVat:zero};
 const original=(path,ownerField,owner,tables)=>({path,sha256:sha(readFileSync(path)),ownerField,owner,tables});
 const tables=[
  {kind:'opening',fields:{knownAt:ptr('/known'),period:ptr('/closing'),carryCredit:ptr('/credit'),scope,inventoryCoverage:assumption('complete','按已收的上期留抵与未用、已用清单范围')}},
  {kind:'invoice',rowsPointer:'/extra',fields:fields(['issuer','invoiceNumber','taxAmount','receipt','eligibility'])},
  {kind:'confirmation',rowsPointer:'/old',fields:fields(['issuer','invoiceNumber','knownAt','taxPeriod'])},
  {kind:'month',rowsPointer:'/months',fields:{...fields(['period','knownAt','basis','outputVat']),...shared}},
  {kind:'month',fields:{knownAt:ptr('/known'),period:assumption('2027-01','下期同合同额'),basis:assumption('forecast','已知预算延续'),outputVat:ptr('/budget'),...shared}},
 ];
 function refresh(){
  write(data,doc);
  const sources=[
   original(xlsx,'name',{row:1,column:1},[{kind:'invoice',firstRow:3,fields:columns(['invoiceNumber','issuer','taxAmount','receipt','eligibility']),translations:{eligibility:[{from:'可抵扣',to:'eligible'}]}}]),
   original(portalPath,'name',{row:1,column:1},[{kind:'confirmation',firstRow:3,statusFilter:{location:{column:5},include:['已勾选'],exclude:['未勾选','汇总']},fields:{invoiceNumber:{column:1},issuer:{column:2},issueDate:{column:3},knownAt:{column:4},operationDate:{column:4},taxPeriod:{row:1,column:2}}}]),
   original(data,'name',ptr('/owner'),tables),
  ];
  write(inputPath,{version:'finance-vat-planning-materials/1',sources});
 }
 refresh();
 const server=fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs',import.meta.url));
 const client=new McpStdioClient(server,{cwd:root,env:{FINANCE_MCP_PROFILE:'direct',FINANCE_SOURCE_ROOT:root,FINANCE_AUDIT_DIR:audit,FINANCE_DATABASE_PATH:dbPath,FINANCE_API_BASE:'http://127.0.0.1:1'}}).start();
 await client.initialize();
 const call=extras=>client.call('finance_vat_plan',{...args,...extras});
 const ok=async extras=>{const reply=await call(extras);assert.equal(reply.isError,false,reply.text);return reply.data;};
 return {client,call,ok,doc,tables,refresh,inputPath,dbPath,audit};
}

test('正常 MCP 按原件生成候选；只换勾选期、改变预测及无关事实，分辨付款、留抵、跨年余票',async()=>{
 const f=await fixture(),before=sha(readFileSync(f.dbPath));
 try{
  const specs=(await f.client.rpc('tools/list')).result.tools;
  assert.equal(specs.find(t=>t.name==='finance_vat_plan').annotations.readOnlyHint,true);
  const contract=await f.client.call('finance_record_contract',{recordType:'vat_planning'});assert.equal(contract.data.inputSchema.properties.version.const,'finance-vat-planning-materials/1');
  const visible=await f.ok({});
  const evidence=JSON.parse(readFileSync(join(f.audit,visible.callRef,visible.localEvidence)));assert(evidence.mappings.some(m=>m.mapping.fields.taxPeriod?.row===1));
  assert(!JSON.stringify(evidence.facts).includes('PRIVATE-FUTURE'));
  assert.equal(visible.status,'conditional_calculated',JSON.stringify(visible.gaps));
  assert.equal(visible.invoices.length,3);
  const movable=visible.invoices.find(r=>r.taxAmount==='90.00'),fixed=visible.invoices.find(r=>r.taxAmount==='10.00');
  assert.equal(movable.sources.length,2);assert.equal(movable.issueDate,undefined);assert.equal(movable.firstPeriod,'2026-11');
  assert.equal(fixed.fixedPeriod,'2026-11');assert.equal(fixed.operationDate,'2026-12-04 19:32:36');assert.equal(fixed.issueDate,'2026-10-02');
  assert(visible.plan.months[2].sources.some(s=>s.assumptions.includes('basis')));
  assert(!/PRIVATE|98765|444\.00/.test(JSON.stringify(visible)));
  const choice=period=>[{invoiceRef:movable.invoiceRef,period}];
  const both={baseline:choice('2026-12'),plan:choice('2026-11'),expectedBasis:visible.basis};
  const first=await f.ok(both);
  assert.deepEqual(first.baseline.months.map(r=>r.due),['35.00','10.00','100.00']);
  assert.deepEqual(first.plan.months.map(r=>r.due),['0.00','45.00','100.00']);
  assert.deepEqual(first.delta.byPaymentMonth.map(r=>r.afterVatCash),['35.00','-35.00','0.00']);
  assert.equal(first.delta.yearEndAfterVatCash,'35.00');assert.equal(first.delta.yearAttributedVat,'0.00');assert.equal(first.delta.horizonDue,'0.00');
  assert.match((await f.call({plan:[{invoiceRef:fixed.invoiceRef,period:'2026-12'}]})).text,/already_fixed/);
  const preOperation=await f.ok({asOf:'2026-12-03'});assert.equal(preOperation.invoices.find(i=>i.taxAmount==='10.00').fixedPeriod,null);
  const earlier=await f.ok({asOf:'2026-11-22'});assert(!earlier.invoices.some(i=>i.taxAmount==='90.00'));
  f.doc.telephone='PRIVATE-UNRELATED';f.refresh();
  const untouched=await f.ok(both);assert.deepEqual(untouched.delta,first.delta);assert.equal(untouched.basis,first.basis);
  f.doc.months[1].outputVat=10;f.refresh();
  assert.match((await f.call(both)).text,/basis_changed/);
  const year=await f.ok({baseline:choice('2027-01'),plan:choice('2026-11')});
  assert.equal(year.plan.yearEnd.carryCredit,'45.00');assert.equal(year.plan.yearEnd.unusedVat,'0.00');assert.equal(year.baseline.yearEnd.unusedVat,'90.00');
  assert.equal(year.plan.nextYear.due,'55.00');assert.equal(year.baseline.nextYear.due,'10.00');assert.equal(year.delta.horizonDue,'0.00');
  f.doc.extra[0].taxAmount=91;f.refresh();const conflict=await f.ok({});assert.equal(conflict.status,'partial_known_invoices');assert(conflict.gaps.some(g=>g.code==='source_conflict'));assert.equal(conflict.delta,undefined);
  assert.equal(conflict.knownSubset.baseline.months[0].due,'35.00');
  f.doc.extra[0].taxAmount=90;
  f.doc.extra.push({issuer:'PRIVATE-SUPPLIER',invoiceNumber:'000004',receipt:'2026-10',eligibility:'unknown',taxAmount:15});f.refresh();
  const uncertain=await f.ok({baseline:choice('2027-01'),plan:choice('2026-11')});assert.equal(uncertain.status,'partial_known_invoices');assert.deepEqual(uncertain.knownSubset.delta,year.delta);f.doc.extra.pop();
  f.doc.extra[0].taxAmount=90;delete f.doc.budget;f.tables.pop();f.refresh();
  const partial=await f.ok({});assert.equal(partial.invoices.length,3);assert(partial.gaps.some(g=>g.period==='2027-01'));assert.equal(partial.plan,undefined);assert.equal(partial.knownSubset.plan.horizon.through,'2026-12');
  assert.equal(sha(readFileSync(f.dbPath)),before);
 }finally{await f.client.close();}
});

test('期初范围与余额必须具备；年末只盘点当时余票，次年缺口保留年末和下一期净耗留抵',async()=>{
 const f=await fixture();
 try{
  f.doc.scope='other-tax-method';f.tables[0].fields.scope=ptr('/scope');f.refresh();
  const wrong=await f.ok({});assert.equal(wrong.status,'needs_inputs');assert.equal(wrong.invoices.length,3);assert.equal(wrong.knownSubset,undefined);
  f.doc.scope='monthly_general_domestic';delete f.tables[0].fields.carryCredit;f.refresh();
  const missing=await f.ok({});assert.equal(missing.status,'needs_inputs');assert.equal(missing.delta,undefined);assert.equal(missing.knownSubset,undefined);
  f.tables[0].fields.carryCredit=ptr('/credit');
  f.doc.extra.push({invoiceNumber:'F-JAN',issuer:'PRIVATE-SUPPLIER',receipt:'2027-01-03',eligibility:'eligible',taxAmount:600});
  f.doc.months.pop();f.doc.extra=f.doc.extra.filter(r=>r.invoiceNumber!=='PRIVATE-FUTURE');f.refresh();
  const snapshot=await f.ok({asOf:'2027-01-07'});assert.equal(snapshot.plan.yearEnd.unusedVat,'90.00');assert.equal(snapshot.plan.horizon.unusedVat,'690.00');
  f.doc.advance=999;f.tables.at(-1).fields.prepaidVat=ptr('/advance');f.refresh();
  const cutoff=await f.ok({});assert.equal(cutoff.status,'partial_known_invoices');assert.equal(cutoff.knownSubset.plan.yearEnd.period,'2026-12');
  f.tables.at(-1).fields.prepaidVat=assumption(0,'本场景无预缴');f.tables.at(-1).fields.inputVatTransferOut=ptr('/transfer');
  f.doc.transfer=5;f.doc.budget=5;f.doc.months[1].outputVat=38;
  f.doc.extra.push({invoiceNumber:'B-JAN',issuer:'PRIVATE-SUPPLIER',receipt:'2026-11',eligibility:'eligible',taxAmount:7});f.refresh();
  const book=(await f.ok({})).invoices,select=(amount,period)=>({invoiceRef:book.find(r=>r.taxAmount===amount).invoiceRef,period});
  const used=await f.ok({baseline:[select('7.00','2027-01')],plan:[select('90.00','2026-11'),select('7.00','2027-01')]});
  assert.equal(used.plan.yearEnd.carryCredit,'17.00');assert.equal(used.plan.horizon.carryCredit,'14.00');assert.equal(used.plan.nextYearUse.firstNetOutputUsingCarry,'2027-01');
 }finally{await f.client.close();}
});

test('只有次年确认清单的票锁定所属期，早开票或缺开票日不证明年末已持有',async()=>{
 const f=await fixture();
 try{
  f.doc.months.pop();f.doc.extra.pop();
  f.tables[2].fields.taxAmount=key('amount');f.tables[2].fields.issueDate=key('issued');
  const confirmed={issuer:'PRIVATE-SUPPLIER',knownAt:'2027-01-08',taxPeriod:'2027-01',amount:600};
  f.doc.old.push({...confirmed,invoiceNumber:'NEXT'}, {...confirmed,invoiceNumber:'NEXT-DEC',issued:'2026-12-01',amount:50});
  f.refresh();const r=await f.ok({asOf:'2027-01-08'});assert.equal(r.status,'conditional_calculated');
  assert.equal(r.plan.yearEnd.unusedVat,'90.00');assert.equal(r.plan.yearEnd.unusedCount,1);assert.equal(r.plan.yearEnd.holdingUnknownCount,2);assert.equal(r.plan.yearEnd.holdingUnknownVat,'650.00');
  assert.equal(r.plan.nextYear.selectedAndFixedInput,'650.00');assert.equal(r.plan.horizon.holdingUnknownVat,'0.00');
 }finally{await f.client.close();}
});

test('已申报月拒绝改选，缺口和不支持金额不默认为零，隔离过期、变动、跨企业来源',async()=>{
 const f=await fixture();
 try{
  f.doc.filed='2026-11-01';f.tables.push({kind:'filing',fields:{period:ptr('/filed'),knownAt:ptr('/known')}});f.refresh();
  const result=await f.ok({});const movable=result.invoices.find(i=>!i.fixedPeriod);
  assert.equal(result.baseline.months[0].state,'filed');
  assert.match((await f.call({plan:[{invoiceRef:movable.invoiceRef,period:'2026-11'}]})).text,/already_fixed/);
  delete f.tables.at(-1).fields.period;f.refresh();assert.equal((await f.ok({})).status,'needs_inputs');
  f.tables.pop();f.tables[1].fields.eligibleThrough=key('expires');f.doc.extra[0].expires='2026-11';f.refresh();
  assert.match((await f.call({plan:[{invoiceRef:movable.invoiceRef,period:'2026-12'}]})).text,/period_unavailable/);
  f.tables[3].fields.prepaidVat=key('prepaid');f.refresh();
  assert((await f.ok({})).gaps.some(g=>g.period==='2026-11'));
  // 原件实际送达日晚于票面日期时也要截止。
  f.doc.lateDelivery='2026-12-09';f.refresh();
  const withLate=JSON.parse(readFileSync(f.inputPath));withLate.sources[2].availableAt=ptr('/lateDelivery');write(f.inputPath,withLate);
  const beforeDelivery=await f.ok({});assert.equal(beforeDelivery.invoices.find(r=>r.taxAmount==='20.00').fixedPeriod,null);
  assert(!JSON.stringify(beforeDelivery).includes('PRIVATE'));
  for(const m of f.doc.months)m.prepaid=1000;f.refresh();
  assert.equal((await f.ok({})).status,'unsupported');
  f.tables[3].fields.prepaidVat=assumption(0,'无预缴场景');
  f.doc.extra.push({invoiceNumber:'000005',taxAmount:5,receipt:'2026-10',eligibility:'eligible'});
  f.doc.extra.push({invoiceNumber:'000006',issuer:'PRIVATE-SUPPLIER',taxAmount:5,receipt:'2026-10',eligibility:'PRIVATE-INVALID-STATUS'});
  f.refresh();const dirty=await f.ok({});assert.equal(dirty.status,'partial_known_invoices');assert(dirty.gaps.some(g=>g.code==='invoice_identity_incomplete'));assert(!JSON.stringify(dirty).includes('PRIVATE'));
  const badStatus=JSON.parse(readFileSync(f.inputPath));badStatus.sources[1].tables[0].statusFilter.include=['勾选确认'];write(f.inputPath,badStatus);
  const mixed=await f.ok({});assert.equal(mixed.status,'partial_known_invoices');assert(mixed.gaps.some(g=>g.code==='finance_vat_row_status_unresolved'));
  f.doc.old[0].taxPeriod='2026-08';f.tables[2].fields.issueDate=key('issued');f.doc.old[0].issued='2026-09-01';f.refresh();
  const badFixed=await f.ok({});assert(badFixed.gaps.some(g=>g.code==='confirmation_or_window_unresolved'));assert.equal(badFixed.invoices.find(i=>i.taxAmount==='20.00').resolved,false);
  f.doc.owner='合成另一企业';f.refresh();assert.match((await f.call({})).text,/original_owner_conflict/);
  const material=JSON.parse(readFileSync(f.inputPath));material.sources[0].sha256='0'.repeat(64);write(f.inputPath,material);
  assert.match((await f.call({})).text,/source_changed/);
 }finally{await f.client.close();}
});
