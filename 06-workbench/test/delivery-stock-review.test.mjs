import {test} from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {readXlsxStructure} from '../server/offline-invoice-xlsx.mjs';
import {readDeliveryWorkbook} from '../server/delivery-workbook.mjs';
import {reviewInventory} from '../server/delivery-stock-review.mjs';

const columns=['商品编码','品名','规格','单位','期初数量','期初金额','购入数量','购入金额','暂估数量','暂估金额','销售数量','销售成本金额','期末数量','期末金额'];
const item=(id='A')=>[id,'配件'+id,'型号'+id,'件',10,100,5,55,1,12,4,40,12,127];
const asCsv=(name,rows)=>({name,bytes:Buffer.from(rows.map(row=>row.join(',')).join('\n'))});
const original=(rows=[item()])=>asCsv('期初库存.csv',[columns.slice(0,6),...rows.map(row=>row.slice(0,6))]);
async function xlsx(build,name='交付/本月进销存.xlsx') {
  const wb=new ExcelJS.Workbook();
  build(wb);
  return {name,bytes:Buffer.from(await wb.xlsx.writeBuffer())};
}
function flat(wb,rows=[item()],name='分商品明细') {
  const s=wb.addWorksheet(name);
  s.addRows([columns,...rows]);
  return s;
}
const warehouseHeader=['单据号','业务类型','商品编码','品名','规格','单位','数量','金额'];
const stockReceipts=(ids=['A'])=>asCsv('原始收发单.csv',[warehouseHeader,...ids.flatMap(id=>[
  ['P-'+id,'采购入库',id,'配件'+id,'型号'+id,'件',5,55],['T-'+id,'暂估入库',id,'配件'+id,'型号'+id,'件',1,12],['S-'+id,'销售出库',id,'配件'+id,'型号'+id,'件',4,40]])]);
const codes=result=>result.issues.map(issue=>issue.code);
const run=(file,sources=[original()],inventoryMinor='12700',rest=[])=>reviewInventory({files:[file,...rest],sources,inventoryMinor});

test('保存返工工作簿后，标准索引色板及显式空文本单元格不影响库存复算',async()=>{
  const file=await xlsx(w=>flat(w));
  const parts=unzipSync(file.bytes),style='xl/styles.xml',sheet='xl/worksheets/sheet1.xml';
  const stylesheet=strFromU8(parts[style]);
  const palette='<colors><indexedColors><rgbColor rgb="00FFFFFF"/><rgbColor rgb="FF000000"/></indexedColors></colors>';
  parts[style]=strToU8(stylesheet.replace('</styleSheet>',palette+'</styleSheet>'));
  parts[sheet]=strToU8(strFromU8(parts[sheet]).replace('</sheetData>','<row r="3"><c r="A3" t="inlineStr"/></row></sheetData>'));
  const workbook=Buffer.from(zipSync(parts));
  assert.equal(readDeliveryWorkbook(workbook)[0].rows[2].cells[0],null);
  assert.deepEqual(run({...file,bytes:workbook},[original(),stockReceipts()],{opening:10000,debit:6700,credit:4000,closing:12700}).issues,[]);
  parts[style]=strToU8(stylesheet.replace('</styleSheet>',palette.replace('00FFFFFF','非法色值')+'</styleSheet>'));
  assert.throws(()=>readDeliveryWorkbook(zipSync(parts)),/xlsx_structure_unsupported/);
});

test('按字段识别简单进销存，独立核对数量、暂估、分位金额、总账与期初原件',async()=>{
  const wb=await xlsx(w=>{const s=flat(w);s.addRow(['合计',null,null,null,10,100,5,55,1,12,4,40,12,127]);});
  const result=run(wb,[original(),stockReceipts()],{opening:10000,debit:6700,credit:4000,closing:12700});
  assert.deepEqual(result.issues,[]);
  assert.equal(result.coverage.openingRowsMatched,1);
  assert.equal(result.coverage.endingMinor,'12700');
});

