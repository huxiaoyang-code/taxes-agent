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
