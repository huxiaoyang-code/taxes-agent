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

function pairedMaterials(f){
 const start='2026-11',next='2026-12',knownAt='2026-12-02';
 const doc={owner,opening:[{period:'2026-10',knownAt,carryCredit:0,scope:'monthly_general_domestic',inventoryCoverage:'complete',
  ytdSalesExcludingVat:900000,ytdDueBeforePrepayment:31000,ytdComparable:true,prepaymentBalance:0}],
  invoice:[3000,2000].map((taxAmount,i)=>({issuer:'合成销方',invoiceNumber:'T'+i,taxAmount,receipt:'2026-12-01',issueDate:'2026-11-12',eligibility:'eligible'})),
  portal:[0,1].map(i=>({issuer:'合成销方',invoiceNumber:'T'+i,knownAt,period:start,portalStatus:'selectable'})),
  month:[start,next,'2027-01'].map((period,i)=>({period,knownAt,basis:i?'forecast':'actual',state:'open',invoicedOutputVat:i?10000:4000,uninvoicedOutputVat:i?0:2000,
   invoicedSales:i?100000:80000,uninvoicedSales:i?0:20000,inputVatTransferOut:0,prepaidVat:0,otherEffects:'none'})),
  agreement:[{period:start,knownAt,burdenMode:'monthly',minimumPercent:3}]};
 const data=join(f.dbPath,'..','配对资料.json');
 const bind=()=>{
  write(data,doc);
  const tables=Object.entries(doc).filter(([,rows])=>Array.isArray(rows)&&rows.length).map(([kind,rows])=>({
   kind,rowsPointer:'/'+kind,fields:fields([...new Set(rows.flatMap(Object.keys))]),
  }));
  write(f.inputPath,{version:'finance-vat-planning-materials/1',sources:[{path:data,sha256:sha(readFileSync(data)),ownerField:'name',owner:ptr('/owner'),tables}]});
 };
 bind();return {doc,bind};
}

test('同一对 Agent 选票只换客户约定；逐分核对当月、累计、付款月及延后回收',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),start='2026-11',next='2026-12';
  const seen=await f.ok({}),[a,b]=seen.invoices.map(i=>i.invoiceRef);
  assert.equal(seen.invoices[1].firstPeriod,start);
  const choice=(invoiceRef,period)=>({invoiceRef,period});
  const args={baseline:[choice(a,start),choice(b,next)],plan:[choice(a,start),choice(b,start)]};
  const run=await f.ok(args),base=run.baseline.months[0],plan=run.plan.months[0];
  assert.equal(run.recommendation.choice,'baseline');
  assert.deepEqual([base.burden.monthly.percent,base.burden.ytd.percent,plan.burden.monthly.percent,plan.burden.ytd.percent],[3,3.4,1,3.2]);
  assert.deepEqual([base.dueBeforePrepayment,plan.dueBeforePrepayment,plan.salesExcludingVat],['3000.00','1000.00','100000.00']);
  assert.deepEqual(run.delta.byPaymentMonth.map(r=>r.afterVatCash),['2000.00','-2000.00','0.00']);
  assert.equal(run.plan.nextYear.burden.ytd.percent,10);
  doc.agreement[0].burdenMode='ytd';bind();
  const ytd=await f.ok(args);assert.equal(ytd.recommendation.choice,'plan');assert.deepEqual(ytd.baseline.months,run.baseline.months);
  assert.deepEqual((await f.ok(args)).recommendation,ytd.recommendation);
  delete doc.agreement[0].burdenMode;bind();
  assert.equal((await f.ok(args)).recommendation.reason,'clarify_customer_burden_mode');
  doc.agreement[0].burdenMode='monthly';doc.agreement[0].minimumPercent=8;bind();
  assert.equal((await f.ok(args)).recommendation.reason,'customer_minimum_unattained_among_options');
  doc.portal.push({...doc.portal[1],knownAt:'2026-12-03',portalStatus:'closed'});bind();
  assert.match((await f.call(args)).text,/period_unavailable/);assert.equal((await f.ok({asOf:'2026-12-02',...args})).recommendation.choice,'baseline');
  doc.portal.pop();doc.invoice[1].issueDate='2026-12-01';bind();assert.match((await f.call(args)).text,/period_unavailable/);
  doc.invoice[1].issueDate='2026-11-12';doc.filing=[{period:start,knownAt:'2026-12-03',declaredDue:6000}];bind();
  assert.match((await f.call(args)).text,/already_fixed/);assert.equal((await f.ok({})).plan.months[0].declaredDue,'6000.00');
  delete doc.filing;doc.opening[0].ytdComparable=false;doc.agreement[0].burdenMode='ytd';bind();
  const gap=await f.ok(args);assert.equal(gap.plan.months[0].burden.ytd.percent,null);assert.equal(gap.plan.months[0].burden.monthly.percent,1);assert.equal(gap.recommendation.choice,null);
  doc.history=Array.from({length:10},(_,i)=>({knownAt:'2026-11-01',period:'2026-'+String(i+1).padStart(2,'0'),salesExcludingVat:90000,dueBeforePrepayment:3100,ytdComparable:true}));bind();
  assert.equal((await f.ok(args)).plan.months[0].burden.ytd.percent,3.2);
  doc.month[0].invoicedSales=0;doc.month[0].uninvoicedSales=0;bind();
  const noSales=await f.ok(args);assert.equal(noSales.plan.months[0].burden.monthly.reason,'zero_sales');
  doc.month[0].outputVat=6000;bind();assert.equal((await f.ok(args)).status,'needs_inputs');
 }finally{await f.client.close();}
});

