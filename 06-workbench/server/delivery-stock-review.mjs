import {createHash} from 'node:crypto';
import {readDeliveryWorkbook} from './delivery-workbook.mjs';
import {parseCsv} from './csv-rows.mjs';
import {checkStockPeriod,reviewStockInvoiceLinks} from './delivery-stock-invoices.mjs';

const clean = value => String(value ?? '').trim();
const header = value => clean(value).normalize('NFKC').replace(/\s+/gu, '').replace(/\((?:元|人民币元)\)$/u, '');
const hasValue = value => clean(value) !== '';
const stockName = name => /库存|进销存|存货|inventory|stock/i.test(name);
const openingName = name => /期初|期前|上期结存|opening/i.test(name);
const derivedName = name => /逐行|复算|重算|复核明细/i.test(name) && stockName(name);
const location = (file, sheet, row) => ({file, ...(sheet && {sheet}), ...(row && {row})});
const labels = {
  id:['商品编码','存货编码','货品编码','物料编码','SKU','sku'], name:['品名','商品名称','存货名称','货品名称','物料名称'],
  spec:['规格','规格型号','型号','商品规格'], unit:['单位','计量单位'], combined:['品名+规格','品名规格'],
  serial:['序号','序列号'], sheet:['原表','库存表','工作表','库存工作表'], line:['行号','Excel行','原表行号'],
};
const groups = {
  opening:['期初','期初库存','期初结存','月初'], purchase:['进','购','购入','购进','进货','入库','采购','采购入库','本期购入','本期入库'],
  estimate:['暂估','暂估入库','本期暂估','本月无进项收入'], sale:['销','销出','销售','销售成本','销售出库','出库','本期出库','发出'],
  closing:['存','结存','期末','期末结存','期末库存','月末','出库后结存'],
};
const groupFor = new Map(Object.entries(groups).flatMap(([key, names]) => names.map(name => [name, key])));
const aliases = new Map(Object.entries(labels).flatMap(([key,names]) => names.map(name => [name,key])));
for (const [group, names] of Object.entries(groups)) {
  for (const prefix of names) {
    for (const [suffix, key] of [['数量','Qty'], ['金额','Amount'], ['成本金额','Amount'], ['单价','Price']]) {
      aliases.set(prefix + suffix, group + key);
    }
  }
}
aliases.set('销售成本', 'saleAmount');
aliases.set('出库成本', 'saleAmount');
const metrics = Object.keys(groups).flatMap(key => [key+'Qty',key+'Amount']);
const required = metrics.filter(key => !key.startsWith('estimate'));
const fieldLabel = key => ({opening:'期初',purchase:'购入',estimate:'暂估',sale:'销售出库',closing:'期末'}[
  key.replace(/Qty|Amount|Price/u,'')] ?? '') + (key.endsWith('Qty') ? '数量' : key.endsWith('Price') ? '单价' : '金额');

