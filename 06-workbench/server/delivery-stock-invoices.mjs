// 独立读取原票和交付索引，票面销售额只与索引核对，库存销售金额是结转成本。
import {expenseEvidence,reviewExpenseMappings} from './delivery-stock-expense-proof.mjs';
const txt=value=>String(value??'').trim();
const norm=value=>txt(value).normalize('NFKC').toUpperCase().replace(/\s+/gu,'');
const base=name=>name.split(/[\\/]/u).at(-1);
const invoiceDirection=s=>/销项|销售|销货|出库/u.test(s)?'sale':/进项|购进|采购|购货|购入|入库/u.test(s)?'purchase':'';
const numbered=['数电发票号码','发票号码','票号','发票号'];
const lineNames=['票内行序','票内行号','票内行','发票行号','票面行号'];
const sheetNames=['库存工作表','库存表','目标工作表','目标库存表'];
const targetLines=['库存行号','库存行','目标行','目标行号'];
const specNames=['票面规格','原票规格','规格型号','商品规格','规格'];
const skuNames=['商品编码','存货编码','SKU'];
const qtyNames=['数量','票面数量','原票数量'];
const unitNames=['单位','票面单位','计量单位'];
const amountNames=['金额','不含税金额','票面金额'];
const basisNames=['依据','证据','原件依据','归属理由','确认依据','业务依据','证明编号'];
const kindNames=['处理类型','映射方式','映射类型','处理','结论'];
const ticket=(side,number,line)=>JSON.stringify([side,number,line]);
const cell=(sheet,row)=>JSON.stringify([sheet,Number(row)]);
function get(cells,h,names) {
  for(const name of names) {
    const value=txt(cells[h.indexOf(norm(name))]);
    if(value) return value;
  }
  return '';
}
function headerRow(sheet,pick) {
  for(const [index,row] of sheet.rows.entries()) {
    const h=row.cells.map(norm);
    const has=names=>names.some(n=>h.includes(norm(n)));
    if(pick(has)) return {index,h};
  }
}
const at=(file,sheet,row)=>({file:file.name,...(sheet.name&&{sheet:sheet.name}),row:row.number});
const indexed=(map,key,value)=>{const group=map.get(key)??[];group.push(value);map.set(key,group);};
const positiveLine=value=>/^[1-9]\d{0,8}$/u.test(value);
const maybeTarget=value=>!!value && !/^[-—–/无]+$/u.test(value);
function readNum(parse,value,optional=false) {
  if(!value && optional) return null;
  try{return parse(value);}catch{return null;}
}
const periodCols=['期间','所属期','所属期间','所属月份','会计期间','账期','月份','业务日期','日期','单据日期','发生日期','记账日期','开票日期','入库日期','出库日期','收货日期','发货日期','期初日期','期末日期','结存日期','盘点日期','截止日期'];
const dateMatch=/(?<!\d)((?:19|20)\d{2})(?:[-/.年_](\d{1,2})(?:月|(?=[-/.日\D]|$))|([01]\d)(?=\d{2}(?!\d)|(?!\d)))/gu;
function explicitPeriods(value) {
  const result=[];
  const normalized=value.normalize('NFKC').replace(/(\d{4}年)(十一|十二|十|[一二三四五六七八九])月/gu,(_all,y,m)=>y+(cnMonths.indexOf(m)+1)+'月');
  for(const m of normalized.matchAll(dateMatch)){
    const month=Number(m[2]??m[3]);
    result.push(month>=1 && month<=12 ? m[1]+'-'+String(month).padStart(2,'0') : '无效月份');
  }
  return result;
}
const cnMonths=['一','二','三','四','五','六','七','八','九','十','十一','十二'];
function monthHints(s) {
  return [...s.matchAll(/(?<![\d一二三四五六七八九十])(1[012]|0?[1-9]|十一|十二|十|[一二三四五六七八九])月/gu)]
    .map(m=>Number(m[1]) || cnMonths.indexOf(m[1])+1);
}
export function previousStockPeriod(period) {
  const [year,month]=period.split('-').map(Number);
  return month===1 ? (year-1)+'-12' : year+'-'+String(month-1).padStart(2,'0');
}
function numericExcelDate(raw,format,date1904) {
  const date=typeof format==='number' ? format>=14 && format<=17 || format===22 : /[ymd]/iu.test((format??'').replace(/"[^"]*"/gu,''));
  if(!date || !/^\d{1,5}(?:\.\d+)?$/u.test(raw))return null;
  const serial=Math.floor(Number(raw));
  if(!date1904 && serial===60)return null;
  return new Date(Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:serial<60?31:30)+serial*86400000).toISOString().slice(0,10);
}
function invoiceDate(row,headers,sheet) {
  const i=headers.indexOf('开票日期'),raw=txt(row.cells[i]);
  const value=numericExcelDate(raw,row.cellFormats?.[i],sheet.date1904)??raw.normalize('NFKC');
  const day=/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:$|[T\s])/u.exec(value)??/^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if(!day)return '';
  return [day[1],day[2].padStart(2,'0'),day[3].padStart(2,'0')].join('-');
}
export function checkStockPeriod({period,file,sheet,row,headers,issue,headerNumber,periodChecks,priorClosing=false,kind='业务单据'}) {
  if(!period)return 'unchecked';
  const expected=priorClosing?previousStockPeriod(period):period;
  const label=base(file.name)+' '+sheet.name;
  const dates=explicitPeriods(label);
  const months=monthHints(label);
  const folders=file.name.split(/[\\/]/u).slice(0,-1);
  for(const folder of folders){
    if(/^(?:账期|会计期间|所属期)?(?:19|20)\d{2}(?:年|[.-])?\d{1,2}月?$/u.test(folder))dates.push(...explicitPeriods(folder));
    if(/^(?:19|20)\d{2}年?$/u.test(folder) && months.length===1)dates.push(folder.slice(0,4)+'-'+String(months[0]).padStart(2,'0'));
  }
  let invalid=false, rowDated=false;
  for(const [i,key] of headers.entries()){
    if(!periodCols.includes(txt(key)))continue;
    const raw=txt(row.cells[i]);
    if(!raw)continue;
    rowDated=true;
    const value=numericExcelDate(raw,row.cellFormats?.[i],sheet.date1904)??raw;
    const periods=explicitPeriods(value);
    if(!periods.length) invalid=true;
    dates.push(...periods);
    const day=/^(\d{4})[-/.年]?(\d{2}|\d(?=月))[-/.月]?(\d{1,2})日?(?:$|T|\s)/u.exec(value);
    if(day){
      const [y,m,d]=day.slice(1).map(Number),last=new Date(Date.UTC(y,m,0)).getUTCDate();
      if(d<1 || d>last || (priorClosing && d!==last))invalid=true;
    }
  }
  const known=dates.length>0;
  const matches=dates.every(d=>d===expected) && months.every(m=>m===Number(expected.slice(-2)));
  if(known && matches && !invalid)return 'verified';
  const state=!matches?'conflict':'unverified';
  const pos=at(file,sheet,rowDated?row:{number:headerNumber});
  const group=JSON.stringify([file.name,sheet.name,kind,pos.row]);
  if(periodChecks?.has(group))return state;
  periodChecks?.add(group);
  issue(!matches?'inventory_source_period_conflict':'inventory_source_period_unverified','accountant',pos,
    kind+(priorClosing?'须能证实为绑定月份的上期期末':'须能证实属于本期')+'，请核对文件标注与原始业务日期',dates.join(' / ') || '未见完整年月',expected);
  return state;
}
function collectSources({sources,listSheets,decimal,issue,period,periodChecks}) {
  const originals=new Map(), proof=[], summary=new Set(), seen=new Set(), binaryOriginals=[], deductionClaims=new Set(),purchaseHeaders=new Map();
  for(const file of sources) {
    if(!/\.(csv|xlsx)$/iu.test(file.name)) {
      if(/\.(pdf|ofd|xml|xls)$/iu.test(file.name) && /发票|原票|[进销]项票/u.test(file.name) && !/申报表|申报底稿/u.test(file.name))binaryOriginals.push(file);
      continue;
    }
    const name=base(file.name);
    if(/模板|复算|逐行重算|旧稿/u.test(name)) continue;
    const isProof=/别名|映射|分配|拆分|豁免|排除|签认|对应|转换/u.test(name);
    if(!isProof && /原字段日期|余额表|凭证|分类编码/u.test(name)) continue;
    const hinted=invoiceDirection(name);
    const sheets=listSheets(file);
    if(!sheets.length && hinted && /发票|销项|进项/u.test(name)) summary.add(hinted);
    for(const sheet of sheets) {
      const doc=name+'/'+sheet.name;
      const uses=headerRow(sheet,has=>has(numbered) && has(['勾选状态']) && has(['有效抵扣税额']));
      if(uses) {
        for(const row of sheet.rows.slice(uses.index+1)) {
          const g=names=>get(row.cells,uses.h,names);
          if(g(['勾选状态'])==='已勾选' || readNum(decimal,g(['有效抵扣税额']))>0n)deductionClaims.add(g(numbered));
        }
        continue;
      }
      if(/用途确认/u.test(name))continue;
      const confirm=headerRow(sheet,has=>has(basisNames) && (has(['原表规格','库存规格','目标规格','业务票规格/票号']) || has(kindNames) && has(numbered)));
      if(confirm && (isProof || /确认|别名|分配|对应/u.test(sheet.name))) {
        for(const row of sheet.rows.slice(confirm.index+1)) {
          const g=names=>get(row.cells,confirm.h,names);
          const evidence=g(basisNames),kind=g(kindNames),status=g(['确认状态','状态','核签','审核状态']);
          if(!evidence || /待核|待确认|未确认|未核签|未签|假设|疑似/u.test([kind,status,evidence].join(' '))) continue;
          proof.push({kind,side:invoiceDirection(g(['类型','方向','购销类型'])),number:g(numbered),line:g(lineNames),
            original:g(['业务票规格/票号','票面规格','原票规格','原规格','发票规格']),target:g(['原表规格','库存规格','目标规格']),
            sheet:g(sheetNames),row:g(targetLines),unit:g(unitNames),targetUnit:g(['目标单位','库存单位']),
            allocated:readNum(decimal,g(['分配数量','拆分数量','映射数量']),true),factor:readNum(decimal,g(['换算系数','单位换算倍数']),true),at:at(file,sheet,row)});
        }
        continue;
      }
      if(isProof || /底稿|测试依据|复核|映射|索引/u.test(doc) || /发票基础信息|票头/u.test(name)) {
        if(!isProof && /发票基础信息|票头/u.test(name) && hinted){
          summary.add(hinted);
          const header=hinted==='purchase' && headerRow(sheet,has=>has(numbered) && has(amountNames) && has(['税额']) && has(['价税合计']));
          if(header)for(const row of sheet.rows.slice(header.index+1)){
            const g=names=>get(row.cells,header.h,names),number=g(numbered);
            if(number)indexed(purchaseHeaders,number,{amount:readNum(decimal,g(amountNames),true),tax:readNum(decimal,g(['税额']),true),
              gross:readNum(decimal,g(['价税合计']),true),seller:g(['销方名称','销售方名称']),buyer:g(['购方名称','购买方名称']),
              buyerId:g(['购方识别号','购买方纳税人识别号']),sellerId:g(['销方识别号','销售方纳税人识别号']),status:g(['发票状态','状态']),
              date:invoiceDate(row,header.h,sheet)});
          }
        }
        continue;
      }
      const form=headerRow(sheet,has=>has(numbered) && has(qtyNames) && has(unitNames) && (has(specNames) || has(skuNames) || has(['货物或应税劳务名称','商品名称','品名'])) && !has(targetLines));
      if(!form) {
        if(hinted && /汇总表|票行|发票明细/u.test(doc)) summary.add(hinted);
        continue;
      }
      const counters=new Map();
      for(const row of sheet.rows.slice(form.index+1)) {
        if(!row.cells.some(v=>txt(v)))continue;
        const g=names=>get(row.cells,form.h,names), number=g(numbered);
        const side=invoiceDirection(g(['类型','方向','购销类型','业务方向'])) || invoiceDirection(doc);
        if(!side && !hinted && !/发票|原票/u.test(doc))continue;
        const pos=at(file,sheet,row);
        if(['conflict','unverified'].includes(checkStockPeriod({period,file,sheet,row,headers:form.h,headerNumber:sheet.rows[form.index].number,periodChecks,issue,kind:'购销原票'})))continue;
        if(!number || !side){issue('inventory_invoice_identity_unverified','accountant',pos,'原票明细缺票号或购销方向');continue;}
        const ordinal=(counters.get(side+number)??0)+1;counters.set(side+number,ordinal);
        const line=g(lineNames)||String(ordinal);
        if(!positiveLine(line)){issue('inventory_invoice_line_invalid','accountant',pos,'不能唯一定位票内行');continue;}
        const key=ticket(side,number,line);
        const product=g(['货物或应税劳务名称','商品名称','品名','货物名称']),qty=g(qtyNames),net=g(amountNames);
        const item={key,side,number,line,product,unit:g(unitNames),spec:g(specNames),sku:g(skuNames),qty:readNum(decimal,qty,true),amount:readNum(decimal,net,true),status:g(['发票状态','状态']),at:pos};
        Object.assign(item,{quantityBlank:qty==='',positive:g(['是否正数发票']),order:g(['订单号','订单编号','备注']),
          taxCode:g(['税收分类编码']),rate:g(['税率']),tax:readNum(decimal,g(['税额']),true),gross:readNum(decimal,g(['价税合计']),true),
          buyer:g(['购买方名称','购方名称']),buyerId:g(['购方识别号','购买方纳税人识别号']),
          seller:g(['销方名称','销售方名称','销售方纳税人名称']),sellerId:g(['销方识别号','销售方纳税人识别号']),
          date:invoiceDate(row,form.h,sheet),invoiceType:g(['发票票种','票种'])});
        if((qty && item.qty===null) || (net && item.amount===null))issue('inventory_invoice_source_value_invalid','accountant',pos,'原票数量或金额无法解析');
        if(originals.has(key)) {
          const previous=originals.get(key);
          if(Object.keys(item).some(k=>k!=='at' && previous[k]!==item[k])) {
            previous.conflict=true;
            issue('inventory_invoice_source_conflict','accountant',pos,'同票同行的两份原件记录冲突');
          }
        } else originals.set(key,item);
        seen.add(side);
      }
    }
  }
  for(const file of binaryOriginals) {
    issue('inventory_invoice_binary_unverified','accountant',{file:file.name},'该发票原件的票内行尚未取得可复核的数据');
  }
  for(const side of summary) if(!seen.has(side))issue('inventory_invoice_lines_missing','accountant',{field:side==='purchase'?'购进发票':'销售发票'},'有发票资料但缺少可定位的票内明细');
  return {originals,proof,deductionClaims,purchaseHeaders};
}