test('按原票及回执分开计转出、留抵核准、实际收付、预缴结转及更正重算',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),period='2026-11',knownAt='2026-12-03';
  const evt=(eventId,eventType,amount,operationDate,extra={})=>({eventId,eventType,amount,period,operationDate,knownAt,...extra});
  // 上期已抵扣，本期按票做红字及用途调整，取消未抵扣的另一张票。
  doc.invoice.forEach(b=>{b.issueDate='2026-09-01';b.receipt='2026-09-08';});
  const original={issuer:doc.invoice[0].issuer,invoiceNumber:'T0'};
  doc.confirmation=[{...original,knownAt:'2026-10-10',taxPeriod:'2026-09'}];
  doc.opening[0].carryCredit=1000;doc.opening[0].prepaymentBalance=500;
  doc.month[0].paymentDate='2026-12-16';
  doc.event=[
   evt('red','red_input',1200,'2026-11-11',original),evt('out','transfer_out',300,'2026-11-13',original),
   evt('other-red','red_input',2000,'2026-11-14',{...original,invoiceNumber:'T1'}),
   evt('prepay','prepayment',8000,'2026-11-15'),evt('refund-ask','refund_requested',600,'2026-11-05',{caseId:'留抵事项'}),
   evt('refund-ok','refund_approved',500,'2026-11-20',{caseId:'留抵事项'}),evt('refund-in','refund_received',400,'2026-12-02',{caseId:'留抵事项'}),
   evt('prior','payment',200,'2026-11-01',{period:'2026-09'}),
  ];
  doc.event.push({...doc.event[3]});
  bind();const r=await f.ok({});assert.equal(r.status,'conditional_calculated',JSON.stringify(r.gaps));
  const m=r.plan.months[0];assert.deepEqual([m.dueBeforePrepayment,m.prepaidVat,m.prepaymentUsed,m.due,m.endingPrepayment,m.refundApproved],['7000.00','8000.00','7000.00','0.00','1500.00','500.00']);
  assert.equal(m.burden.monthly.percent,7);assert.equal(r.plan.months[1].due,'8500.00');
  const [nov,dec]=r.plan.cashByMonth;assert.deepEqual([nov.actualPaid,nov.prepaid,nov.netCashOutflow,dec.refundReceived,dec.netCashOutflow],['200.00','8000.00','8200.00','400.00','-400.00']);
  assert.equal(r.activity.filter(e=>e.eventType==='prepayment').length,1);
  assert.match((await f.call({plan:[{invoiceRef:r.invoices[1].invoiceRef,period}]})).text,/period_unavailable/);
  doc.event.push(evt('fix','prepayment',1000,'2026-11-25',{supersedes:'prepay'}));bind();
  const fixed=await f.ok({});assert.equal(fixed.plan.months[0].due,'5500.00');assert.equal(fixed.plan.months[1].due,'10000.00');
  doc.filing=[{period,knownAt,declaredDue:5500}];doc.event.push(evt('paid','payment',1000,'2026-12-01'));bind();
  const paid=await f.ok({});assert.equal(paid.plan.months[0].expectedPayment,'4500.00');
  assert.equal(paid.plan.cashByMonth.find(r=>r.paymentMonth==='2026-12').netCashOutflow,'5100.00');
  doc.event.push({...doc.event.at(-1),amount:1001});bind();assert.equal((await f.ok({})).status,'needs_inputs');
 }finally{await f.client.close();}
});


