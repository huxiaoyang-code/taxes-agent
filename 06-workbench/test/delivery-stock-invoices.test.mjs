import assert from 'node:assert/strict';
import {test} from 'node:test';
import ExcelJS from 'exceljs';
import {reviewInventory} from '../server/delivery-stock-review.mjs';

const csv=(name,rows)=>({name,bytes:Buffer.from(rows.map(r=>r.join(',')).join('\n'))});
const h=['商品编码','品名','规格','单位','期初数量','期初金额','购入数量','购入金额','发出数量','出库成本','期末数量','期末金额'];
const opening=csv('分商品期初库存.csv',[h.slice(0,6),['X','商品','X','件',10,100],['Y','商品','Y','件',10,100]]);
const original=(rows,name='九月销项_信息汇总表.csv')=>csv(name,[['数电发票号码','货物或应税劳务名称','规格型号','单位','数量','金额'],...rows]);
const indexHeader=['类型','票号','票内行序','规格','单位','数量','金额','库存工作表','库存行号','映射方式','归属理由'];
const ix=(rows,name='业务票行归属.csv')=>csv(name,[indexHeader,...rows]);
async function workbook() {
  const wb=new ExcelJS.Workbook();
  wb.addWorksheet('货品').addRows([h,['X','商品','X','件',10,100,0,0,2,20,8,80],['Y','商品','Y','件',10,100,0,0,1,10,9,90]]);
  return {name:'库存.xlsx',bytes:Buffer.from(await wb.xlsx.writeBuffer())};
}
async function check(inputs=[],mapping=[]) {
  return reviewInventory({files:[await workbook(),...mapping],sources:[opening,...inputs],inventoryMinor:'17000'});
}
const count=(r,code)=>r.issues.filter(i=>i.code===code).length;
const exactRows=[['I01','商品','X','件',2,88],['I01','商品','Y','件',1,55]];
const exactMap=[['销项','I01',1,'X','件',2,88,'货品',2,'精确匹配',''],['销项','I01',2,'Y','件',1,55,'货品',3,'精确匹配','']];

test('票号与票内行顺序从真实原票重建，数量和票面金额核对，出库成本独立',async()=>{
  const r=await check([original(exactRows)],[ix(exactMap)]);
  assert.deepEqual(r.issues,[]);
  assert.equal(r.coverage.invoiceOriginalLines,2);
  assert.equal(r.coverage.invoiceLinksChecked,2);
});

test('需核对多规格集中、源字段、找不到目标、未解释数量差、缺少索引和部分扫描',async()=>{
  const rows=exactMap.map(v=>[...v]);
  rows[1][8]=2;
  let r=await check([original(exactRows)],[ix(rows)]);
  assert.equal(count(r,'inventory_invoice_many_specs_unverified'),1);
  assert.equal(count(r,'inventory_invoice_stock_qty_difference'),2);
  rows[1][8]=99;rows[0][5]=1;rows[0][4]='盒';
  r=await check([original(exactRows)],[ix(rows)]);
  assert.equal(count(r,'inventory_invoice_target_missing'),1);
  assert.ok(count(r,'inventory_invoice_map_total_mismatch'));
  assert.ok(count(r,'inventory_invoice_map_source_fields'));
  r=await check([original(exactRows)],[ix(rows.slice(0,1))]);
  assert.equal(count(r,'inventory_invoice_line_unmapped'),1);
  assert.equal(count(await check([original(exactRows)]),'inventory_invoice_mapping_missing'),1);
});

test('同票拆分需原件逐项归属确认，别名、排除依据和服务行均可正常复核',async()=>{
  const sales=original([['I02','成套商品','组合-X','件',3,150],['I03','运输服务','', '', '',80],['I04','设备','配套','件',1,95]]);
  const rows=[['销项','I02',1,'组合-X','件',2,100,'货品',2,'按拆分确认单',''],
    ['销项','I02',1,'组合-X','件',1,50,'货品',3,'按拆分确认单',''],
    ['销项','I03',1,'','','',80,'—','—','排除','运输服务'],
    ['销项','I04',1,'配套','件',1,95,'—','—','排除','客户自用固定资产']];
  const confirmation=csv('客户签认分配及排除.csv',[['类型','票号','票内行','原票规格','库存规格','单位','目标工作表','目标行号','分配数量','处理类型','依据','确认状态'],
    ['销项','I02',1,'组合-X','X','件','货品',2,2,'拆分','装箱清单第12行','已确认'],
    ['销项','I02',1,'组合-X','Y','件','货品',3,1,'拆分','装箱清单第13行','已确认'],
    ['销项','I04',1,'配套','','件','','','','排除','固定资产验收单18号','已确认']]);
  const good=await check([sales,confirmation],[ix(rows)]);
  assert.deepEqual(good.issues,[]);
  const bad=await check([sales],[ix(rows),confirmation]);
  assert.equal(count(bad,'inventory_invoice_split_unproved'),1);
  assert.equal(count(bad,'inventory_invoice_exclusion_unproved'),1);
  assert.equal(count(bad,'inventory_invoice_spec_unverified'),2);
});