function normalPurchase(row) {
  return row.side==='purchase' && !row.conflict && row.status==='正常' && row.positive==='是' &&
    row.amount!==null && row.tax!==null && row.gross===row.amount+row.tax;
}
// 由原票唯一货物、订单引用及两行价税金额认定金额调整。归属表只定位库存行。
function purchaseEvidence(originals,postings,purchaseBuyer,deductionClaims,decimal) {
  const invoices=new Map(),discounts=new Map(),costs=new Map(),grossInvoices=new Map();
  const boundBuyer=row=>Boolean(purchaseBuyer?.name && row.buyer===purchaseBuyer.name &&
    !(row.buyerId && purchaseBuyer.taxpayerId && row.buyerId!==purchaseBuyer.taxpayerId));
  for(const row of originals.values())if(row.side==='purchase')indexed(invoices,row.number,row);
  const purchaseKey=(date,seller,gross)=>JSON.stringify([date,seller,String(gross)]);
  for(const rows of invoices.values()){
    const [first]=rows;
    if(first.seller && first.date && rows.every(r=>r.gross!==null && r.seller===first.seller && r.date===first.date)){
      indexed(grossInvoices,purchaseKey(first.date,first.seller,rows.reduce((sum,r)=>sum+r.gross,0n)),rows);
    }
    if(rows.length!==2 || !rows.every(normalPurchase))continue;
    const goods=rows.find(r=>r.qty>0n && r.unit && (r.spec || r.sku) && r.amount>0n && r.tax>0n);
    const adjustment=rows.find(r=>r.quantityBlank && !r.unit && !r.spec && r.amount<0n && r.tax<0n);
    if(!goods || !adjustment || goods.amount+adjustment.amount<0n || goods.tax+adjustment.tax<0n)continue;
    if(!boundBuyer(goods) || !goods.seller || !goods.date || !goods.product || !/\d/u.test(goods.order) || !goods.taxCode || !goods.rate ||
      ['product','order','taxCode','rate','date','seller','buyer','buyerId','sku'].some(k=>goods[k]!==adjustment[k]))continue;
    discounts.set(adjustment.key,goods.key);
  }
  const byVoucher=new Map();
  for(const v of postings)indexed(byVoucher,purchaseKey(v.date,v.seller,BigInt(v.grossMinor)*decimal('0.01')),v);
  for(const [key,invoicesAtPrice] of grossInvoices){
    if(invoicesAtPrice.length!==1 || invoicesAtPrice[0].length!==1)continue;
    const [r]=invoicesAtPrice[0],candidates=byVoucher.get(key);
    if(!normalPurchase(r) || !boundBuyer(r) ||
      r.qty<=0n || !r.unit || r.amount<=0n || r.tax<=0n ||
      !/普通发票/u.test(r.invoiceType) || deductionClaims.has(r.number) || candidates?.length!==1)continue;
    const [v]=candidates;
    const product=r.product.replace(/^\*[^*]+\*/u,'');
    if(product && v.summary.includes(product) && /(?:^|[（(，,、；;])税额不抵扣[）)]?$/u.test(v.summary)){
      costs.set(r.key,{gross:r.gross,voucherId:v.voucherId});
    }
  }
  return {discounts,costs};
}
function mappingTables(files,listSheets) {
  const tables=[];
  for(const file of files) {
    if(!/\.(csv|xlsx)$/iu.test(file.name))continue;
    for(const sheet of listSheets(file)) {
      const form=headerRow(sheet,has=>has(numbered) && has(lineNames) && has(sheetNames) && has(targetLines) && has(['金额','分配金额','票面金额','映射方式']));
      if(form)tables.push({file,sheet,form});
    }
  }
  return tables;
}
function corresponds(proof,source,target) {
  if(proof.side && proof.side!==source.side || proof.number && proof.number!==source.number || proof.line && proof.line!==source.line) return false;
  if(proof.original && norm(proof.original)!==norm(source.spec) || proof.unit && proof.unit!==source.unit) return false;
  if(!target) return !!proof.number && !!proof.line && /排除|不入库|不映射|非存货/u.test(proof.kind);
  if(proof.target && norm(proof.target)!==norm(target.spec) || proof.sheet && proof.sheet!==target.at.sheet || proof.row && Number(proof.row)!==target.at.row) return false;
  return !!(proof.original || proof.number && proof.line) && !!(proof.target || proof.sheet && proof.row);
}
function reviewTable({file,sheet,form},ctx) {
  const {originals,items,proof,issue,coverage,decimal,display,discounts,costs,expenseByLine}=ctx;
  const itemIndex=new Map(items.map(item=>[cell(item.at.sheet,item.at.row),item]));
  const allocations=new Map(), movements=new Map(), families=new Map();
  const excludedRows=[],prepaidGroups=new Map();
  for(const row of sheet.rows.slice(form.index+1)) {
    if(!row.cells.some(v=>txt(v))) continue;
    const g=names=>get(row.cells,form.h,names),pos=at(file,sheet,row);
    const side=invoiceDirection(g(['方向','类型','购销类型'])) || invoiceDirection(file.name+'/'+sheet.name);
    const key=ticket(side,g(numbered),g(lineNames)), source=originals.get(key);
    if(!source){issue('inventory_invoice_map_source_missing','accountant',pos,'索引中的票号、购销方向及票内行未对应原件');continue;}
    coverage.invoiceLinksChecked++;
    const method=g(kindNames),sheetName=g(sheetNames),rowNumber=g(targetLines);
    const excluded=!maybeTarget(sheetName) && !maybeTarget(rowNumber);
    const spec=g(specNames),unit=g(unitNames),rawQty=g(['分配数量','映射数量',...qtyNames]),qty=readNum(decimal,rawQty,true);
    const portion=readNum(decimal,g(['分配金额',...amountNames]),true);
    const entry={qty,quantityBlank:!rawQty,portion,excluded,pos,source,
      voucherId:g(['凭证ID','凭证编号ID']),voucherNumber:g(['凭证号','凭证序号'])};
    indexed(allocations,key,entry);
    if((spec || source.spec) && norm(spec)!==norm(source.spec) || unit!==source.unit) issue('inventory_invoice_map_source_fields','bookkeeper',pos,'索引规格或单位与原票不同',[spec,unit].join(' / '),[source.spec,source.unit].join(' / '));
    if(excluded){
      if(discounts.has(key)){
        issue('inventory_invoice_discount_target_unverified','bookkeeper',pos,'原票金额调整须并入同票唯一货物对应的购入成本');continue;
      }
      const intrinsic=/作废/u.test(source.status) || /服务费|运输服务|建筑服务|旅客运输|通行费|金融服务/u.test(source.product) ||
        side==='sale' && /折扣|折让/u.test(source.product);
      if(!intrinsic && !proof.some(p=>corresponds(p,source,null)))excludedRows.push(entry);
      if(side==='purchase' && entry.voucherId)indexed(prepaidGroups,entry.voucherId,entry);
      continue;
    }
    if(!positiveLine(rowNumber) || !itemIndex.has(cell(sheetName,rowNumber))){issue('inventory_invoice_target_missing','bookkeeper',pos,'索引指向的库存工作表或商品行不存在',sheetName+'/'+rowNumber);continue;}
    const item=itemIndex.get(cell(sheetName,rowNumber)), support=proof.filter(p=>corresponds(p,source,item));
    entry.item=item;entry.support=support;
    if(discounts.has(key))continue;
    if(source.side==='purchase' && source.quantityBlank && source.amount<0n && !expenseByLine.get(key)?.red){
      issue('inventory_invoice_adjustment_unverified','accountant',pos,'负金额无数量行缺少同票唯一货物、订单及价税勾稽依据');continue;
    }
    const skuConflict=!!(source.sku && item.id && source.sku!==item.id);
    if(skuConflict)issue('inventory_invoice_sku_conflict','accountant',pos,'票面商品编码与目标库存商品编码不同，请核对编码体系及对应原件',source.sku,item.id);
    const exact=source.spec && norm(source.spec)===norm(item.spec) || source.sku && source.sku===item.id && (!source.spec || !item.spec);
    const confirmed=exact || support.some(p=>p.target || /拆分|分配|别名|对应/u.test(p.kind));
    if(!confirmed || /待核|待确认|疑似|假设/u.test(method)) issue('inventory_invoice_spec_unverified','accountant',pos,'原票规格与库存商品的对应关系需独立原件确认',source.spec,item.spec);
    let mappedQty=qty;
    if(source.unit!==item.unit || !source.unit){
      const conversion=support.find(p=>p.targetUnit===item.unit && p.factor>0n);
      if(!conversion) issue('inventory_invoice_unit_unverified','accountant',pos,'原票与库存单位需核对换算关系',source.unit,item.unit);
      else if(qty!==null) mappedQty=qty*conversion.factor/decimal('1');
    }
    if(mappedQty!==null && !expenseByLine.get(key)?.red) {
      const movementKey=JSON.stringify([side,item.at.sheet,item.at.row]);
      const group=movements.get(movementKey)??{total:0n,amount:0n,priced:true};
      group.total+=mappedQty;
      const cost=costs.get(key);
      if(cost && portion===source.amount && qty===source.qty){
        group.amount+=cost.gross;
        coverage.invoicePurchaseCostEvidence.push({invoice:source.number,line:source.line,source:source.at,voucherId:cost.voucherId,
          net:display(source.amount),tax:display(source.tax),gross:display(cost.gross),target:item.at});
      }else group.amount+=portion??0n;
      group.priced &&= portion!==null;
      movements.set(movementKey,group);
    }
    const fkey=cell(item.at.sheet,item.at.row),family=families.get(fkey)??{item,specs:new Set(),uncertain:false};
    if(source.spec)family.specs.add(norm(source.spec));family.uncertain ||= !confirmed || skuConflict;families.set(fkey,family);
  }
  reviewExpenseMappings(ctx,allocations,excludedRows,prepaidGroups);
  for(const src of originals.values()) {
    const rows=allocations.get(src.key);
    if(!rows){issue('inventory_invoice_line_unmapped','accountant',src.at,'原票行缺少库存映射或排除依据',src.number+'/'+src.line);continue;}
    if(rows.length>1 && (rows.some(r=>r.excluded || !r.item || !r.support.some(p=>p.number===src.number && p.line===src.line && p.allocated!==null && p.allocated===r.qty)) || new Set(rows.map(r=>r.item)).size!==rows.length)) {
      issue('inventory_invoice_split_unproved','accountant',src.at,'同一票行映射多次，需原件列明各商品行及拆分数量');
    }
    for(const [field,stated,title] of [['qty',src.qty,'数量'],['portion',src.amount,'金额']]) {
      const values=rows.map(r=>r[field]);if(stated===null && values.every(v=>v===null))continue;
      if(stated===null || values.some(v=>v===null) || values.reduce((a,b)=>a+b,0n)!==stated) {
        issue('inventory_invoice_map_total_mismatch','bookkeeper',{...src.at,field:title},'同一票行全部映射和排除项合计与原件不符',values.some(v=>v===null)?'缺值':display(values.reduce((a,b)=>a+b,0n)),stated===null?'原票缺值':display(stated));
      }
    }
    const goodsKey=discounts.get(src.key);
    if(goodsKey && !rows.some(r=>r.excluded)) {
      const anchors=allocations.get(goodsKey)??[],entry=rows[0],goods=originals.get(goodsKey);
      if(rows.length!==1 || !entry.item || anchors.length!==1 || entry.item!==anchors[0].item ||
        !entry.quantityBlank || entry.portion!==src.amount || anchors[0].qty!==goods.qty || anchors[0].portion!==goods.amount){
        issue('inventory_invoice_discount_target_unverified','bookkeeper',entry.pos,'金额调整应按原票金额归入同票货物唯一对应的库存行，数量及单位沿用原票空值');continue;
      }
      const target=entry.item.at;
      const group=movements.get(JSON.stringify(['purchase',target.sheet,target.row]));
      if(group){
        group.amount+=src.amount;
        coverage.invoiceDiscountEvidence.push({invoice:src.number,goods:goods.at,adjustment:src.at,target,
          goodsAmount:display(goods.amount),adjustmentAmount:display(src.amount),netCost:display(goods.amount+src.amount)});
      }
    }
  }
  for(const {item,specs,uncertain} of families.values()) if(specs.size>1 && uncertain) {
    issue('inventory_invoice_many_specs_unverified','accountant',item.at,'多种票面规格集中在此库存行，部分归属缺独立依据',String(specs.size));
  }
  return movements;
}
const flowKind=value=>/暂估|未收进项|未收票.*入库/u.test(value)?'estimate':/销售出库|领料|发货|出库/u.test(value)?'sale':/采购入库|购入|采购收货|收货|收料|入库/u.test(value)?'purchase':'';
function warehouseEvidence({sources,items,listSheets,decimal,issue,period,periodChecks}) {
  const results=new Map(), seen=new Set();
  for(const file of sources) {
    if(!/\.(xlsx|csv)$/iu.test(file.name) || /映射|底稿|复算|模板|票行|测试依据|假设/u.test(file.name))continue;
    for(const sheet of listSheets(file)) {
      const form=headerRow(sheet,has=>has([...qtyNames,'实收数量','实发数量','原表未收进项数量']) &&
        (has(['业务类型','收发类型','出入库类型','单据类型']) || flowKind(file.name+'/'+sheet.name)) &&
        (has(skuNames) || has(specNames)) && (has(['单据号','单据编号','单号','入库单号','出库单号','收货单号','来源单号','凭证号','凭证ID']) || has(['原表']) && has(['行号'])));
      if(!form)continue;
      for(const row of sheet.rows.slice(form.index+1)) {
        if(!row.cells.some(v=>txt(v)))continue;
        const g=names=>get(row.cells,form.h,names),pos=at(file,sheet,row);
        if(['conflict','unverified'].includes(checkStockPeriod({period,file,sheet,row,headers:form.h,headerNumber:sheet.rows[form.index].number,periodChecks,issue,kind:'收发原件'})))continue;
        const side=flowKind(g(['业务类型','收发类型','出入库类型','单据类型']) || file.name+'/'+sheet.name);
        const sku=g(skuNames), spec=g(specNames), name=g(['品名','商品名称','货品名称']),unit=g(unitNames);
        const reference=g(['单据号','单据编号','单号','入库单号','出库单号','收货单号','来源单号','凭证号','凭证ID']) || (g(['原表']) && g(['行号']) ? g(['原表'])+'/'+g(['行号']) : '');
        const qty=readNum(decimal,g(['实收数量','实发数量','数量','原表未收进项数量'])), raw=g(['成本金额','不含税金额','金额']), amount=readNum(decimal,raw,true);
        const found=items.filter(item=>(sku?item.id===sku:spec && norm(spec)===norm(item.spec)) && (!name || item.name===name) && (!spec || norm(spec)===norm(item.spec)) && unit && unit===item.unit);
        if(!side || !reference || found.length!==1 || qty===null || raw && amount===null){
          issue('inventory_warehouse_line_unverified','accountant',pos,'收发原件的单号、商品、单位、数量或金额不能唯一核对');continue;
        }
        const item=found[0],key=JSON.stringify([side,item.at.sheet,item.at.row]);
        const evidenceKey=JSON.stringify([key,reference,g(['单据行号','明细行号','行号'])]);
        if(seen.has(evidenceKey)){issue('inventory_warehouse_duplicate','accountant',pos,'同一单据及明细定位重复，需核对是否重复登记');continue;}
        seen.add(evidenceKey);
        const sum=results.get(key)??{quantity:0n,amount:0n,priced:true,unbilled:true};
        sum.quantity+=qty;sum.amount+=amount??0n;sum.priced &&= amount!==null;
        sum.unbilled &&= /未开票|无票|未收票/u.test(g(['票据状态','收票状态','开票状态','业务类型']));
        results.set(key,sum);
      }
    }
  }
  return results;
}
function checkFlows(ctx,tableMovements) {
  const {items,issue,display,coverage}=ctx;
  const evidence=warehouseEvidence(ctx);
  coverage.warehouseItemGroups=evidence.size;
  for(const item of items)for(const side of ['purchase','sale','estimate']) {
    const qty=item[side+'Qty'],amount=item[side+'Amount'];
    const key=JSON.stringify([side,item.at.sheet,item.at.row]);
    const document=evidence.get(key);
    const mappings=tableMovements.map(t=>t.get(key)).filter(Boolean);
    const field={purchase:'购入',sale:'出库',estimate:'暂估入库'}[side];
    if(!document && !mappings.length){
      if(qty!==0n || amount!==0n)issue(tableMovements.length && side!=='estimate'?'inventory_invoice_stock_qty_difference':'inventory_flow_source_missing','accountant',
        {...item.at,field:field+'数量'},'需提供对应的票行、独立收发原件或带有商品计量明细的会计来源','无对应收发原件',display(qty));
      continue;
    }
    const disjoint=!!document?.unbilled && mappings.length>0;
    if(document && !disjoint && document.quantity!==qty)
      issue('inventory_warehouse_quantity_difference','accountant',{...item.at,field:field+'数量'},'独立收发原件与库存发生量不符，需核对期间、部分覆盖、重复或退回',display(document.quantity),display(qty));
    if(document && document.quantity===qty) {
      if(document.priced && document.amount!==amount)issue('inventory_warehouse_amount_difference','accountant',{...item.at,field:field+'金额'},'收发单成本金额与库存金额不符，需核对计价或额外费用',display(document.amount),display(amount));
      if(!document.priced && side==='estimate')issue('inventory_estimate_price_unproved','accountant',{...item.at,field:'暂估金额'},'收货数量已对应，需补暂估计价及金额依据',display(amount));
    }
    for(const mapping of mappings) {
      const mappedQty=mapping.total+(disjoint?document.quantity:0n);
      if(mappedQty!==qty)issue('inventory_invoice_stock_qty_difference','accountant',{...item.at,field:field+'数量'},
        disjoint?'票行与单列未开票原件的数量合计与库存发生量不符':'票行归属数量与库存发生量不符，另有收发单仍需逐项解释',display(mappedQty),display(qty));
      if(side==='purchase' && mapping.priced && mappedQty===qty && (!disjoint || document.priced)) {
        const mappedAmount=mapping.amount+(disjoint?document.amount:0n);
        if(mappedAmount!==amount)issue('inventory_purchase_amount_unreconciled','accountant',{...item.at,field:'购入金额'},
          '进项票面及明确单列的未开票金额与购入成本不同，请核对运费、折让或其他计价来源',display(mappedAmount),display(amount));
      }
    }
  }
}
export function reviewStockInvoiceLinks({files,sources,items,listSheets,decimal,display,issue,coverage,period,periodChecks,purchasePostings=[],purchaseBuyer,expensePostings=[]}) {
  Object.assign(coverage,{invoiceOriginalLines:0,invoiceMappingTables:0,invoiceLinksChecked:0,invoiceDiscountEvidence:[],invoicePurchaseCostEvidence:[],invoiceExpenseEvidence:[]});
  const {originals,proof,deductionClaims,purchaseHeaders}=collectSources({sources,listSheets,decimal,issue,period,periodChecks});
  const tables=mappingTables(files,listSheets);
  coverage.invoiceOriginalLines=originals.size;
  coverage.invoiceMappingTables=tables.length;
  if(originals.size && !tables.length) issue('inventory_invoice_mapping_missing','accountant',{field:'票行与库存行'},'有购销票行原件，缺少按票号、票内行定位的库存映射或排除表');
  const ctx={originals,proof,items,coverage,decimal,display,issue,sources,listSheets,period,periodChecks,
    expensePostings,expenseContext:{period,buyer:purchaseBuyer,cent:decimal('0.01'),claims:deductionClaims},
    expenseByLine:expenseEvidence(originals,expensePostings,purchaseBuyer,period,decimal('0.01'),deductionClaims,purchaseHeaders),
    ...purchaseEvidence(originals,purchasePostings,purchaseBuyer,deductionClaims,decimal)};
  checkFlows(ctx,tables.map(table=>reviewTable(table,ctx)));
}