test('整段客户约定、年末现金和近期付款分别比较；未来经营变化能翻转建议',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),target={period:'2026-10',accountSetId:1},periods=['2026-10','2026-11','2026-12','2027-01'];
  doc.opening[0].period='2026-09';doc.agreement[0].period=target.period;doc.agreement[0].effectiveThrough=target.period;
  for(const inv of doc.invoice){inv.issueDate='2026-09-12';inv.receipt='2026-10-01';}
  delete doc.portal;doc.month=periods.map((period,i)=>({period,knownAt:'2026-12-02',basis:i?'forecast':'actual',state:'open',
   outputVat:i===1?4500:6000,salesExcludingVat:100000,inputVatTransferOut:0,prepaidVat:0,otherEffects:'none'}));
  bind();const [a,b]=(await f.ok({target})).invoices.map(r=>r.invoiceRef);
  const options={target,baseline:[{invoiceRef:b,period:periods[0]},{invoiceRef:a,period:periods[3]}],plan:[{invoiceRef:a,period:periods[1]},{invoiceRef:b,period:periods[3]}]};
  const short=(await f.ok(options)).recommendation;
  assert.equal(short.choice,'plan');assert.equal(short.checks.length,1);
  assert.equal(short.cashComparison.planYearEndCashRetained,'1000.00');assert.equal(short.cashComparison.firstDifference.planCashRetained,'-2000.00');
  assert.equal(short.cashComparison.firstRecovery,'2026-12');
  assert.equal(short.cashComparison.equivalentThroughLastPayment,true);
  delete doc.agreement[0].effectiveThrough;bind();
  const inherited=(await f.ok(options)).recommendation;
  assert.equal(inherited.choice,'baseline');
  assert.deepEqual(inherited.checks.map(r=>r.period),periods);
  assert.equal(inherited.checks.at(-1).burdenMode,'monthly');
  doc.agreement.push({period:'2027-01',knownAt:'2026-12-02',burdenMode:'ytd',minimumPercent:2});bind();
  const revised=(await f.ok(options)).recommendation;
  assert.deepEqual(revised.checks.map(r=>r.burdenMode),['monthly','monthly','monthly','ytd']);
  assert.equal(revised.checks.at(-1).plan.percent,4);
  doc.agreement.pop();
  doc.agreement[0].effectiveThrough='2026-12';bind();
  const constrained=(await f.ok(options)).recommendation;
  assert.equal(constrained.choice,'baseline');assert.equal(constrained.checks[1].plan.shortfall,'1500.00');assert.equal(constrained.checks[1].basis,'forecast');
  doc.month[1].outputVat=7000;bind();assert.equal((await f.ok(options)).recommendation.choice,'plan');
  delete doc.agreement[0].effectiveThrough;doc.month[1].outputVat=300;bind();assert.equal((await f.ok(options)).recommendation.choice,'baseline');
  doc.month[0].salesExcludingVat=-100;bind();const loss=await f.ok(options);
  assert.equal(loss.status,'conditional_calculated');assert.equal(loss.plan.months[0].burden.monthly.reason,'negative_sales');assert.equal(loss.plan.months[1].burden.monthly.percent,0);
 }finally{await f.client.close();}
});