// 保留原始期初精度，用十进制整数运算核对逐行取分与全表取分的差额。
const scale = 10n ** 24n;
const centScale = scale / 100n;
function decimal(input) {
  let value = clean(input);
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(value)) value = value.replaceAll(',', '');
  const m = /^([+-]?)(\d{1,20})(?:\.(\d{1,40}))?(?:[Ee]([+-]?\d{1,2}))?$/u.exec(value);
  if (!m) throw Error('inventory_number_invalid');
  const digits = BigInt(m[2] + (m[3] ?? ''));
  const power = 24 + Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (Math.abs(power)>60 || (power<0 && digits % 10n**BigInt(-power) !== 0n)) throw Error('inventory_precision_unsupported');
  return (m[1]==='-' ? -1n : 1n) * (power>=0 ? digits*10n**BigInt(power) : digits/10n**BigInt(-power));
}
function roundedMinor(value) {
  return value < 0n ? -((-value + centScale/2n) / centScale) : (value + centScale/2n) / centScale;
}
function display(value) {
  const unsigned = value < 0n ? -value : value;
  const fraction = String(unsigned % scale).padStart(24, '0').replace(/0+$/u,'');
  return (value<0n?'-':'') + String(unsigned/scale) + (fraction ? '.'+fraction : '');
}
function mapHeader(rows, index) {
  const fields = new Map(), duplicates = [];
  const parent = rows[index-1]?.cells ?? [];
  let group;
  function add(key, column) {
    if (fields.has(key)) duplicates.push(key);
    else fields.set(key,column);
  }
  for (const [col, cell] of rows[index].cells.entries()) {
    const label = header(cell);
    if (hasValue(parent[col])) group = groupFor.get(header(parent[col]));
    const suffix = {数量:'Qty',单价:'Price',销售成本:'Price',金额:'Amount'}[label];
    if (group && suffix) {
      add(group+suffix,col);
      if (suffix === 'Amount') group = undefined;
    } else if (aliases.has(label)) add(aliases.get(label), col);
  }
  return {fields, duplicates};
}
function layout(sheet, opening = false, priorClosing = false) {
  let candidate;
  for (let i=0; i<sheet.rows.length; i++) {
    const {fields,duplicates} = mapHeader(sheet.rows,i);
    if (priorClosing) {
      if (!fields.has('closingQty') || !fields.has('closingAmount')) continue;
      for(const suffix of ['Qty','Amount','Price']) {
        fields.delete('opening'+suffix);
        if(fields.has('closing'+suffix))fields.set('opening'+suffix,fields.get('closing'+suffix));
      }
    }
    if (!(fields.has('id') || fields.has('name'))) continue;
    const count = ['openingQty','openingAmount','closingQty','closingAmount'].filter(key => fields.has(key)).length;
    if (!count) continue;
    const keys = opening ? ['openingQty','openingAmount'] : required;
    const valid = keys.every(key => fields.has(key)) && (opening || fields.has('estimateQty') === fields.has('estimateAmount'));
    if (!candidate || valid) candidate={fields,duplicates,index:i,valid:valid && !duplicates.length};
    if (valid) break;
  }
  return candidate;
}
function keyOf(row) {
  return row.id ? JSON.stringify(['code', row.id]) : JSON.stringify(['item',row.name,row.spec,row.unit]);
}
function keyByText(row) {
  return JSON.stringify([row.name,row.spec,row.unit]);
}
function csvSheet(file) {
  const lines=[];
  const cells=parseCsv(new TextDecoder('utf-8',{fatal:true}).decode(file.bytes), lines);
  return {name:'',rows:cells.map((cells,i)=>({number:lines[i],cells,formulas:[]}))};
}
const abs=n=>n<0n?-n:n;
function priceDetail(row,col) {
  if(col===undefined)return {state:'absent'};
  const raw=clean(row.cells[col]);
  if(!raw)return {state:'blank'};
  let value;
  try {value=decimal(raw);}catch{return {state:'invalid',raw};}
  const format=row.cellFormats?.[col];
  const builtin=new Map([[1,0],[2,2],[3,0],[4,2],[5,0],[6,0],[7,2],[8,2],[37,0],[38,0],[39,2],[40,2]]);
  let places;
  if(typeof format==='number')places=builtin.get(format);
  else if(format && !/^general$/iu.test(format)){
    const pattern=format.split(';')[0].replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./gu,'').trim();
    const m=/^[¥￥$]?\s*[#,0]+(?:\.([0#]+))?\s*$/u.exec(pattern);
    if(m)places=m[1]?.length??0;
  }
  if(format && places===undefined && !/^general$/iu.test(String(format)))return {state:'format',raw};
  // 原值本身保留更多位时也校验该原始精度；常规格式的整数元不自动放宽到整元误差。
  const actual=display(value).split('.')[1]?.length??0;
  // 六位格式可在二位取价后补零。多显示的零不能证明成本实际按六位计价。
  const digits=Math.min(24,Math.max(actual,Math.min(2,places??2)));
  return {state:'value',value,step:scale/10n**BigInt(digits)};
}
function checkPrices(item,issue,source=false) {
  for(const group of source?['opening']:['opening','closing']) {
    const price=item[group+'Price'], qty=item[group+'Qty'], amount=item[group+'Amount'];
    if(price.state==='absent')continue;
    const at={...item.at,field:fieldLabel(group+'Price')};
    if(price.state!=='value'){
      if(qty!==0n || price.state==='format')issue('inventory_price_unverified',source?'accountant':'bookkeeper',at,'有数量的单价缺值、不可计算或显示格式无法解释',price.raw??'空白');
      continue;
    }
    if(qty===0n)continue;
    // 单价取位和金额取分各产生至多半个最小单位，比较全精度乘积。
    const diff=abs(price.value*qty-amount*scale);
    if(diff*2n>abs(qty)*price.step+centScale*scale)issue('inventory_price_amount_mismatch','accountant',at,
      '数量乘单价与金额之差超过单价显示取位和金额取分可解释的范围',display(price.value),display(amount*scale/qty));
  }
}
function readCells(row, fields, at, issue) {
  const item = {at,openingPrice:priceDetail(row,fields.get('openingPrice')),closingPrice:priceDetail(row,fields.get('closingPrice'))};
  for (const key of Object.keys(labels)) item[key] = clean(row.cells[fields.get(key)]);
  const missing = new Set(row.formulas?.filter(col => !hasValue(row.cells[col])) ?? []);
  for (const col of missing) issue('inventory_formula_cache_missing','bookkeeper',{...at,column:col+1},'公式缺少可读的计算结果');
  for (const key of metrics) {
    const col=fields.get(key), raw=row.cells[col];
    if (!hasValue(raw)) { item[key]=0n; continue; }
    try { item[key]=decimal(raw); }
    catch { issue('inventory_number_invalid','bookkeeper',{...at,column:col+1,field:fieldLabel(key)},'按列义无法解析数值',clean(raw)); item[key]=0n; }
  }
  return item;
}
const totalLabels = new Set(['合计','总计','小计']);
function totalRow(row, fields) {
  return ['id','name','combined','serial','spec'].some(key=>totalLabels.has(clean(row.cells[fields.get(key)]))) ||
    totalLabels.has(clean(row.cells.find(hasValue)));
}
function sameValue(issue,code,at,note,actual,expected,owner='bookkeeper') {
  if (actual!==expected) issue(code,owner,at,note,display(actual),display(expected));
}
function scanStock(sheet,file,form,review) {
  const {items, totals, issue, coverage} = review;
  const sums = Object.fromEntries(metrics.map(key=>[key,0n]));
  const countBefore=items.length;
  const {fields,index}=form;
  const headers=sheet.rows[index];
  let finalTotalSeen=false;
  const seen = new Set();
  for (const row of sheet.rows.slice(index+1)) {
    if (!row.cells.some(hasValue) && !row.formulas?.length) continue;
    const at=location(file.name,sheet.name,row.number);
    const item=readCells(row,fields,at,issue);
    if (finalTotalSeen) issue('inventory_data_after_total','bookkeeper',at,'合计行之后仍有数据，请核对表尾与明细范围');
    if (totalRow(row,fields)) {
      const subtotal=row.cells.some(cell=>clean(cell)==='小计');
      if (subtotal) issue('inventory_subtotal_scope_unverified','product',at,'小计分组范围未能独立识别');
      else finalTotalSeen=true;
      const reported = {item};
      totals.push(reported);
      for (const key of metrics) if (hasValue(row.cells[fields.get(key)])) {
        sameValue(issue,'inventory_sheet_total_mismatch',{...at,field:fieldLabel(key)},'与此前商品明细合计核对',item[key],sums[key]);
      }
      continue;
    }
    if (!item.id && !item.name && !item.spec) {
      issue('inventory_row_identity_missing','bookkeeper',at,'有数据的行缺少可辨认的商品'); continue;
    }
    if (!['closingQty','closingAmount'].some(key=>hasValue(row.cells[fields.get(key)]))) issue('inventory_closing_values_missing','bookkeeper',at,'商品行缺少期末数量与金额');
    if (!metrics.some(key=>hasValue(row.cells[fields.get(key)]))) issue('inventory_row_values_missing','bookkeeper',at,'商品行没有数量或金额');
    for (const group of ['opening','purchase','estimate','sale','closing']) {
      const qty=fields.get(group+'Qty'),amount=fields.get(group+'Amount');
      if (qty===undefined) continue;
      if ((!hasValue(row.cells[qty]) && item[group+'Amount']!==0n) || (!hasValue(row.cells[amount]) && item[group+'Qty']!==0n)) {
        issue('inventory_pair_incomplete','bookkeeper',{...at,field:fieldLabel(group+'Amount')},'同组数量与金额需列全');
      }
    }
    if (seen.has(keyOf(item))) issue('inventory_item_ambiguous','accountant',at,'同一工作表内的商品识别字段重复，请提供可区分的编码或原件行号');
    seen.add(keyOf(item));
    checkPrices(item,issue);
    items.push(item);
    for (const key of metrics) sums[key]+=item[key];
    for (const suffix of ['Qty','Amount']) {
      sameValue(issue,'inventory_rollforward_mismatch',{...at,field:fieldLabel('closing'+suffix)},'期初加购入及暂估减销售出库',item['closing'+suffix],item['opening'+suffix]+item['purchase'+suffix]+item['estimate'+suffix]-item['sale'+suffix]);
    }
    if (item.openingQty===0n && item.openingAmount!==0n) issue('inventory_opening_zero_quantity_value','accountant',{...at,field:'期初金额'},'需核实期初计量单位、金额承接和领用依据',display(item.openingAmount));
    if (item.closingQty===0n && item.closingAmount!==0n) {
      const inherited=item.openingQty===0n && item.openingAmount===item.closingAmount;
      issue(inherited?'inventory_zero_quantity_carried_value':'inventory_zero_quantity_residual','accountant',{...at,field:'期末金额'},inherited?'零数量金额自期初沿用，需核实实物和计价依据':'本期结清数量后仍有金额，请核对单位成本精度及出库成本',display(item.closingAmount),'0');
    }
  }
  if (countBefore===items.length) issue('inventory_sheet_empty','bookkeeper',location(file.name,sheet.name,headers.number),'库存表没有可复算的商品行');
  coverage.inventorySheets++;
}
function indexRows(rows, key) {
  const index=new Map();
  for (const row of rows) {
    const value=key(row);
    if (index.has(value)) index.set(value,null);
    else index.set(value,row);
  }
  return index;
}
function compareOpening(review, sources) {
  const {issue,items,coverage}=review;
  if (!sources.length) {issue('inventory_opening_source_missing','accountant',{},'请提供属于本期的期初分商品原件'); return;}
  const byCode=indexRows(items.filter(item=>item.id),item=>item.id);
  const byText=indexRows(items,keyByText);
  const bySheet=indexRows(items,item=>JSON.stringify([item.at.sheet,keyByText(item)]));
  const matched=new Set();
  let rawAmount=0n, rowMinor=0n, everyRowRounded=true, changedRows=0;
  for (const source of sources) {
    rawAmount+=source.openingAmount; rowMinor+=roundedMinor(source.openingAmount);
    const item=source.id ? byCode.get(source.id) : source.sheet ? bySheet.get(JSON.stringify([source.sheet,keyByText(source)])) : byText.get(keyByText(source));
    if (!item || matched.has(item)) {issue('inventory_opening_source_unmatched','accountant',source.at,'原件商品无法唯一对应交付明细');continue;}
    matched.add(item);
    const a=item.openingPrice,b=source.openingPrice;
    if(a.state!=='absent' && b.state!=='absent'){
      if(a.state==='value' && b.state==='value'){
        if(abs(a.value-b.value)*2n>a.step+b.step)issue('inventory_opening_price_mismatch','bookkeeper',{...item.at,field:'期初单价'},'期初单价与原件不符，超过各自取位精度',display(a.value),display(b.value));
      } else if(a.state!==b.state || (a.state==='invalid' && a.raw!==b.raw)){
        issue('inventory_opening_price_state_mismatch','accountant',{...item.at,field:'期初单价'},'原件和交付的单价缺失或无法计算状态不同，需保留原始计量依据',a.state==='value'?display(a.value):a.raw??'空白',b.state==='value'?display(b.value):b.raw??'空白');
      }
    }
    const rounded=roundedMinor(source.openingAmount)*centScale;
    everyRowRounded &&= item.openingAmount===rounded;
    if(source.openingAmount!==rounded) changedRows++;
    for (const key of ['name','spec','unit']) if (source.fields.has(key) && item[key]!==source[key]) {
      issue('inventory_opening_identity_mismatch','bookkeeper',{...item.at,field:key},'期初原件商品字段不同',item[key],source[key]);
    }
    sameValue(issue,'inventory_opening_quantity_mismatch',{...item.at,field:'期初数量'},'与期初原件逐行核对',item.openingQty,source.openingQty);
    if (item.openingAmount!==source.openingAmount && item.openingAmount!==roundedMinor(source.openingAmount)*centScale) {
      issue('inventory_opening_amount_mismatch','bookkeeper',{...item.at,field:'期初金额'},'与原件金额及逐行取分值均不符',display(item.openingAmount),display(source.openingAmount));
    }
  }
  for (const item of items) if (!matched.has(item) && (item.openingQty!==0n || item.openingAmount!==0n)) {
    issue('inventory_opening_row_unproved','accountant',item.at,'交付中有期初余额的商品缺少对应原件');
  }
  coverage.openingRowsMatched=matched.size;
  coverage.openingSourceRows=sources.length;
  coverage.sourceOpeningRawAmount=display(rawAmount);
  coverage.sourceOpeningRoundedMinor=roundedMinor(rawAmount).toString();
  coverage.sourceOpeningLineRoundedMinor=rowMinor.toString();
  coverage.sourceOpeningPrecision={everyRowRounded,changedRows,sourceFiles:[...new Set(sources.map(s=>s.at.file))]};

}
function compareDerived(sheet,file,form,review) {
  const {items,issue,coverage,totals}=review;
  const {fields,index}=form;
  const located = fields.has('sheet') && fields.has('line');
  if ((!located && !fields.has('id')) || !fields.has('name') || !fields.has('spec') || !form.valid) {
    issue('inventory_derived_schema_unsupported','product',location(file.name,sheet.name),'逐行底稿缺少可校验的商品定位或滚动字段');return;
  }
  const byCell=indexRows(items,item=>JSON.stringify([item.at.sheet,item.at.row]));
  const byCode=indexRows(items,item=>item.id);
  const summary=indexRows(totals,t=>JSON.stringify([t.item.at.sheet,t.item.at.row]));
  const seen=new Set();
  for (const row of sheet.rows.slice(index+1)) {
    if (!row.cells.some(hasValue)) continue;
    const at=location(file.name,sheet.name,row.number);
    const record=readCells(row,fields,at,issue);
    const key=JSON.stringify([record.sheet,Number(record.line)]);
    if (totalRow(row,fields)) {
      if (located) {
        const total=summary.get(key);
        if (!total) issue('inventory_derived_total_unmatched','bookkeeper',at,'底稿合计行未对应库存表合计行');
        else sameValue(issue,'inventory_derived_total_mismatch',{...at,field:'期末金额'},'底稿合计与工作簿合计不符',record.closingAmount,total.item.closingAmount);
      }
      continue;
    }
    const item=located?byCell.get(key):byCode.get(record.id);
    if (!item || seen.has(item)) {issue('inventory_derived_row_unmatched','bookkeeper',at,'底稿未唯一对应库存工作表及商品行'); continue;}
    seen.add(item);
    coverage.derivedRowsChecked++;
    const textKeys=['name','spec','unit','serial','id'];
    const shifted=textKeys.filter(k=>fields.has(k) && record[k]!==item[k]);
    if (shifted.length) {
      issue('inventory_derived_field_mismatch','bookkeeper',at,'底稿商品信息与工作簿行错位：'+shifted.map(k=>labels[k][0]).join('、'),shifted.map(k=>record[k]).join(' / '),shifted.map(k=>item[k]).join(' / '));
    }
    for (const key of metrics) if (fields.has(key)) {
      sameValue(issue,'inventory_derived_value_mismatch',{...at,field:fieldLabel(key)},'底稿与对应工作簿单元格不符',record[key],item[key]);
    }
  }
  for (const item of items) if (!seen.has(item)) issue('inventory_derived_row_missing','bookkeeper',item.at,'逐行复算底稿缺少本工作簿商品行');
}
const isReference=file=>/(?:原始底稿|原件|模板|底稿引用|历史存档)[\\/]/u.test(file.name);
const revisionTag=/(?:修订|修正|更正|替代|更新)(?:版|稿|本)?/gu;
function paperFamily(file) {
  return baseName(file.name).replace(/\.(?:xlsx|csv)$/iu,'').replace(revisionTag,'').replace(/[\s_（）()【】[\]－-]/gu,'');
}
function usedReferences(papers,files) {
  const current=papers.filter(p=>!isReference(p.file));
  const instructions=files.filter(f=>!isReference(f) && /\.(?:md|txt)$/iu.test(f.name)).flatMap(f=>f.bytes.toString('utf8').split(/\r?\n/u));
  return papers.filter(p=>{
    if (!isReference(p.file)) return true;
    const normalized=p.file.name.replaceAll('\\','/');
    // 只有唯一、明确标为更正的本期同一份底稿才取代存档；仍被当期说明明确采信的原路径也需核对。
    const replacements=current.filter(c=>paperFamily(c.file)===paperFamily(p.file) && /修订|修正|更正|替代|更新/u.test(baseName(c.file.name)));
    if (replacements.length!==1) return true;
    return instructions.some(line=>line.replaceAll('\\','/').includes(normalized) && /依据|采用|采信|用于|取自/u.test(line) && !/不再|废止|替代|取代|仅供|原依据/u.test(line));
  });
}
const baseName=name=>String(name).split(/[\\/]/u).at(-1);
function explainOpening(ledger,amounts,coverage,issues) {
  const fields=['opening','debit','credit','closing'];
  if(fields.some(k=>!validMinor(ledger[k])) || coverage.sourceOpeningRawAmount===undefined)return false;
  const {opening,debit,credit,closing}=Object.fromEntries(fields.map(k=>[k,BigInt(ledger[k])]));
  const sourceOpening=BigInt(coverage.sourceOpeningRoundedMinor), lineRounded=BigInt(coverage.sourceOpeningLineRoundedMinor);
  const precision=sourceOpening-lineRounded;
  const difference=opening-roundedMinor(amounts.opening);
  coverage.openingReconciliation={
    wholeSourceRoundedMinusLinesMinor:String(precision),ledgerMinusWorkbookMinor:String(difference),
    ledgerMinusRoundedSourceMinor:String(opening-sourceOpening),
  };
  if(!difference || precision!==difference || coverage.openingRowsMatched!==coverage.openingSourceRows ||
    !coverage.sourceOpeningPrecision.everyRowRounded || opening!==sourceOpening || amounts.opening!==lineRounded*centScale ||
    amounts.debit!==debit*centScale || amounts.credit!==credit*centScale || closing!==opening+debit-credit ||
    amounts.closing!==amounts.opening+amounts.debit-amounts.credit || (closing-precision)*centScale!==amounts.closing)return false;
  // 同额抵销、逐行来源不全、本期收发或单价基础待核时，单靠四栏合计仍不能作解释。
  if(issues.some(i=>!i.code.startsWith('inventory_derived_')))return false;
  coverage.explained.push({code:'inventory_opening_line_rounding',amountMinor:String(precision),
    openingLedgerMinor:String(opening),closingLedgerMinor:String(closing),debitMinor:String(debit),creditMinor:String(credit),
    workbookOpeningMinor:String(lineRounded),workbookClosingMinor:String(roundedMinor(amounts.closing)),sourceAmount:coverage.sourceOpeningRawAmount,
    rows:coverage.openingRowsMatched,sourceFiles:coverage.sourceOpeningPrecision.sourceFiles,
    note:'每项期初金额均与原件逐行取分一致；原始精度整体取分等于正式期初，本期正式借贷与收发明细相符，期末沿用同额取位差。'});
  return true;
}
function validMinor(value) {
  return /^-?\d+$/u.test(String(value)) && (typeof value!=='number' || Number.isSafeInteger(value));
}
export function reviewInventory({files=[],sources=[],inventoryMinor=null,period}={}) {
  const issues=[];
  const issue=(code,owner,at,note,actual,expected)=>issues.push({code,owner,location:at,note,...(actual!==undefined&&{actual}),...(expected!==undefined&&{expected})});
  const coverage={explained:[],sheetsScanned:0,inventorySheets:0,rowsChecked:0,openingSourceRows:0,openingRowsMatched:0,derivedRowsChecked:0};
  const periodChecks=new Set();
  const review={items:[],totals:[],issue,coverage};
  const sheetCache=new WeakMap();
  function readTables(file) {
    if (!sheetCache.has(file)) {
      const parsed=/\.csv$/iu.test(file.name)?[csvSheet(file)]:readDeliveryWorkbook(file.bytes);
      sheetCache.set(file,parsed);
    }
    return sheetCache.get(file);
  }
  function loadSheetList(file,report,kind) {
    try {return readTables(file);}
    catch(error) {report('inventory_'+kind+'_unreadable','product',location(file.name),'无法完整读取：'+(error.code ?? error.message));return [];}
  }
  const workbooks=files.filter(file=>/\.xlsx$/iu.test(file.name) && !isReference(file) && !derivedName(baseName(file.name)));
  const derivedSheets=[];
  let stockFiles=0;
  for (const file of workbooks) {
    const named=stockName(baseName(file.name));
    let sheets;
    try {sheets=readTables(file);}
    catch(error) {
      if (named) issue('inventory_workbook_unreadable','product',location(file.name),'无法完整读取：'+(error.code ?? error.message));
      continue;
    }
    let found=0;
    for (const sheet of sheets) {
      coverage.sheetsScanned++;
      const form=layout(sheet);
      if (form?.fields.has('sheet') && form.fields.has('line') && form.fields.has('closingAmount')) {
        derivedSheets.push({sheet,file,form});
        continue;
      }
      if (!form?.valid) {
        if (form && (form.fields.has('closingAmount') || form.fields.has('closingQty') || form.fields.has('purchaseAmount')) || /^(?:存[-_]|库存(?:明细|商品|台账|表)?$|进销存|stock|inventory)/iu.test(sheet.name)) {
          issue('inventory_layout_unsupported','product',location(file.name,sheet.name),'库存工作表的表头不完整或有歧义');
        }
        continue;
      }
      scanStock(sheet,file,form,review);
      found++;
    }
    if (found) stockFiles++;
    if (!found && named) issue('inventory_layout_unsupported','product',location(file.name),'工作簿未找到完整进销存明细表头');
  }
  if (!stockFiles) issue('inventory_workbook_missing','bookkeeper',{},'缺少可复算的最终库存工作簿');
  if (stockFiles>1) issue('inventory_workbook_set_ambiguous','accountant',{},'多个工作簿含库存明细，请识别本期最终的一套明细',String(stockFiles));
  coverage.rowsChecked=review.items.length;
  const sourceRows=[];
  for (const file of sources) {
    const name=baseName(file.name);
    if (!/\.(?:csv|xlsx)$/iu.test(name) || derivedName(name) || /模板|复算|底稿|凭证|余额表|科目|试算/u.test(name)) continue;
    const closingFile=/(?:期末|月末|上期结存)/u.test(name) && !/期初/u.test(name);
    const named=(openingName(name) || closingFile) && stockName(file.name);
    if (!named && /\.xlsx$/iu.test(name) && !stockName(name)) continue;
    const sheets=loadSheetList(file, named?issue:()=>{},'source');
    let recognized=false;
    for (const sheet of sheets) {
      const priorClosing=closingFile && !!period;
      const form=layout(sheet,true,priorClosing);
      if (!form?.valid) continue;
      // 逐行复算与本期结果均不能充作期初原件。
      if (!priorClosing && (form.fields.has('closingAmount') || form.fields.has('purchaseAmount'))) continue;
      recognized=true;
      for (const row of sheet.rows.slice(form.index+1)) {
        if (!row.cells.some(hasValue) || totalRow(row,form.fields)) continue;
        const at=location(file.name,sheet.name,row.number);
        const state=checkStockPeriod({period,file,sheet,row,headers:sheet.rows[form.index].cells,headerNumber:sheet.rows[form.index].number,periodChecks,issue,priorClosing,kind:'期初来源'});
        if(state==='conflict')continue;
        if(state==='unverified')coverage.openingPeriodUnverifiedRows=(coverage.openingPeriodUnverifiedRows??0)+1;
        const source=readCells(row,form.fields,at,issue);
        checkPrices(source,issue,true);
        if (!hasValue(row.cells[form.fields.get('openingQty')]) || !hasValue(row.cells[form.fields.get('openingAmount')])) issue('inventory_opening_source_value_missing','accountant',at,'期初原件缺少数量或金额');
        source.fields=form.fields;
        sourceRows.push(source);
      }
    }
    if (!recognized && named) issue('inventory_opening_schema_unsupported','product',location(file.name),'未能识别期初分商品原件表头');
  }
  compareOpening(review,sourceRows);

  // 历史原件中的旧派生表不参与本次交付裁定。同内容的已交付复算表只核一次。
  const reviewed=new Set();
  for (const file of files) {
    const name=baseName(file.name);
    const named=derivedName(name);
    if (!/\.csv$/iu.test(name) && !(named && /\.xlsx$/iu.test(name))) continue;
    const fingerprint=createHash('sha256').update(file.bytes).digest('hex');
    if (reviewed.has(fingerprint)) continue;
    reviewed.add(fingerprint);
    for (const sheet of loadSheetList(file,named?issue:()=>{},'derived')) {
      const form=layout(sheet);
      if (!named && !form?.valid) continue;
      if (!form) issue('inventory_derived_schema_unsupported','product',location(file.name,sheet.name),'未识别逐行复算底稿表头');
      else derivedSheets.push({sheet,file,form});
    }
  }
  for (const {sheet,file,form} of usedReferences(derivedSheets,files)) compareDerived(sheet,file,form,review);
  const sum=key=>review.items.reduce((total,item)=>total+item[key],0n);
  coverage.endingMinor=roundedMinor(sum('closingAmount')).toString();
  coverage.workbookOpeningMinor=roundedMinor(sum('openingAmount')).toString();
  const ledger=inventoryMinor && typeof inventoryMinor==='object' ? inventoryMinor : {closing:inventoryMinor};
  const amounts={opening:sum('openingAmount'),debit:sum('purchaseAmount')+sum('estimateAmount'),credit:sum('saleAmount'),closing:sum('closingAmount')};
  reviewStockInvoiceLinks({files,sources,items:review.items,listSheets:file=>loadSheetList(file,()=>{},'invoice'),decimal,display,issue,coverage,period,periodChecks});
  const explained=explainOpening(ledger,amounts,coverage,issues);
  const paired=validMinor(ledger.debit) && validMinor(ledger.credit);
  if(paired) {
    const debit=BigInt(ledger.debit),credit=BigInt(ledger.credit),net=debit-credit;
    const stockDebit=roundedMinor(amounts.debit),stockCredit=roundedMinor(amounts.credit),stockNet=stockDebit-stockCredit;
    coverage.movementReconciliation={ledgerDebitMinor:String(debit),ledgerCreditMinor:String(credit),ledgerNetMinor:String(net),
      workbookReceiptsNetMinor:String(stockDebit),workbookIssuesNetMinor:String(stockCredit),workbookNetMinor:String(stockNet)};
    if(net!==stockNet)issue('inventory_ledger_movement_mismatch','bookkeeper',{field:'本期库存净变动'},'购入和暂估减出库所得本期净变动与正式账不符',display(stockNet*centScale),display(net*centScale));
    else if(stockDebit!==debit || stockCredit!==credit)issue('inventory_ledger_turnover_basis_unverified','accountant',{field:'本期借贷毛额及购销净额'},
      '净变动一致，购退、销退及红字可改变借贷毛额；需按单据分解后核验借贷发生额',
      display(stockDebit*centScale)+' / '+display(stockCredit*centScale),display(debit*centScale)+' / '+display(credit*centScale));
  }
  for (const [key,amount] of Object.entries(amounts)) {
    if(paired && (key==='debit' || key==='credit')) continue;
    if (key!=='closing' && ledger[key]===undefined) continue;
    const value=ledger[key];
    if (!validMinor(value)) {
      issue('inventory_ledger_missing','product',{field:'库存商品'},'缺少同版正式账库存商品余额'); continue;
    }
    const ledgerValue=BigInt(value);
    if (key==='closing') coverage.ledgerEndingMinor=ledgerValue.toString();
    if (!explained && roundedMinor(amount)!==ledgerValue) {
      const field={opening:'期初余额',debit:'本期借方',credit:'本期贷方',closing:'期末余额'}[key];
      issue('inventory_ledger_mismatch','bookkeeper',{field:'库存商品'+field},'工作簿合计与同版正式库存账不符；期初原件逐行及整体取分值见复核覆盖记录',display(amount),display(ledgerValue*centScale));
    }
  }
  return {issues,coverage};
}