test('型号别名和计量单位换算须匹配原件及目标，索引里自写说明不替代确认',async()=>{
  const sales=original([['I01','商品','型号X','包',1,88],exactRows[1]]);
  const mapped=exactMap.map(v=>[...v]);Object.assign(mapped[0],{3:'型号X',4:'包',5:1,9:'别名换算'});
  const proof=csv('型号别名与单位转换.csv',[['原票规格','原表规格','单位','库存单位','换算系数','映射类型','依据'],
    ['型号X','X','包','件',2,'型号别名','客户包装及物料卡7号']]);
  assert.deepEqual((await check([sales,proof],[ix(mapped)])).issues,[]);
  assert.equal(count(await check([sales],[ix(mapped)]),'inventory_invoice_unit_unverified'),1);
});

test('有独立出库单即可复核无发票销售，仅附票头或未支持的发票原件时明确缺证',async()=>{
  assert.equal(count(await check(),'inventory_flow_source_missing'),2);
  const goods=csv('客户销售出库单.csv',[['单号','商品编码','规格','单位','实发数量','成本金额'],['R-1','X','X','件',2,20],['R-2','Y','Y','件',1,10]]);
  assert.deepEqual((await check([goods])).issues,[]);
  assert.equal(count(await check([csv('销售发票基础信息.csv',[['票号','金额'],['Q',199]])]),'inventory_invoice_lines_missing'),1);
  assert.equal(count(await check([{name:'发票/新购销票.ofd',bytes:Buffer.from('synthetic')}]),'inventory_invoice_binary_unverified'),1);
});

test('原票的唯一商品编码冲突须保留，即使规格与单位完全一致',async()=>{
  const o=csv('销售发票明细.csv',[['票号','品名','商品编码','规格','单位','数量','金额'],
    ['I01','商品','Y','X','件',2,88],['I01','商品','X','Y','件',1,55]]);
  const result=await check([o],[ix(exactMap)]);
  assert.equal(count(result,'inventory_invoice_sku_conflict'),2);
});
test('仓单匹配库存仍须核验发票的数量，发票匹配库存仍须核验仓单的数量',async()=>{
  const invoice=original([['I01','商品','X','件',20,88],exactRows[1]]);
  const rows=exactMap.map(r=>[...r]);rows[0][5]=20;
  const wh=['单号','业务类型','商品编码','单位','数量','金额'];
  const docs=q=>csv('出库原件.csv',[wh,['R1','出库','X','件',q,20],['R2','出库','Y','件',1,10]]);
  let r=await check([invoice,docs(2)],[ix(rows)]);
  const stockDifference=r.issues.find(i=>i.code==='inventory_invoice_stock_qty_difference');
  assert.equal(stockDifference.actual,'20');assert.equal(stockDifference.expected,'2');
  r=await check([original(exactRows),docs(20)],[ix(exactMap)]);
  assert.equal(count(r,'inventory_warehouse_quantity_difference'),1);
});
test('跨期原票、仓单及文件与实际业务日期冲突不可据以核销当期收发',async()=>{
  const file=await workbook();
  const scoped={...opening,name:'2026-09期初库存.csv'};
  const sales=csv('2026-09销售发票.csv',[['票号','商品名称','规格','单位','数量','金额','开票日期'],
     ['I01','商品','X','件',2,88,'2025-09-03'],['I02','商品','Y','件',1,55,'2026-09-06']]);
  const warehouse=csv('2026-09出库单.csv',[['单号','商品编码','单位','数量','金额','出库日期'],['S1','X','件',2,20,'2026-08-31']]);
  const r=reviewInventory({files:[file,ix(exactMap)],sources:[scoped,sales,warehouse],period:'2026-09',inventoryMinor:17000});
  assert.equal(count(r,'inventory_source_period_conflict'),2);
  assert.equal(r.coverage.invoiceOriginalLines,1);
  assert.equal(r.coverage.warehouseItemGroups,0);
});

