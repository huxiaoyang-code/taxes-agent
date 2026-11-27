// 从账套快照及进项票原件独立重建账载归属。交付索引仅用于核对定位。
const roles=new Map([['固定资产','asset'],['主营业务成本','cost'],['其他业务成本','cost'],
  ['管理费用','expense'],['销售费用','expense'],['应付账款','payable'],['预付账款','prepaid']]);
const under=(code,root)=>code===root || code.startsWith(root) && /^\d+$/u.test(code.slice(root.length));
function group(map,key,item) {
  if(!map.has(key))map.set(key,[]);
  map.get(key).push(item);
}

export function expensePostings(snapshot,vouchers) {
  const roots=snapshot.profile.coa.filter(a=>roles.has(a.name) && a.scope?.status==='mapped' &&
    snapshot.accounts.some(b=>b.code===a.code && b.name===a.name));
  const chart=new Map(snapshot.accounts.map(a=>{
    const root=roots.find(r=>under(a.code,r.code));
    let role=root && roles.get(root.name);
    if((role==='prepaid' || role==='payable') && a.code===root.code)role=null;
    const title=a.name.split(/[-—/／]/u).at(-1).trim();
    if(/^(?:未抵|待抵扣|待认证)?进项税额$/u.test(title) && /^(?:2221|1801)\d+$/u.test(a.code))role='inputTax';
    if(title==='进项税额转出' && /^2221\d+$/u.test(a.code))role='redTax';
    return [a.code,{code:a.code,name:a.name,role}];
  }));
  const records=[];
  for(const [voucherId,v] of vouchers) {
    if(v.status!=='posted' || v.period!==snapshot.period)continue;
    const lines=v.lines.map(l=>({...chart.get(l.code),debitMinor:String(l.debit),creditMinor:String(l.credit)}));
    // 混合记账、重复入账也保留在候选内，以免过滤后将剩下一张误作唯一。
    for(const credit of lines.filter(l=>['payable','prepaid'].includes(l.role) && l.creditMinor!=='0')){
      records.push({voucherId,number:String(v.number),period:v.period,date:v.date,summary:v.summary,
        seller:credit.name,settlement:credit.role,creditCode:credit.code,grossMinor:credit.creditMinor,lines});
    }
  }
  return records;
}

const label=value=>String(value??'').normalize('NFKC').trim();
const blueNumber=r=>/被红冲蓝字(?:数电)?发票号码\s*[:：]\s*(\d{8,20})(?!\d)/u.exec(r.order)?.[1];
const byDay=(seller,date,sign)=>JSON.stringify([label(seller),date,sign]);
const nums=rows=>[...new Set(rows.map(r=>r.number))];
function validRow(r,buyer,period,cent) {
  return !r.conflict && r.status==='正常' && ['是','否'].includes(r.positive) && r.product && r.seller &&
    /^\d{4}-\d{2}-\d{2}$/u.test(r.date) && r.date.slice(0,7)===period && buyer?.name && label(r.buyer)===label(buyer.name) &&
    (!buyer.taxpayerId || r.buyerId===buyer.taxpayerId) && r.amount!=null && r.tax!=null && r.gross===r.amount+r.tax &&
    r.amount%cent===0n && r.tax%cent===0n &&
    (r.positive==='是' ? r.amount>0n && r.tax>=0n : r.quantityBlank && blueNumber(r) && r.amount<0n && r.tax<=0n);
}