test('门户按首次可知精度取最近观察；晚收票遇到关窗不能再选上期',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),asOf='2027-01-02',period='2026-11';
  const view=await f.ok({asOf}),invoiceRef=view.invoices[0].invoiceRef;
  doc.portal.push({...doc.portal[0],knownAt:'2026-12',portalStatus:'closed'});bind();
  assert.match((await f.call({asOf,plan:[{invoiceRef,period}]})).text,/period_unavailable/);
  assert.equal((await f.ok({asOf:'2026-12-30',plan:[{invoiceRef,period}]})).plan.months[0].selectedAndFixedInput,'3000.00');
  doc.portal.push({...doc.portal[0],knownAt:'2026-12-31 13:05:00'});bind();
  const ambiguous=await f.ok({asOf});
  assert(ambiguous.gaps.some(g=>g.code==='portal_window_unverified'&&g.invoiceRef===invoiceRef));
  doc.portal[2].knownAt='2026-12-31 13:04:00';bind();
  assert.equal((await f.ok({asOf,plan:[{invoiceRef,period}]})).plan.months[0].selectedAndFixedInput,'3000.00');
 }finally{await f.client.close();}
});

test('原票与确认回执的开票日期冲突，以及错属期撤销，均需核实原票',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),taxPeriod='2026-11';
  const confirmation={issuer:doc.invoice[0].issuer,invoiceNumber:doc.invoice[0].invoiceNumber,taxPeriod,
   knownAt:'2026-12-02',operationDate:'2026-12-02',confirmationState:'confirmed',receiptId:'确认原件'};
  doc.confirmation=[{...confirmation,issueDate:'2026-12-01'}];bind();
  const conflict=await f.ok({});
  assert.equal(conflict.invoices[0].resolved,false);
  assert.equal(conflict.status,'partial_known_invoices');
  doc.confirmation=[confirmation,{...confirmation,taxPeriod:'2026-12',knownAt:'2026-12-03',operationDate:'2026-12-03',
   receiptId:'撤销原件',supersedes:'确认原件',confirmationState:'revoked'}];bind();
  const wrongPeriod=await f.ok({});
  assert.equal(wrongPeriod.invoices[0].resolved,false);
  assert.match((await f.call({plan:[{invoiceRef:wrongPeriod.invoices[0].invoiceRef,period:'2026-12'}]})).text,/selection_unknown_or_duplicate/);
 }finally{await f.client.close();}
});

test('正式更正用途确认及申报回执保留历史链，撤销时只解开该票且尊重已报月',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),taxPeriod='2026-11';
  const ref={invoiceNumber:'T0',issuer:'合成销方',taxPeriod};
  doc.confirmation=[{...ref,knownAt:'2026-12-01',operationDate:'2026-12-01',receiptId:'原确认',confirmationState:'confirmed'},
   {...ref,knownAt:'2026-12-03',operationDate:'2026-12-03',receiptId:'撤销确认',supersedes:'原确认',confirmationState:'revoked'}];bind();
  const before=await f.ok({asOf:'2026-12-02'}),after=await f.ok({});
  assert.equal(before.invoices[0].fixedPeriod,taxPeriod);assert.equal(after.invoices[0].fixedPeriod,null);assert.equal(after.invoices[0].confirmationState,'revoked');
  const plan=[{invoiceRef:after.invoices[0].invoiceRef,period:taxPeriod}];assert.equal((await f.ok({plan})).plan.months[0].due,'3000.00');
  doc.filing=[{period:taxPeriod,knownAt:'2026-12-01',receiptId:'原申报',declaredDue:3000},
   {period:taxPeriod,knownAt:'2026-12-04',receiptId:'更正申报',supersedes:'原申报',declaredDue:6000}];bind();
  assert.equal((await f.ok({})).plan.months[0].declaredDue,'6000.00');
  assert.match((await f.call({plan})).text,/already_fixed/);
 }finally{await f.client.close();}
});