const purchaseHeaders=['票号','品名','规格','单位','数量','金额','税额','价税合计','税率','税收分类编码','订单号','发票状态','是否正数发票','销方名称','开票日期','发票票种','购买方名称','购方识别号','备注','销方识别号'];
const goods=['P01','*用具*水壶','X','件',2,100,13,113,'13%','T1','PO123','正常','是','合成供应商','2026-09-01','数电发票（普通发票）','合成采购商','BUY01'];
const discount=[...goods];
Object.assign(discount,{2:'',3:'',4:'',5:-20,6:-2.6,7:-22.6});
const goodsMap=['进项','P01',1,'X','件',2,100,'货品',2,'精确匹配',''];
const discountMap=['进项','P01',2,'','','',-20,'货品',2,'同票金额调整',''];
async function purchaseCheck({rows=[goods,discount],map=[goodsMap,discountMap],amount=80,qty=2,postings=[],extra=[]}={}){
  const wb=new ExcelJS.Workbook();
  wb.addWorksheet('货品').addRows([h,['X','商品','X','件',10,100,qty,amount,0,0,10+qty,100+amount],
    ['Y','商品','Y','件',10,100,0,0,0,0,10,100]]);
  return reviewInventory({files:[{name:'库存.xlsx',bytes:Buffer.from(await wb.xlsx.writeBuffer())},ix(map)],
    sources:[opening,csv('原件/进项发票明细.csv',[purchaseHeaders,...rows]),...extra],
    inventoryMinor:{closing:(200+amount)*100,purchasePostings:postings,purchaseBuyer:{name:'合成采购商',taxpayerId:'BUY01'}}});
}
test('原票的同票唯一货品、订单及价税均可核对时，负行只减少成本',async()=>{
  const r=await purchaseCheck({map:[discountMap,goodsMap]});
  assert.deepEqual(r.issues,[]);
  assert.equal(r.coverage.invoiceDiscountEvidence[0].netCost,'80');
  assert.equal(count(await purchaseCheck({amount:100}),'inventory_purchase_amount_unreconciled'),1);
  for(const [index,value] of [[1,'另一货物'],[7,-24],[10,'PO124'],[10,''],[12,'否']]){
    const other=[...discount];other[index]=value;
    const bad=await purchaseCheck({rows:[goods,other]});
    assert.equal(count(bad,'inventory_invoice_adjustment_unverified'),1);
    assert.equal(bad.coverage.invoiceDiscountEvidence.length,0);
  }
  const duplicate=await purchaseCheck({rows:[goods,discount,goods]});
  assert.equal(count(duplicate,'inventory_invoice_adjustment_unverified'),1);
  for(const fields of [{13:''},{16:'另一家企业'},{17:'OTHER01'}]){
    const foreignRows=[goods,discount].map(row=>Object.assign([...row],fields));
    assert.equal(count(await purchaseCheck({rows:foreignRows}),'inventory_invoice_adjustment_unverified'),1);
  }
  const differentTicket=[...discount],differentMap=[...discountMap];
  differentTicket[0]='P02';Object.assign(differentMap,{1:'P02',2:1});
  assert.equal(count(await purchaseCheck({rows:[goods,differentTicket],map:[goodsMap,differentMap]}),'inventory_invoice_adjustment_unverified'),1);
  for(const overrides of [{8:3},{7:'—',8:'—'},{5:1},{5:'金额行'},{6:-19}]){
    const wrong=Object.assign([...discountMap],overrides);
    assert.equal(count(await purchaseCheck({map:[goodsMap,wrong]}),'inventory_invoice_discount_target_unverified'),1);
  }
  const labelled=Object.assign([...discount],{1:'折扣'});
  const excluded=Object.assign([...discountMap],{7:'—',8:'—'});
  assert.equal(count(await purchaseCheck({rows:[goods,labelled],map:[goodsMap,excluded],amount:100}),'inventory_invoice_exclusion_unproved'),1);
  const alias=[...goods];alias[2]='来源别名';
  const mappedAlias=[...goodsMap];mappedAlias[3]=alias[2];
  assert.equal(count(await purchaseCheck({rows:[alias,discount],map:[mappedAlias,discountMap]}),'inventory_invoice_spec_unverified'),1);
  const returned=Object.assign([...discount],{2:'X',3:'件',4:-1});
  const returnMap=Object.assign([...discountMap],{3:'X',4:'件',5:-1});
  const actualReturn=await purchaseCheck({rows:[goods,returned],map:[goodsMap,returnMap],qty:1});
  assert.deepEqual(actualReturn.issues,[]);
  assert.equal(actualReturn.coverage.invoiceDiscountEvidence.length,0);
});
test('普通票含税成本需按供应商、日期及金额唯一对应账载购入与不抵扣摘要',async()=>{
  const v={voucherId:11,date:'2026-09-01',seller:'合成供应商',grossMinor:'11300',summary:'采购水壶（普通发票，税额不抵扣）'};
  const args={rows:[goods],map:[goodsMap],amount:113,postings:[v]};
  const good=await purchaseCheck(args);
  assert.deepEqual(good.issues,[]);
  assert.equal(good.coverage.invoicePurchaseCostEvidence[0].voucherId,11);
  const otherInvoice=Object.assign([...goods],{0:'P02'});
  const claims=csv('用途确认.csv',[['票号','勾选状态','有效抵扣税额'],['P01','已勾选',13]]);
  for(const override of [{postings:[]},{postings:[v,v]},{postings:[{...v,date:'2026-09-02'}]},
    {postings:[{...v,seller:'其他供应商'}]},{postings:[{...v,summary:'采购水壶'}]},
    {postings:[{...v,summary:'采购货架，税额不抵扣'}]},{rows:[goods,otherInvoice]},
    {rows:[Object.assign([...goods],{7:114})]},{rows:[Object.assign([...goods],{15:'增值税专用发票'})]},
    {rows:[Object.assign([...goods],{16:'其他采购商'})]},{rows:[Object.assign([...goods],{17:'BUY02'})]},{extra:[claims]}]){
    const r=await purchaseCheck({...args,...override});
    assert.equal(count(r,'inventory_purchase_amount_unreconciled'),1);
    assert.equal(r.coverage.invoicePurchaseCostEvidence.length,0);
  }
  const noTax=await purchaseCheck({...args,amount:100});
  assert.equal(count(noTax,'inventory_purchase_amount_unreconciled'),1);
});