function comparePosting(v,rows,cent,claims) {
  const red=rows[0].positive==='否';
  const net=rows.reduce((s,r)=>s+r.amount/cent,0n),tax=rows.reduce((s,r)=>s+r.tax/cent,0n);
  if(BigInt(v.grossMinor)!==net+tax)return;
  const credits=v.lines.filter(l=>BigInt(l.creditMinor)!==0n);
  const debits=v.lines.filter(l=>BigInt(l.debitMinor)!==0n);
  if(credits.length!==1 || credits[0].debitMinor!=='0' || credits[0].code!==v.creditCode ||
    BigInt(credits[0].creditMinor)!==net+tax || v.lines.some(l=>l.debitMinor==='0' && l.creditMinor==='0'))return;
  const accounts=debits.filter(l=>['asset','expense','cost'].includes(l.role));
  if(accounts.length!==1)return;
  const [account]=accounts;
  if(red && (account.role!=='cost' || !/(?:价格|采购|销售)折让/u.test(v.summary)))return;
  const taxLines=debits.filter(l=>l.role===(red?'redTax':'inputTax'));
  let basis;
  if(debits.length===1 && BigInt(account.debitMinor)===net+tax &&
    (!tax || !red && rows.every(r=>/普通发票/u.test(r.invoiceType) && !claims.has(r.number))))basis='gross';
  else if(debits.length===2 && taxLines.length===1 && BigInt(taxLines[0].debitMinor)===tax && BigInt(account.debitMinor)===net)basis='net';
  if(!basis)return;
  return {voucherId:v.voucherId,number:v.number,date:v.date,account:account.code,accountName:account.name,role:account.role,
    seller:v.seller,settlementAccount:v.creditCode,taxAccount:taxLines[0]?.code,basis,red,netMinor:String(net),taxMinor:String(tax),grossMinor:String(net+tax),
    invoices:nums(rows),sources:rows.map(r=>({key:r.key,number:r.number,line:r.line,at:r.at,...(red&&{blueInvoice:blueNumber(r)})}))};
}

// 不尝试拼凑同额子集。限同日同销方的完整正票或红票组，且只有一笔匹配贷方。
export function expenseEvidence(originals,postings,buyer,period,cent,claims,headers) {
  const byInvoice=new Map(),groups=new Map(),ledger=new Map(),accepted=new Map();
  for(const r of originals.values())if(r.side==='purchase'){
    group(byInvoice,r.number,r);
    group(groups,byDay(r.seller,r.date,r.positive),r);
  }
  const headerOnlyDays=new Set();
  for(const [number,list] of headers??[])if(!byInvoice.has(number)){
    for(const h of list)if(h.gross!==null)headerOnlyDays.add(byDay(h.seller,h.date,h.gross<0n?'否':'是'));
  }
  for(const v of postings)if(v.period===period)group(ledger,byDay(v.seller,v.date,BigInt(v.grossMinor)<0n?'否':'是'),v);
  for(const [key,rows] of groups){
    if(headerOnlyDays.has(key) || !rows.every(r=>validRow(r,buyer,period,cent)) ||
      new Set(rows.map(r=>r.buyerId)).size!==1 || new Set(rows.map(r=>r.sellerId)).size!==1 ||
      nums(rows).some(n=>byInvoice.get(n).some(r=>!rows.includes(r))))continue;
    // 有票头时再逐张核对明细完整性，防止所读明细恰好只覆盖了凭证金额的一部分。
    const agrees=nums(rows).every(n=>{
      const lines=byInvoice.get(n),[first]=lines;
      return (headers?.get(n)??[]).every(h=>
        ['amount','tax','gross'].every(k=>lines.reduce((s,r)=>s+r[k],0n)===h[k]) &&
        ['buyer','seller','buyerId','sellerId','status','date'].every(k=>!h[k] || label(h[k])===label(first[k])));
    });
    if(!agrees)continue;
    const gross=rows.reduce((s,r)=>s+r.gross/cent,0n);
    const matches=ledger.get(key)??[];
    if(matches.length!==1 || BigInt(matches[0].grossMinor)!==gross)continue;
    const result=comparePosting(matches[0],rows,cent,claims);
    if(result)for(const r of rows)accepted.set(r.key,result);
  }
  return accepted;
}

