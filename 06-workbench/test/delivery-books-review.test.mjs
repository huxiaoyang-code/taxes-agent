import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {readDeliveryBooks} from '../server/delivery-books-review.mjs';
import {createSyntheticFixture} from './helpers/business-memory-e2e-fixture.mjs';

const period='2026-09';
const scope={accountSetId:1,period,enterpriseKey:'synthetic',databaseInstanceId:'12345678-1234-4234-8321-111111111111'};
function fixture(){
  const dbPath=join(mkdtempSync(join(tmpdir(),'delivery-books-')),'books.db');
  const db=new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE account_sets(id,name,accounting_standard,accounting_profile_id,start_period);
  INSERT INTO account_sets VALUES(1,'合成账套','小企业会计准则','small-2011-basic-v1','2026-09');
  CREATE TABLE import_enterprise_account_sets(account_set_id,enterprise_key,enterprise_name);INSERT INTO import_enterprise_account_sets VALUES(1,'synthetic','合成企业');
  CREATE TABLE audit_database_instances(instance_id,is_active); INSERT INTO audit_database_instances VALUES('${scope.databaseInstanceId}',1);
  CREATE TABLE periods(account_set_id,period,status);INSERT INTO periods VALUES(1,'2026-09','open');
  CREATE TABLE accounts(account_set_id,code,name,direction,category,contra);
  INSERT INTO accounts VALUES(1,'1002','银行存款','debit','资产',0),(1,'1405','库存商品','debit','资产',0),(1,'140501','商品甲','debit','资产',0),
  (1,'1403','原材料','debit','资产',0),(1,'1221','其他应收款','debit','资产',0),
  (1,'222101','应交增值税','credit','负债',0),(1,'22210111','未交增值税','credit','负债',0),
  (1,'3001','实收资本','credit','权益',0),(1,'5602','管理费用','debit','损益',0);
  CREATE TABLE opening_balances(account_set_id,code,debit,credit);
  INSERT INTO opening_balances VALUES(1,'1002',100,0),(1,'1405',20,0),(1,'140501',30,0),(1,'1403',10,0),(1,'22210111',0,15),(1,'3001',0,145);
  CREATE TABLE vouchers(id,account_set_id,period,voucher_date,kind,status,word,number);
  INSERT INTO vouchers VALUES(1,1,'2026-09','2026-09-01','ordinary','posted','记',1),(2,1,'2026-09','2026-09-30','ordinary','posted','记',2);
  CREATE TABLE voucher_entries(voucher_id,line_no,code,debit,credit);
  INSERT INTO voucher_entries VALUES(1,1,'22210111',15,0),(1,2,'1221',2,0),(1,3,'1002',0,17),(2,1,'5602',18,0),(2,2,'22210111',0,18);`);
  return {db,dbPath,scope};
}
const localFile=(name,text)=>({name,bytes:Buffer.from(text)});
test('库存进项取证只从绑定本期的已过账凭证提取，供应商名称取应付明细',()=>{
  const f=fixture();
  try{
    f.db.exec(`ALTER TABLE vouchers ADD COLUMN summary;
      INSERT INTO accounts VALUES(1,'220201','合成供应商','credit','负债',0);
      INSERT INTO vouchers VALUES
      (3,1,'2026-09','2026-09-10','ordinary','posted','记',3,'采购货品（税额不抵扣）'),
      (4,1,'2026-09','2026-09-10','ordinary','draft','记',4,'相同草稿'),
      (5,1,'2026-08','2026-08-10','ordinary','posted','记',5,'前期'),
      (6,2,'2026-09','2026-09-10','ordinary','posted','记',6,'其他账套');
      INSERT INTO voucher_entries SELECT id,1,'1405',113,0 FROM vouchers WHERE id>=3;
      INSERT INTO voucher_entries SELECT id,2,'220201',0,113 FROM vouchers WHERE id>=3;`);
    const get=()=>readDeliveryBooks(f,[]).inventoryLedger.purchasePostings;
    assert.deepEqual(get(),[{voucherId:3,date:'2026-09-10',seller:'合成供应商',grossMinor:'11300',summary:'采购货品（税额不抵扣）'}]);
    f.db.exec("UPDATE voucher_entries SET code='1403' WHERE voucher_id=3 AND line_no=1");
    assert.equal(get()[0].summary,'');
  }finally{f.db.close();}
});
const draft='类别,项目,金额（元）\n资产,货币资金,83\n资产,其他应收款,2\n资产,存货,60\n资产,资产总计,145\n负债,应交税费,18\n负债,负债合计,18\n权益,实收资本,145\n权益,未结转损益,-18\n权益,所有者权益合计,127\n检查,负债和所有者权益总计,145';
const summary='项目,金额（元）/值\nassets,145\nliabilities,18\nequity,127\nbalanced,true\ncomplete,true\ncash,83';
test('派生余额表复核全量有效行，认可借正贷负及方向配绝对额，合计错误逐栏返回',()=>{
  const f=fixture();
  try{
    const header='科目编码,期初方向,期初余额,本期借方,本期贷方,期末方向,期末余额';
    const rows=['1002,借,100,0,17,借,83','1221,平,0,2,0,借,2','1403,借,10,0,0,借,10','1405,借,20,0,0,借,20',
      '140501,借,30,0,0,借,30','22210111,贷,-15,15,18,贷,-18','3001,贷,-145,0,0,贷,-145','5602,平,0,18,0,借,18'];
    const review=(body)=>readDeliveryBooks(f,[localFile('余额.csv',body),localFile('资产负债表.csv',draft)]).issues;
    const valid=[header,...rows].join('\n');
    assert.deepEqual(review(valid),[]);
    assert.deepEqual(review(valid.replaceAll('贷,-','贷,')),[]);
    assert.deepEqual(review(valid+'\n合计,,0,35,35,,0'),[]);
    assert(review(valid+'\n合计,,0,35,35,,1').some(i=>i.code==='trial_amount_mismatch'));
    assert(review(valid.replace('贷,-18','借,-18')).some(i=>i.code==='trial_direction_mismatch'));
    const omission=review([header,...rows.filter(r=>!r.startsWith('1405,')),rows[0]].join('\n'));
    assert(omission.some(i=>i.code==='trial_account_duplicate'));
    assert(omission.some(i=>i.code==='trial_active_account_omitted'));
  }finally{f.db.close();}
});
test('期初和已过账发生额逐科目归至原生行，库存商品与全口径存货分开、专用税目按复合付款重建',()=>{
  const f=fixture();
  try{
    const files=[localFile('05_资产负债表_2026-09.csv',draft),localFile('05B_原生资产负债表摘要.csv',summary)];
    const r=readDeliveryBooks(f,files);
    assert.deepEqual(r.issues,[]);
    assert.equal(r.inventoryMinor,'5000');
    assert.equal(r.coverage.statementInventoryMinor,'6000');
    assert.deepEqual(r.vatLedger,{openingMinor:'1500',currentMinor:'1800',paidMinor:'1500',closingMinor:'1800'});
    assert.equal(r.coverage.accounts.filter(a=>a.window==='closing'&&a.row==='inventory').length,3);
    const wrong=readDeliveryBooks(f,[files[1],localFile(files[0].name,draft.replace('货币资金,83','货币资金,84').replace('其他应收款,2','其他应收款,1'))]);
    assert.equal(wrong.issues.filter(i=>i.code==='statement_amount_mismatch').length,2);
    assert(wrong.issues.some(i=>i.code==='statement_versions_disagree'));
    const dup=readDeliveryBooks(f,[localFile(files[0].name,draft.replace('资产,存货,60','资产,其他应收款,2'))]);
    assert(dup.issues.some(i=>i.code==='statement_row_duplicate'));
    assert(dup.issues.some(i=>i.code==='statement_row_omitted'&&i.location.endsWith('/存货')));
    f.db.exec("UPDATE vouchers SET status='draft' WHERE id=1");
    const changed=readDeliveryBooks(f,files);
    assert.notEqual(changed.bookDigest,r.bookDigest);
    assert(changed.issues.some(i=>i.code==='book_voucher_not_posted'));
    assert.equal(changed.vatLedger.paidMinor,'0');
    assert.throws(()=>readDeliveryBooks({...f,scope:{...scope,enterpriseKey:'other'}},files),/identity_changed/);
  }finally{f.db.close();}
});

test('按账面计入报表的反向余额参与勾稽且独立复核继续逐笔阻断',()=>{
  const f=fixture();
  try {
    f.db.exec("INSERT INTO accounts VALUES(1,'1001','库存现金','debit','资产',0),(1,'224111','往来甲','credit','负债',0); INSERT INTO opening_balances VALUES(1,'1001',0,7),(1,'224111',7,0)");
    const r=readDeliveryBooks(f,[]);
    const closing=r.coverage.accounts.filter(a=>a.window==='closing'&&['1001','224111'].includes(a.account));
    assert.deepEqual(closing.map(a=>[a.account,a.row,a.netMinor]),[['1001','cash','-700'],['224111','other-payables','700']]);
    for(const row of closing){
      const issue=r.issues.find(i=>i.code==='account_reverse_balance_requires_detail'&&i.location==='closing/'+row.account);
      assert.equal(issue.owner,'accountant');
      assert.match(issue.note,row.account==='1001'?/货币资金.*现金日记账/:/其他应付款.*合同/);
    }
    assert(!r.issues.some(i=>i.code==='native_balance_sheet_unbalanced'));
    f.db.exec("INSERT INTO accounts VALUES(1,'180177','待核项目','debit','资产',0); INSERT INTO opening_balances VALUES(1,'180177',0,4),(1,'1002',4,0)");
    const explained=readDeliveryBooks(f,[]);
    const closingIssue=result=>result.issues.find(i=>['native_balance_sheet_detail_gap','native_balance_sheet_unbalanced'].includes(i.code)&&i.location==='closing');
    assert.equal(closingIssue(explained).owner,'accountant');
    assert.match(closingIssue(explained).note,/-400 分/);
    // 期初需要会计查跨期，期末又出现产品缺映射，必须能同时退给不同责任人。
    f.db.exec("INSERT INTO accounts VALUES(1,'9889','本期新科目','debit','资产',0); UPDATE voucher_entries SET code='9889' WHERE code='1221'");
    const mixed=readDeliveryBooks(f,[]);
    assert(mixed.issues.some(i=>i.code==='native_balance_sheet_detail_gap'&&i.location==='opening'&&i.owner==='accountant'));
    assert(mixed.issues.some(i=>i.code==='native_balance_sheet_unbalanced'&&i.location==='closing'&&i.owner==='product'));
    f.db.exec("INSERT INTO accounts VALUES(1,'9888','未知借方','debit','资产',0); INSERT INTO opening_balances VALUES(1,'9888',1,0),(1,'3001',0,1)");
    assert.equal(closingIssue(readDeliveryBooks(f,[])).owner,'product');
  }finally{f.db.close();}
});

test('附表重复的结构化总额及差额需重出，历史和预测说明保留原口径',async()=>{
  const f=fixture();
  try{
    const {default:ExcelJS}=await import('exceljs');
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('月末交接');
    sheet.addRows([['科目','交接说明'],
      ['财表','账面底稿：资产140；负债18；权益127；平衡0.00'],
      ['历史试算','资产140；负债18；权益127'],
      ['本期','本期原生报表：资产145元，负债18元，权益127元，资产减负债及权益3.00元。'],
      ['预算','资产300万元，负债200万元，权益100万元']]);
    const review=async()=>readDeliveryBooks(f,[{name:'月末库存汇总.xlsx',bytes:Buffer.from(await workbook.xlsx.writeBuffer())},localFile('资产负债表.csv',draft)]);
    const errors=(await review()).issues.filter(i=>i.code==='statement_repeated_total_mismatch');
    assert.deepEqual(errors.map(i=>[i.location,i.actual,i.expected]),[
      ['月末库存汇总.xlsx/月末交接/2/2','140 元','145.00 元'],['月末库存汇总.xlsx/月末交接/4/2','3.00 元','0.00 元']]);
    sheet.getCell('B2').value='账面底稿：资产145；负债18；权益127；平衡0.00';
    sheet.getCell('B4').value='本期报表见资产负债表.csv';
    assert.deepEqual((await review()).issues,[]);
  }finally{f.db.close();}
});

test('双边相等仍找出两项相抵的遗漏；本地未核账户的性质并不按总额倒推',()=>{
  const f=fixture();
  try{
    f.db.exec("INSERT INTO accounts VALUES(1,'9881','未映射借方','debit','资产',0),(1,'9882','未映射贷方','credit','负债',0); INSERT INTO opening_balances VALUES(1,'9881',9,0),(1,'9882',0,9)");
    const r=readDeliveryBooks(f,[localFile('资产负债表.csv',draft)]);
    assert.deepEqual(r.issues.filter(i=>i.code==='account_unmapped').map(i=>[i.location,i.actual]),[['opening/9881','900'],['opening/9882','-900'],['closing/9881','900'],['closing/9882','-900']]);
    assert(!r.issues.some(i=>i.code==='native_balance_sheet_unbalanced'));
    assert.equal(r.coverage.accounts.find(a=>a.account==='9881').row,null);
  }finally{f.db.close();}
});

test('正式原生CSV逐行和期初金额与同一账库一致，旧版文件不能清除变更',async t=>{
  const f=createSyntheticFixture();
  const oldDir=process.env.WORKBENCH_DATA_DIR;
  process.env.WORKBENCH_DATA_DIR=f.data;
  t.after(()=>{if(oldDir===undefined)delete process.env.WORKBENCH_DATA_DIR;else process.env.WORKBENCH_DATA_DIR=oldDir;});
  const {buildReportExport}=await import('../server/report-export.mjs');
  const {db}=await import('../server/db.mjs');t.after(()=>db.close());
  const report=buildReportExport(f.a,{kind:'balance-sheet',period:'2026-10'});
  const binding={dbPath:f.dbPath,scope:{...f.scopeA,period:'2026-10'}};
  const checked=readDeliveryBooks(binding,[localFile(report.filename,report.body)]);
  assert.deepEqual(checked.issues,[]);
  const trial=buildReportExport(f.a,{kind:'trial-balance',period:'2026-10'});
  assert.deepEqual(readDeliveryBooks(binding,[localFile(report.filename,report.body),localFile(trial.filename,trial.body)]).issues,[]);
  const missing=trial.body.split('\r\n').filter(l=>!l.startsWith('"1001",')).join('\r\n');
  assert(readDeliveryBooks(binding,[localFile(report.filename,report.body),localFile(trial.filename,missing)]).issues.some(i=>i.code==='trial_balance_account_omitted'));
  const {buildOfficeExport}=await import('../server/report-office-export.mjs');
  const office=await buildOfficeExport(f.a,{kind:'balance-sheet',period:'2026-10',format:'xlsx'});
  assert.deepEqual(readDeliveryBooks(binding,[{name:office.filename,bytes:office.body}]).issues,[]);
  const parts=unzipSync(office.body);
  parts['xl/workbook.xml']=strToU8(strFromU8(parts['xl/workbook.xml']).replace('_xlnm.Print_Area','其他定义'));
  assert(readDeliveryBooks(binding,[{name:office.filename,bytes:Buffer.from(zipSync(parts))}]).issues.some(i=>i.code==='statement_workbook_unreadable'));
  const wrong=report.body.replace(/("资产","应收账款",)[0-9.]+/, '$1'+'999.93');
  assert.notEqual(wrong,report.body);
  assert(readDeliveryBooks(binding,[localFile(report.filename,wrong)]).issues.some(i=>i.code==='statement_amount_mismatch' && i.location.endsWith('/期初')));
});