test('全额红冲的蓝票折扣由明确引用的唯一红票核对，另验实际收退资料',async()=>{
  const blueNo='26000000000000008801',redNo='26000000000000008803';
  const line=(r,fields)=>Object.assign([...r],fields);
  const blueGoods=line(goods,{0:blueNo,11:'已红冲-全额',14:'2026-09-01 10:00:00',19:'SELL01'});
  const blueDiscount=line(discount,{0:blueNo,11:'已红冲-全额',14:blueGoods[14],19:'SELL01'});
  const red=line(blueGoods,{0:redNo,4:-2,5:-80,6:-10.4,7:-90.4,11:'正常',12:'否',14:'2026-09-03',
    18:`被红冲蓝字数电发票号码: ${blueNo} 对应正数发票号码:${blueNo}`});
  const redMap=line(goodsMap,{1:redNo,5:-2,6:-80});
  const map=[redMap,line(discountMap,{1:blueNo}),line(goodsMap,{1:blueNo})];
  const checkRed=(rows,opts={})=>purchaseCheck({rows,map,qty:0,amount:0,...opts});
  const r=await checkRed([red,blueGoods,blueDiscount]);
  assert.deepEqual(r.issues.map(i=>i.code),['inventory_invoice_reversal_warehouse_unverified']);
  assert.deepEqual(r.coverage.invoiceDiscountEvidence[0].reversal,{blueInvoice:blueNo,invoice:redNo,
    source:{file:'原件/进项发票明细.csv',row:2},quantity:'-2',amount:'-80',tax:'-10.4',gross:'-90.4',netAfterReversal:'0'});
  for(const edits of [{18:''},{18:'金额相等并已冲销'},{18:red[18].replace('对应正数发票号码:'+blueNo,'对应正数发票号码:12345678')},
    {4:-1},{5:-40,6:-5.2,7:-45.2},{6:-10.3,7:-90.3},{7:-90.41},{11:'作废'},{12:'是'},
    {13:'另一个供应商'},{16:'第三方购货人'},{19:'SELL02'},{8:'9%'},{9:'T2'},{2:'不同规格'},{3:'包'},
    {14:'2026-08-31'},{14:'2026-10-01'},{14:'2026-09-01 08:00:00'}]){
    const failed=await checkRed([blueGoods,blueDiscount,line(red,edits)]);
    assert.equal(failed.coverage.invoiceDiscountEvidence.length,0);
    assert.equal(count(failed,'inventory_invoice_adjustment_unverified'),1);
  }
  for(const rows of [[blueGoods,blueDiscount,red,line(red,{0:'26000000000000009999'})],
    [blueGoods,blueDiscount,red,red],[line(blueGoods,{11:'已红冲-部分'}),line(blueDiscount,{11:'已红冲-部分'}),red]]){
    assert.equal((await checkRed(rows)).coverage.invoiceDiscountEvidence.length,0);
  }
  const misplaced=await checkRed([blueGoods,blueDiscount,red],{map:[line(redMap,{8:3}),...map.slice(1)]});
  assert.equal(count(misplaced,'inventory_invoice_discount_target_unverified'),1);
  const header=['单号','业务类型','规格','单位','数量','成本金额','关联发票号码'];
  const receipt=['R1','采购收货','X','件',2,80,blueNo],back=['R2','采购退货','X','件',2,80,redNo];
  const withDocs=docs=>checkRed([red,blueGoods,blueDiscount],{extra:[csv('仓库收发原件.csv',[header,...docs])]});
  assert.deepEqual((await withDocs([receipt,back])).issues,[]);
  for(const docs of [[receipt],[line(receipt,{6:'另一张票'}),back],[receipt,line(back,{0:'R1'})]]){
    assert.equal(count(await withDocs(docs),'inventory_invoice_reversal_warehouse_unverified'),1);
  }
});