test('按合并表头找到数量、金额，完整读取第十张后的工作表及重复品名的不同规格',async()=>{
  const wb=await xlsx(w=>{
    for(let i=0;i<11;i++) w.addWorksheet('附件'+i).addRow(['业务说明']);
    const s=w.addWorksheet('存-零件');
    s.addRows([['序列号','品名+规格','品名','规格','单位','本月无进项收入',null,null,'期初',null,null,'进',null,null,'销',null,null,'存'],
      ['序列号','品名+规格','品名','规格','单位','数量','单价','金额','数量','单价','金额','数量','单价','金额','数量','销售成本','金额','数量','单价','金额'],
      [1,'零件P1','零件','P1','个',1,12,12,9,10,90,2,11,22,3,10,30,9,10.44,94],
      [2,'零件P2','零件','P2','个',null,null,null,1,100,100,null,null,null,null,null,null,1,100,100]]);
    for(const range of ['F1:H1','I1:K1','L1:N1','O1:Q1','R1:T1']) s.mergeCells(range);
  });
  const source=asCsv('期初库存.csv',[['原表','行号','品名','规格','单位','期初数量','期初单价','期初金额'],
    ['存-零件',75,'零件','P1','个',9,10,90],['存-零件',82,'零件','P2','个',1,100,100]]);
  const receipts=asCsv('收发原件.csv',[warehouseHeader,['101','采购入库','','零件','P1','个',2,22],['102','暂估入库','','零件','P1','个',1,12],['103','出库','','零件','P1','个',3,30]]);
  const result=run(wb,[source,receipts],19400);
  assert.deepEqual(result.issues,[]);
  assert.equal(result.coverage.sheetsScanned,12);
  assert.equal(result.coverage.rowsChecked,2);
  assert.throws(()=>readXlsxStructure(wb.bytes,{sheet:'存-零件'}));
});

test('表头位置移动、字段重新排列、非首张商品页和末尾商品行都参与复算',async()=>{
  const count=197, rows=Array.from({length:count},(_,i)=>item(String(i)));
  const wb=await xlsx(w=>{
    w.addWorksheet('说明').addRow(['仅内部说明']);
    const s=w.addWorksheet('产品');
    s.getRow(45).values=[...columns].reverse();
    rows.forEach((r,i)=>s.getRow(i+46).values=[...r].reverse());
    s.getCell('A242').value=125;
  });
  const result=run(wb,[original(rows)],12700n*BigInt(count));
  assert.equal(result.coverage.rowsChecked,count);
  assert.ok(result.issues.some(i=>i.code==='inventory_rollforward_mismatch' && i.location.row===242 && i.expected==='127'));
  assert.ok(codes(result).includes('inventory_ledger_mismatch'));
});

test('无缓存公式阻断，缓存只读且独立复算验出陈旧结果',async()=>{
  const wb=await xlsx(w=>{const s=flat(w);s.getCell('N2').value={formula:'F2+H2+J2-L2'};});
  const cell=readDeliveryWorkbook(wb.bytes)[0].rows[1];
  assert.deepEqual(cell.formulas,[13]);
  assert.equal(cell.cells[13],null);
  assert.ok(codes(run(wb)).includes('inventory_formula_cache_missing'));
  assert.throws(()=>readXlsxStructure(wb.bytes),e=>e.code==='xlsx_formula_unsupported');
  const stale=await xlsx(w=>{const s=flat(w);s.getCell('N2').value={formula:'F2+H2+J2-L2',result:999};});
  assert.ok(codes(run(stale)).includes('inventory_rollforward_mismatch'));
});

test('拒绝部分模板、破损文件、缺原件、期初原件遗漏或重复及同版总账缺失',async()=>{
  const bad=await xlsx(w=>{flat(w);w.addWorksheet('存-另一类').addRows([['品名','期初数量','期末金额'],['货',1,50]]);});
  const result=run(bad,[],null);
  for (const code of ['inventory_layout_unsupported','inventory_opening_source_missing','inventory_ledger_missing']) assert.ok(codes(result).includes(code));
  assert.ok(codes(run({name:'库存.xlsx',bytes:Buffer.from('broken')})).includes('inventory_workbook_unreadable'));
  assert.ok(codes(run(bad,[original([item('B')])])).includes('inventory_opening_row_unproved'));
  assert.ok(codes(run(bad,[original([item(),item()])])).includes('inventory_opening_source_unmatched'));
});

