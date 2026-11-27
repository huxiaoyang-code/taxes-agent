import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reviewStockInvoiceLinks} from '../server/delivery-stock-invoices.mjs';
import {expensePostings} from '../server/delivery-stock-expense-proof.mjs';

const period='2026-04',date=period+'-06',seller='合成设备商',buyer={name:'合成采购企业',taxpayerId:'BUY1'};
const chart=[['1601','固定资产'],['2202','应付账款'],['220203',seller],['1123','预付账款'],['112305','合成预付账户'],
  ['5602','管理费用'],['560211','维修费'],['180101','待抵扣进项税额'],['22210104','进项税额转出'],
  ['5401','主营业务成本'],['1405','库存商品']].map(([code,name])=>({code,name,scope:{status:'mapped'}}));
const snapshot={period,accounts:chart,profile:{coa:chart}};
const decimal=v=>BigInt(Math.round(Number(v)*100));
const account=(code,debit,credit=0)=>({code,debit:BigInt(debit),credit:BigInt(credit)});
const ledger=(overrides={})=>({status:'posted',date,period,number:9,summary:'购置设备',
  lines:[account('1601',10000),account('180101',1300),account('220203',0,11300)],...overrides});
const bill=(overrides={})=>({票号:'P1',品名:'独立设备',规格:'A4',单位:'个',数量:'1',金额:'70',税额:'9.1',价税合计:'79.1',
  发票状态:'正常',是否正数发票:'是',开票日期:date,销售方名称:seller,购买方名称:buyer.name,购方识别号:buyer.taxpayerId,发票票种:'增值税专用发票',备注:'',...overrides});
const original=[bill(),bill({金额:30,税额:3.9,价税合计:33.9})];
function file(name,rows) {
  const headers=Object.keys(rows[0]);
  return {name,sheets:[{name:'明细',rows:[headers,...rows.map(r=>headers.map(k=>r[k]??''))].map((cells,i)=>({number:i+1,cells}))}]};
}
function check({rows=original,vouchers=[ledger()],mapRow=()=>({}),extra=[],owner=buyer,scope=period}={}) {
  const ordinals=new Map();
  const positions=rows.map((r,index)=>{
    const line=(ordinals.get(r.票号)??0)+1;
    ordinals.set(r.票号,line);
    return {方向:'购进',票号:r.票号,票内行号:line,库存工作表:'—',目标行号:'—',规格:r.规格,单位:r.单位,数量:r.数量,金额:r.金额,
      凭证ID:'31',凭证号:'9',...mapRow(index)};
  });
  const coverage={},issues=[];
  const postings=expensePostings(snapshot,new Map(vouchers.map((v,i)=>[31+i,v])));
  reviewStockInvoiceLinks({files:[file('归属索引.csv',positions)],sources:[file('购进发票明细.csv',rows),...extra],period:scope,
    listSheets:f=>f.sheets,items:[],decimal,display:String,periodChecks:new Set(),coverage,
    issue:(code,owner,at,note)=>issues.push({code,note}),purchaseBuyer:owner,expensePostings:postings});
  return {evidence:coverage.invoiceExpenseEvidence,issues,codes:issues.map(i=>i.code)};
}
test('按整票两行净额和税额分别核已过账资产与待抵扣科目，复验索引凭证定位',()=>{
  const ok=check();
  assert.deepEqual(ok.issues,[]);
  assert.deepEqual(ok.evidence.map(e=>[e.number,e.account,e.netMinor,e.taxMinor,e.sources.length]),[['9','1601','10000','1300',2]]);
  const wrong=check({mapRow:()=>({凭证ID:19})});
  assert.ok(wrong.codes.includes('inventory_invoice_voucher_reference_mismatch'));
  assert.ok(!wrong.codes.includes('inventory_invoice_exclusion_unproved'));
});
test('重复、草稿、跨账期、跨主体、冲突票头、税额组合错误或部分入库均不核销',()=>{
  const mismatchedHeader=file('采购发票基础信息.csv',[{票号:'P1',金额:101,税额:13,价税合计:114}]);
  for(const options of [
    {vouchers:[ledger(),ledger()]},{vouchers:[ledger({status:'draft'})]},{vouchers:[ledger({period:'2026-05'})]},
    {owner:{...buyer,name:'另一采购企业'}},{owner:{...buyer,taxpayerId:'OTHER'}},{extra:[mismatchedHeader]},
    {rows:original.map(r=>({...r,销售方名称:'另一供货商'}))},{rows:[bill({税额:8}),original[1]]},
    {rows:[...original,bill({票号:'P2'})]},{vouchers:[ledger({date:'2026-04-10'})]},
    {vouchers:[ledger({lines:[account('1601',10500),account('180101',800),account('220203',0,11300)]})]},
    {vouchers:[ledger({lines:[account('1601',9500),account('180101',1300),account('1405',500),account('220203',0,11300)]})]},
    {mapRow:i=>i===0?{库存工作表:'商品',目标行号:2}:{}}
  ]){
    const r=check(options);
    assert.equal(r.evidence.length,0);
    assert.ok(r.codes.includes('inventory_invoice_exclusion_unproved'));
  }
});
test('含税费用要求普通票全额及无抵扣冲突；直接成本另问项目分拆',()=>{
  const rows=original.map(r=>({...r,发票票种:'普通发票'}));
  const gross=code=>ledger({lines:[account(code,11300),account('220203',0,11300)]});
  assert.equal(check({rows,vouchers:[gross('560211')]}).evidence[0].basis,'gross');
  assert.equal(check({rows,vouchers:[gross('5401')]}).codes.includes('inventory_invoice_direct_cost_allocation'),true);
  const claims=file('发票用途确认.csv',[{票号:'P1',勾选状态:'已勾选',有效抵扣税额:13}]);
  assert.equal(check({rows,vouchers:[gross('560211')],extra:[claims]}).evidence.length,0);
  assert.equal(check({vouchers:[gross('560211')]}).evidence.length,0);
});
test('红票核全组已过账折让，保留历史成本归属；无蓝票号、退货数量或无调整摘要不采信',()=>{
  const rows=original.map((r,i)=>({...r,票号:'R'+i,是否正数发票:'否',备注:'被红冲蓝字数电发票号码: 12345678901234567890',
    数量:'',金额:-r.金额,税额:-r.税额,价税合计:-r.价税合计}));
  const red=ledger({summary:'前期采购价格折让',lines:[account('5401',-10000),account('22210104',-1300),account('220203',0,-11300)]});
  const result=check({rows,vouchers:[red]});
  assert.deepEqual(result.codes,['inventory_invoice_prior_cost_allocation']);
  assert.equal(result.evidence[0].sources[1].blueInvoice,'12345678901234567890');
  for(const override of [{rows:[{...rows[0],备注:''},rows[1]]},{rows:[{...rows[0],数量:'-1'},rows[1]]},{vouchers:[{...red,summary:'采购'}]}]){
    assert.equal(check({rows,vouchers:[red],...override}).evidence.length,0);
  }
});
test('同凭证两张普通票的预付账户与销方不同，给出扣款流水待核',()=>{
  const rows=original.map((r,i)=>({...r,票号:'P'+i,发票票种:'普通发票',开票日期:i?date:'2026-04-02'}));
  const r=check({rows,vouchers:[ledger({lines:[account('560211',11300),account('112305',0,11300)]})]});
  assert.equal(r.evidence.length,0);
  assert.equal(r.issues.filter(i=>i.note.includes('预付账户流水')).length,2);
});