test('跨月补开同一交易、红字原交易及新生效客户约定按原件重算',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),period='2026-11',knownAt='2026-12-01';
  const nov={transactionId:'销售-1',taxPointDate:'2026-11-15',knownAt,salesExcludingVat:100000,outputVat:6000};
  doc.sale=[nov,{...nov,billingDate:'2026-12-12',knownAt:'2026-12-12'},
   {transactionId:'销售-2',taxPointDate:'2026-12-18',knownAt:'2026-12-18',salesExcludingVat:10000,outputVat:600},
   {transactionId:'红字-1',originalTransactionId:'销售-1',taxPointDate:'2026-12-10',knownAt:'2026-12-10',billingDate:'2026-12-10',salesExcludingVat:5000,outputVat:300}];
  for(const row of doc.month.slice(0,2)){
   for(const key of ['invoicedSales','uninvoicedSales','invoicedOutputVat','uninvoicedOutputVat'])delete row[key];
   row.salesCoverage='complete_transactions';row.basis='actual';
  }
  // 12月实绩在1月可见；先前仍使用当时的预测，之后以实绩替换。
  doc.month[1].knownAt='2027-01-02';
  doc.month.push({period:'2026-12',knownAt,basis:'forecast',state:'open',outputVat:4500,salesExcludingVat:100000,inputVatTransferOut:0,prepaidVat:0,otherEffects:'none'});
  doc.agreement[0].effectiveThrough=period;doc.agreement.push({period:'2026-12',effectiveThrough:'2026-12',knownAt,burdenMode:'ytd',minimumPercent:2});
  bind();const old=await f.ok({baseline:[],plan:[]});
  assert.equal(old.baseline.months[1].outputVat,'4500.00');
  assert.deepEqual(old.recommendation.checks.map(r=>[r.period,r.burdenMode]),[[period,'monthly'],['2026-12','ytd']]);
  const now=await f.ok({asOf:'2027-01-04',baseline:[],plan:[]});assert.equal(now.status,'conditional_calculated',JSON.stringify(now.gaps));
  assert.deepEqual(now.plan.months.slice(0,2).map(r=>[r.salesExcludingVat,r.outputVat]),[['100000.00','6000.00'],['5000.00','300.00']]);
  assert.equal(now.plan.months[0].uninvoicedOutputVat,'6000.00');assert.equal(now.plan.months[1].basis,'actual');
  doc.sale[1].taxPointDate='2026-12-12';bind();
  assert((await f.ok({asOf:'2027-01-04'})).gaps.some(g=>g.code==='conflicting_recognition_of_same_transaction'));
  doc.sale[1].taxPointDate='2026-11-15';doc.sale[3].originalTransactionId='无原单';bind();
  assert((await f.ok({asOf:'2027-01-04'})).gaps.some(g=>g.code==='red_sale_original_or_amount_unverified'));
 }finally{await f.client.close();}
});