test('原始小数汇总和逐行舍入分别计量，期初金额与来源的小数精度不能用来免除总账差异',async()=>{
  const rows=['A','B','C'].map(id=>{const r=item(id);r[5]=1.23;r[13]=28.23;return r;});
  const source=original(rows.map(r=>{const copy=[...r];copy[5]='1.234';return copy;}));
  const result=run(await xlsx(w=>flat(w,rows)),[source,stockReceipts(['A','B','C'])],8475);
  assert.deepEqual(codes(result),['inventory_ledger_mismatch']);
  assert.equal(result.coverage.sourceOpeningRawAmount,'3.702');
  assert.equal(result.coverage.sourceOpeningRoundedMinor,'370');
  assert.equal(result.coverage.sourceOpeningLineRoundedMinor,'369');
});

test('定位所有派生字段串列，以及明细行缺失、零数量金额和来源异常',async()=>{
  const rows=[item('x'),item('y')];
  Object.assign(rows[0],{4:0,5:1000,6:0,7:0,8:0,9:0,10:0,11:0,12:0,13:1000});
  const wb=await xlsx(w=>flat(w,rows));
  const moved=[...rows[0]];
  moved[1]=moved[2]; moved[2]=moved[3];
  const derived=asCsv('原始底稿引用/库存逐行复算.csv',[columns,moved]);
  const result=run(wb,[original(rows)],112700,[derived]);
  for (const code of ['inventory_zero_quantity_carried_value','inventory_derived_field_mismatch','inventory_derived_row_missing']) assert.ok(codes(result).includes(code));
  const corrected=run(wb,[original(rows)],112700,[asCsv(derived.name,[columns,...rows])]);
  assert.ok(!codes(corrected).some(c=>c.includes('derived')));
});

