import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDeliveryVat} from '../server/delivery-vat-review.mjs';

const name='合成公司',period='2026-09';
const form='纳税人名称,所属期,栏次,项目,一般项目本月数\n'+[
  ['24','应纳税额合计',20],['25','期初未缴税额',-1],['26','实收出口开具专用缴款书退税额',0],
  ['27','本期已缴税额',20],['32','期末未缴税额',-1],
].map(r=>[name,period,...r].join(',')).join('\n');
const paper='税种,核对项目,申报栏次,申报金额,账载项目,账载金额\n'+[
  ['本期应纳',24,20],['期初未缴',25,-1],['本期已缴',27,20],['期末未缴',32,-1],
].map(([label,line,n])=>['增值税',label,line,n,label,n].join(',')).join('\n');
const vatLedger={currentMinor:'2000',openingMinor:'-100',paidMinor:'2000',closingMinor:'-100'};
const run=(source=form,work=paper,ledger=vatLedger)=>reviewDeliveryVat({period,enterpriseName:name,vatLedger:ledger,
  sources:[{name:'申报原表.csv',bytes:Buffer.from(source)}],files:[{name:'税费核对.csv',bytes:Buffer.from(work)}]});

test('正式底稿正确时也核库存附页及交接说明重复的未标口径税差',async()=>{
  const {default:ExcelJS}=await import('exceljs'),wb=new ExcelJS.Workbook();
  const phrase='账载应交税费1,002.51，与申报1,002.49差0.02';
  const s=wb.addWorksheet('交接结果');s.addRows([['项目','说明'],['税费',phrase],['历史记录',phrase]]);
  const check=async(note)=>reviewDeliveryVat({period,enterpriseName:name,vatLedger,
    sources:[{name:'申报原表.csv',bytes:Buffer.from(form)}],
    files:[{name:'税费.csv',bytes:Buffer.from(paper)},{name:'周转表.xlsx',bytes:Buffer.from(await wb.xlsx.writeBuffer())},{name:'交接.md',bytes:Buffer.from(note)}]});
  const bad=await check('九月交接\n'+phrase);
  assert.deepEqual(bad.issues.map(i=>[i.code,i.location]),[
    ['vat_summary_basis_unverified','周转表.xlsx / 交接结果 / 第2行'],['vat_summary_basis_unverified','交接.md / 第2行']]);
  const clear='见税费底稿。应交增值税本期发生20元，对申报第24栏20元。期末未缴均为-1元。';
  s.getCell('B2').value=clear;
  assert.deepEqual((await check(clear)).issues,[]);
});

test('以主体、期间、唯一栏次、表内名称与账载口径取数，同额错栏保留问题',()=>{
  assert.deepEqual(run().issues,[]);
  assert.deepEqual(run(form,paper.replace('本期应纳,24','本期应纳,27')).issues.map(i=>i.code),['vat_field_binding_mismatch']);
  assert(run(form.replaceAll(period,'2026-10')).issues.some(i=>i.code==='vat_original_required'));
  assert(run(form.replaceAll(name,'其他公司')).issues.some(i=>i.code==='vat_form_scope_unverified'));
  assert(run(form+'\n'+form.split('\n')[1]).issues.some(i=>i.code==='vat_form_field_unverified'));
  assert(run(form.replace('期末未缴税额','本期应纳税额')).issues.some(i=>i.code==='vat_form_field_unverified'));
  const cross=paper.split('\n').map((row,i)=>row+','+(i?'2025-01':'所属期')).join('\n');
  assert.equal(run(form,cross).issues.filter(i=>i.code==='vat_workpaper_period_mismatch').length,4);
  const headers=paper.split('\n')[0];
  const empty=run(form,headers+'\n税种,其他税费');
  assert.equal(empty.coverage.workpapers,0);
  assert(empty.issues.some(i=>i.code==='vat_workpaper_required'));
  assert(run(form,paper+'\n'+headers+'\n'+paper.split('\n')[1]).issues.some(i=>i.code==='vat_workpaper_comparison_missing'));
});
test('分别报告期初和期末差异；传统底稿的发生／余额错配只派一项返工',()=>{
  const bad='税种,所属期,申报应纳,账载计提/期末,说明\n增值税,2026-09,20,21,未交税期末';
  const result=run(form,bad,{...vatLedger,openingMinor:'2100',closingMinor:'2100'});
  assert.equal(result.issues.filter(i=>i.code==='vat_ledger_reconciliation').length,2);
  assert.equal(result.issues.filter(i=>i.code==='vat_field_binding_mismatch').length,1);
  assert(!result.issues.some(i=>i.code==='vat_workpaper_comparison_missing'));
});

test('返工直接定位 CSV 和 Markdown 的物理行，并给出原表和账簿各自的金额',()=>{
  const wrong=paper.replace('本期应纳,24,20,本期应纳,20','本期应纳,24,99,本期应纳,88');
  const csv=run(form,'\n\n'+wrong).issues.find(i=>i.code==='vat_workpaper_value_mismatch');
  assert.match(csv.location,/第4行/);
  assert.deepEqual([csv.actual,csv.expected],['申报 99 元 / 账载 88 元','原表 20.00 元 / 账库 20.00 元']);
  const text=['# 本期税费','','已据原件复算。','',...wrong.split('\n').map(r=>'|'+r.replaceAll(',','|')+'|')].join('\n');
  const result=reviewDeliveryVat({period,enterpriseName:name,vatLedger,
    sources:[{name:'申报原表.csv',bytes:Buffer.from(form)}],files:[{name:'税费底稿.md',bytes:Buffer.from(text)}]});
  assert.match(result.issues[0].location,/税费底稿.md .*第6行/);
});