test('年末实物余票与决策日可选十二月的余票分别计算，门户关窗、锁定和新年开票限制选期',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),period='2026-12',asOf='2027-01-08',bill=doc.invoice[1];
  doc.invoice=[{...bill,issueDate:'2026-12-20',receipt:'2027-01-04',eligibleThrough:period}];
  doc.portal=[{...doc.portal[1],period,knownAt:'2027-01-05'}];bind();
  const view=await f.ok({asOf}),invoiceRef=view.invoices[0].invoiceRef;
  const result=await f.ok({asOf,baseline:[],plan:[{invoiceRef,period}]});
  assert.deepEqual([result.baseline.yearEnd.unusedVat,result.plan.yearEnd.unusedVat,result.delta.yearEndUnusedVat],['0.00','0.00','0.00']);
  assert.deepEqual([result.baseline.yearEnd.selectableUnusedVat,result.plan.yearEnd.selectableUnusedVat,result.delta.yearEndSelectableUnusedVat],['2000.00','0.00','-2000.00']);
  assert.equal(result.baseline.yearEnd.selectableUnusedCount,1);
  const beforeReceipt=await f.ok({asOf:'2027-01-03'});assert.equal(beforeReceipt.plan.yearEnd.selectableUnusedVat,'0.00');
  delete doc.invoice[0].eligibleThrough;doc.portal[0].portalStatus='closed';bind();
  assert.equal((await f.ok({asOf})).plan.yearEnd.selectableUnusedVat,'0.00');
  doc.portal[0].portalStatus='selectable';doc.invoice[0].issueDate='2027-01-03';bind();
  assert.equal((await f.ok({asOf})).plan.yearEnd.selectableUnusedVat,'0.00');
  doc.invoice[0].issueDate='2026-12-20';doc.month[1].basis='actual';doc.filing=[{knownAt:'2027-01-07',period,declaredDue:10000}];bind();
  assert.equal((await f.ok({asOf})).plan.yearEnd.selectableUnusedVat,'0.00');
 }finally{await f.client.close();}
});

test('申报应补与测算差一万六按可比口径进入关联累计，缺预缴证据分列模拟并保留待核',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),period='2026-11',args={baseline:[],plan:[]};
  doc.filing=[{period,knownAt:'2026-12-03',declaredDue:22000}];bind();
  const diff=await f.ok(args),nov=diff.plan.months[0];
  assert.equal(nov.due,'6000.00');assert.equal(nov.declaredDue,'22000.00');
  assert.deepEqual([nov.filingReconciliation.status,nov.declaredDifference,nov.expectedPayment],['difference','16000.00','22000.00']);
  assert.equal(nov.filingReconciliation.numeratorBasis,'declared_balance_with_verified_zero_prepayment');
  assert.deepEqual([nov.burden.monthly.percent,nov.burden.ytd.percent,nov.simulatedBurden.monthly.percent,nov.simulatedBurden.ytd.percent],[22,5.3,6,3.7]);
  assert.equal(diff.plan.months[1].burden.ytd.dueBeforePrepayment,'63000.00');
  assert.equal(diff.recommendation.choice,null);assert.equal(diff.recommendation.reason,'filing_reconciliation_required');
  delete doc.opening[0].prepaymentBalance;bind();const pending=(await f.ok(args)).plan;
  assert.equal(pending.months[0].burden.monthly.percent,null);assert.equal(pending.months[1].burden.ytd.reason,'filed_pre_offset_tax_unverified');
  assert.equal(pending.months[0].simulatedBurden.monthly.percent,6);assert.equal(pending.months[2].burden.ytd.percent,10);
  doc.filing[0].declaredDueBeforePrepayment=23000;bind();assert.equal((await f.ok(args)).plan.months[0].burden.monthly.percent,23);
  doc.filing[0].declaredDueBeforePrepayment=6000;doc.filing[0].declaredDue=6000;bind();const matched=await f.ok(args);
  assert.equal(matched.plan.months[0].filingReconciliation.status,'matched');assert(matched.recommendation.choice);
 }finally{await f.client.close();}
});

