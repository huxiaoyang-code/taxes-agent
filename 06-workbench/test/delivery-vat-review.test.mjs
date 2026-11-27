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