test('辅助表的期初数不充当交付库存或期初原件，未标明的计算不能默认为零',async()=>{
  const wb=await xlsx(w=>{
    const s=flat(w);s.getCell('I2').value='未核';s.getCell('M2').value=null;s.getCell('N2').value=null;
    w.addWorksheet('待核调整').addRows([['品名','期初数量','期初金额','补记后数量'],['货',1,2,3]]);
  });
  const result=run(wb,[asCsv('库存逐行复算.csv',[columns,item()])]);
  for (const code of ['inventory_opening_source_missing','inventory_closing_values_missing','inventory_number_invalid']) assert.ok(codes(result).includes(code));
  assert.ok(!codes(result).includes('inventory_layout_unsupported'));
});
test('当期同名修订底稿可替代存档，仍引用旧路径及两份冲突的当期底稿均须核对',async()=>{
  const wb=await xlsx(w=>flat(w));
  const wrong=item();wrong[1]='错列';
  const old=asCsv('原始底稿引用/库存逐行复算_09.csv',[columns,wrong]);
  const current=asCsv('库存逐行复算_09_修订版.csv',[columns,item()]);
  assert.deepEqual(run(wb,[original(),old,stockReceipts()],12700,[old,current]).issues,[]);
  const active={name:'交付说明.md',bytes:Buffer.from('本次仍以原始底稿引用/库存逐行复算_09.csv为复算依据。')};
  assert.ok(codes(run(wb,[original()],12700,[old,current,active])).includes('inventory_derived_field_mismatch'));
  assert.ok(codes(run(wb,[original()],12700,[{...old,name:'库存逐行复算_09.csv'},current])).includes('inventory_derived_field_mismatch'));
});
test('逐行取位、期初原件、正式四栏与本期原始收发全可重算，才认定期末同额差有依据',async()=>{
  const ids=['A','B','C'];
  const rows=ids.map(id=>{const r=item(id);r[5]=1.23;r[13]=28.23;return r;});
  const source=original(rows.map(r=>{const copy=[...r];copy[5]='1.234';return copy;}));
  const file=await xlsx(w=>flat(w,rows));
  const docs=[source,stockReceipts(ids)];
  const amounts={opening:370,debit:20100,credit:12000,closing:8470};
  const proved=run(file,docs,amounts);
  assert.deepEqual(proved.issues,[]);
  assert.equal(proved.coverage.explained[0].amountMinor,'1');
  assert.equal(proved.coverage.explained[0].rows,3);
  const partial=run(file,docs,{...amounts,opening:378,closing:8478});
  assert.deepEqual(partial.coverage.explained,[]);
  assert.equal(partial.coverage.openingReconciliation.ledgerMinusRoundedSourceMinor,'8');
  const missingProof=partial.issues.filter(i=>i.code==='inventory_opening_ledger_evidence_required');
  assert.equal(missingProof.length,2);
  assert(missingProof.every(i=>i.owner==='accountant' && i.note.includes('0.08 元')));
  const newMovement=run(file,docs,{...amounts,opening:378,debit:20000,closing:8378});
  assert(newMovement.issues.some(i=>i.code==='inventory_ledger_mismatch' && i.owner==='bookkeeper' && i.location.field.endsWith('期末余额')));
  const unsupported=run(file,[source],amounts);
  assert.deepEqual(unsupported.coverage.explained,[]);
  const turnover=run(file,docs,{...amounts,debit:20130,credit:12030});
  assert.ok(codes(turnover).includes('inventory_ledger_turnover_basis_unverified'));
  assert.deepEqual(turnover.coverage.explained,[]);
});
test('实际单价及原件单价分别核对，无法计算和空白状态不会被数字覆盖',async()=>{
  const h=[...columns,'期初单价','期末单价'];
  const record=['A','配件A','型号A','件',10,100,0,0,0,0,0,0,10,100];
  const originalWithPrice=(price,qty=10)=>asCsv('期初库存.csv',[[...columns.slice(0,6),'期初单价'],['A','配件A','型号A','件',qty,100,price]]);
  const make=(row,opening,closing,format='0.00')=>xlsx(w=>{
    const s=w.addWorksheet('库存');s.addRows([h,[...row,opening,closing]]);
    s.getCell('O2').numFmt=format;s.getCell('P2').numFmt=format;
  });
  let r=run(await make(record,9999,9999),[originalWithPrice(10)],10000);
  assert.equal(r.issues.filter(i=>i.code==='inventory_price_amount_mismatch').length,2);
  assert.ok(codes(r).includes('inventory_opening_price_mismatch'));
  r=run(await make(record,10,10),[originalWithPrice(10)],10000);
  assert.deepEqual(r.issues,[]);
  const fractional=[...record];fractional[4]=3;fractional[12]=3;
  r=run(await make(fractional,33.33,33.33),[originalWithPrice('33.33333333333333',3)],10000);
  assert.deepEqual(r.issues,[]);
  const empty=[...record];empty[4]=empty[12]=0;
  r=run(await make(empty,0,null),[originalWithPrice('#DIV/0!',0)],10000);
  assert.ok(codes(r).includes('inventory_opening_price_state_mismatch'));
});
test('期初必须对上绑定月份，接受有明确日期的上期末承接，来源日期未知须待核',async()=>{
  const r=item();r[6]=r[7]=r[8]=r[9]=r[10]=r[11]=0;r[12]=10;r[13]=100;
  const f=await xlsx(w=>flat(w,[r]));
  const check=async(name,header,data)=>reviewInventory({files:[f],sources:[asCsv(name,[header,data])],period:'2026-09',inventoryMinor:'10000'});
  const oh=columns.slice(0,6), vals=r.slice(0,6);
  assert.ok(codes(await check('2024-01期初库存.csv',oh,vals)).includes('inventory_source_period_conflict'));
  assert.ok(codes(await check('期初库存.csv',oh,vals)).includes('inventory_source_period_unverified'));
  assert.deepEqual((await check('2026-09期初库存.csv',oh,vals)).issues,[]);
  assert.ok(codes(await check('2026-09期初库存.csv',[...oh,'所属月份'],[...vals,'2024-01'])).includes('inventory_source_period_conflict'));
  const prior=[...oh.slice(0,4),'期末数量','期末金额','期末日期'];
  assert.deepEqual((await check('2026-08期末库存.csv',prior,[...vals,'2026-08-31'])).issues,[]);
  assert.ok(codes(await check('2026-08期末库存.csv',prior,[...vals,'2026-08-15'])).includes('inventory_source_period_unverified'));
});
test('未标期间的辅助数量、单价、金额三栏独立复核，零数量不强造零单价',async()=>{
  const check=async(qty,price,amount)=>{
    const sheet=await xlsx(w=>w.addWorksheet('库存').addRows([[...columns,'数量','单价','金额'],[...item(),qty,price,amount]]));
    return run(sheet,[original(),stockReceipts()],12700).issues.filter(i=>i.code==='inventory_auxiliary_price_mismatch');
  };
  assert.deepEqual(await check(4,1.0675,4.27),[]);
  assert.equal((await check(4,1.06,4.27))[0].expected,'1.0675');
  assert.equal((await check(0,0,77))[0].expected,'无法计算');
  assert.deepEqual(await check(0,'无法计算',77),[]);
});