test('所属期与付款月分别核实缴付覆盖，区分无回执、部分收件和截至决策日的已核零值',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),period='2026-11',asOf='2026-12-05';
  const empty=(await f.ok({})).plan,initial=empty.months[0];
  assert.equal(initial.actualPaid,'0.00');assert.equal(initial.actualPaidEvidence.status,'not_provided');assert.equal(initial.expectedPaymentBasis,'assuming_no_additional_payments');
  assert.equal(empty.cashByMonth[0].actualPaidEvidence.status,'not_provided');assert.equal(empty.cashByMonth[0].expectedPaymentBasis,'assuming_no_additional_payments');
  doc.paymentCoverage=[{period,knownAt:asOf,coveredThrough:'2026-12-02',coverageScope:'tax_period'}];bind();
  assert.equal((await f.ok({})).plan.months[0].actualPaidEvidence.status,'coverage_incomplete');
  doc.paymentCoverage[0].coveredThrough=asOf;bind();
  const zero=(await f.ok({})).plan;
  assert.equal(zero.months[0].actualPaidEvidence.status,'complete_as_of');assert.equal(zero.months[0].expectedPaymentBasis,'verified_payments_at_cutoff');
  assert(zero.months[0].actualPaidEvidence.sources.length);assert.equal(zero.cashByMonth[0].actualPaidEvidence.status,'not_provided');
  delete doc.paymentCoverage;doc.event=[{period,knownAt:'2026-12-03',operationDate:'2026-12-02',eventType:'payment',amount:1100,eventId:'已收回单'}];bind();
  const partial=(await f.ok({})).plan;assert.equal(partial.months[0].actualPaid,'1100.00');assert.equal(partial.months[0].actualPaidEvidence.status,'documented_receipts_only');
  assert.equal(partial.months[0].expectedPayment,'4900.00');assert.equal(partial.cashByMonth[0].actualPaidEvidence.status,'documented_receipts_only');
  doc.paymentCoverage=[{period:'2026-12',knownAt:asOf,coveredThrough:asOf,coverageScope:'cash_month'}];bind();
  const cash=(await f.ok({})).plan;assert.equal(cash.cashByMonth[0].actualPaidEvidence.status,'complete_as_of');
  assert.equal(cash.months[0].actualPaidEvidence.status,'documented_receipts_only');
 }finally{await f.client.close();}
});

test('同一账套两张已核票可比较，冲突票仅列报送金额，局部建议受累计与申报证据约束',async()=>{
 const f=await fixture();
 try{
  const {doc,bind}=pairedMaterials(f),period='2026-11';
  doc.agreement[0].burdenMode='ytd';
  doc.invoice.push({...doc.invoice[0],invoiceNumber:'T-conflict',taxAmount:4000},{...doc.invoice[0],invoiceNumber:'T-conflict',taxAmount:5000});bind();
  const visible=await f.ok({}),[a,b,conflicting]=visible.invoices.map(r=>r.invoiceRef);
  const args={baseline:[{invoiceRef:a,period}],plan:[{invoiceRef:a,period},{invoiceRef:b,period}]};
  const partial=await f.ok(args),rec=partial.knownSubset.recommendation;
  assert.equal(partial.status,'partial_known_invoices');assert.equal(partial.recommendation,undefined);
  assert.equal(rec.scope,'submitted_options_on_known_invoices_only');assert.equal(rec.provisional,true);assert.equal(rec.choice,'plan');
  assert.deepEqual(rec.excludedInvoices,[{invoiceRef:conflicting,reportedTaxAmounts:['4000.00','5000.00'],amountStatus:'conflicting_reports'}]);
  assert.equal(rec.knownInvoices,2);assert.equal(rec.comparedThrough,'2027-01');
  assert.deepEqual([partial.knownSubset.plan.months[0].due,partial.knownSubset.baseline.months[0].due],['1000.00','3000.00']);
  doc.opening[0].ytdComparable=false;bind();const unknown=(await f.ok(args)).knownSubset.recommendation;
  assert.equal(unknown.choice,null);assert.equal(unknown.reason,'agreement_basis_incomplete');
  doc.filing=[{period,knownAt:'2026-12-02',declaredDue:22000}];bind();
  const filed=(await f.ok({baseline:[],plan:[]})).knownSubset.recommendation;
  assert.equal(filed.choice,null);assert.equal(filed.reason,'filing_reconciliation_required');
 }finally{await f.client.close();}
});