// 索引所指的预付款名称与原票销方有别时，仅返回具体取证方向。
function prepaidReview(rows,v,context) {
  if(v.settlement!=='prepaid' || v.period!==context.period || rows.some(r=>r.positive!=='是' || !validRow(r,context.buyer,context.period,context.cent)) ||
    new Set(rows.map(r=>r.seller)).size!==1 || label(rows[0].seller)===label(v.seller))return;
  if(comparePosting(v,rows,context.cent,context.claims))
    return `原票销方「${rows[0].seller}」与凭证 ${v.number} 预付账款明细「${v.seller}」不同。请核对载有本次扣款的预付账户流水，以及该账户与开票主体的对应关系。`;
}

export function reviewExpenseMappings(ctx,allocations,excludedRows,prepaidGroups) {
  const {coverage,issue,originals}=ctx;
  const consumed=new Set();
  for(const evidence of new Set(ctx.expenseByLine.values())){
    const entries=evidence.sources.flatMap(r=>allocations.get(r.key)??[]);
    const [first]=entries;
    if(!first)continue;
    if(evidence.red)issue('inventory_invoice_prior_cost_allocation','accountant',first.pos,
      `凭证 ${evidence.number} 按前期采购折让入账，${evidence.invoices.length} 张红票无数量并列明蓝票号。请按原蓝票核对历史入库、销售成本结转与剩余库存，以确定折让归属。`);
    if(evidence.sources.some(r=>allocations.get(r.key)?.length!==1))continue;
    for(const e of entries){
      if(e.voucherId && e.voucherId!==String(evidence.voucherId) || e.voucherNumber && e.voucherNumber!==evidence.number){
        issue('inventory_invoice_voucher_reference_mismatch','bookkeeper',e.pos,'票行所指凭证与原票及账内唯一对应的已过账凭证不同',
          [e.voucherId,e.voucherNumber].join('/'),[evidence.voucherId,evidence.number].join('/'));
      }
    }
    // 索引另将账载费用或资产分配给库存商品时，保留原数量金额及账实差异。
    if(!evidence.red && entries.some(e=>!e.excluded)){
      issue('inventory_invoice_expense_stock_conflict','accountant',first.pos,
        `凭证 ${evidence.number} 全额记入 ${evidence.account} ${evidence.accountName}，索引另列商品入库。请核对收货单、领用记录及成本分配。`);
      continue;
    }
    coverage.invoiceExpenseEvidence.push({...evidence,sources:evidence.sources.map(({key,...source})=>source)});
    for(const entry of entries)consumed.add(entry);
    if(!evidence.red && evidence.role==='cost' && entries.some(e=>/材料|配件|零件/u.test(e.source.product) || e.source.qty>0n && !/服务/u.test(e.source.product)))issue('inventory_invoice_direct_cost_allocation','accountant',first.pos,
      `凭证 ${evidence.number} 直接计入 ${evidence.account} ${evidence.accountName}。请核对项目结算明细、材料领用或直送记录，以确定材料与服务成本的归属。`);
  }
  const prepaidNotes=new Map();
  for(const [id,entries] of prepaidGroups){
    const v=ctx.expensePostings.filter(p=>String(p.voucherId)===id);
    if(v.length!==1 || v[0].settlement!=='prepaid' || entries.some(e=>e.voucherNumber && e.voucherNumber!==v[0].number) ||
      entries.some(e=>allocations.get(e.source.key).length!==1))continue;
    const rows=entries.map(e=>e.source),numbers=new Set(rows.map(r=>r.number));
    if([...originals.values()].some(r=>r.side==='purchase' && numbers.has(r.number) && !rows.includes(r)))continue;
    const note=prepaidReview(rows,v[0],ctx.expenseContext);
    if(note)for(const entry of entries)prepaidNotes.set(entry,note);
  }
  for(const entry of excludedRows)if(!consumed.has(entry))
    issue('inventory_invoice_exclusion_unproved','accountant',entry.pos,prepaidNotes.get(entry)??'票行未入库存，需提供折让、退货、服务或其他排除依据');
}
