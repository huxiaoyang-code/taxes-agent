// 小企业现金流量表直接法项目；金额只取实际已过账现金分录，分类取执行前的有源选择。
import {storedCents,centsToNumber} from './money.mjs';
export const SMALL_CASH_FLOW_ITEMS=[
 ['销售产成品、商品、提供劳务收到的现金','in','operating'],['收到其他与经营活动有关的现金','in','operating'],
 ['购买原材料、商品、接受劳务支付的现金','out','operating'],['支付的职工薪酬','out','operating'],['支付的税费','out','operating'],['支付其他与经营活动有关的现金','out','operating'],
 ['经营活动产生的现金流量净额','total','operating'],['收回短期投资、长期债券投资和长期股权投资收到的现金','in','investing'],['取得投资收益收到的现金','in','investing'],['处置固定资产、无形资产和其他非流动资产收回的现金净额','in','investing'],
 ['短期投资、长期债券投资和长期股权投资支付的现金','out','investing'],['购建固定资产、无形资产和其他非流动资产支付的现金','out','investing'],['投资活动产生的现金流量净额','total','investing'],
 ['取得借款收到的现金','in','financing'],['吸收投资者投资收到的现金','in','financing'],['偿还借款本金支付的现金','out','financing'],['偿还借款利息支付的现金','out','financing'],['分配利润支付的现金','out','financing'],['筹资活动产生的现金流量净额','total','financing'],['现金净增加额','net'],['期初现金余额','begin'],['期末现金余额','end']
];
const cashCode=code=>/^100[12](?:\d*)$/.test(String(code));
const sum=(rows,key)=>rows.reduce((n,r)=>n+storedCents(r[key]??0),0n);
const money=centsToNumber;
export function buildQuarterCashFlow(snapshot,evidenceGroups){
 const periods=snapshot.periods,items=new Map(SMALL_CASH_FLOW_ITEMS.filter(x=>['in','out'].includes(x[1])).map(x=>[x[0],x]));
 const byVoucher=new Map();for(const group of evidenceGroups){if(!group.accepted||!Number.isSafeInteger(group.voucherId)||!group.evidence.cashFlowAllocations?.length)continue;const rows=byVoucher.get(group.voucherId)??[];rows.push(group);byVoucher.set(group.voucherId,rows);}
 const months=periods.map(period=>{
  const month=snapshot.months.find(m=>m.period===period);if(month.missing)return {period,missing:true};
  const trial=month.reports['trial-balance'].data.lines,begin=sum(trial.filter(r=>cashCode(r.code)),'opening_debit')-sum(trial.filter(r=>cashCode(r.code)),'opening_credit'),end=sum(trial.filter(r=>cashCode(r.code)),'closing_debit')-sum(trial.filter(r=>cashCode(r.code)),'closing_credit');
  const values=new Map([...items.keys()].map(k=>[k,0n])),transactions=[],unknown=[];let internal=0n;
  const ids=[...new Set(snapshot.entries.filter(e=>e.period===period&&e.status==='posted').map(e=>e.voucher_id))];
  for(const id of ids){const entries=snapshot.entries.filter(e=>e.voucher_id===id),cash=entries.filter(e=>cashCode(e.code));if(!cash.length)continue;const incoming=sum(cash,'debit'),outgoing=sum(cash,'credit');
   if(entries.every(e=>cashCode(e.code))&&incoming===outgoing){internal+=incoming;transactions.push({voucherId:id,date:entries[0].voucher_date,summary:entries[0].voucher_summary,item:'现金账户内部划转（不计入现金流量）',incoming:money(incoming),outgoing:money(outgoing),status:'internal'});continue;}
   const groups=byVoucher.get(id)??[],unique=new Map(groups.map(g=>[JSON.stringify(g.evidence.cashFlowAllocations),g]));let reason=null,group;
   if(unique.size!==1)reason=unique.size?'同一凭证存在相互冲突的现金流分类':'缺少与本凭证绑定的原件及现金流项目选择';else group=[...unique.values()][0];
   const allocations=group?.evidence.cashFlowAllocations??[];let assignedIn=0n,assignedOut=0n;
   const seen=new Set();for(const a of allocations){const item=items.get(a.item),sourceKey=JSON.stringify(a.sources.map(s=>[s.sha256,s.location]));if(!item||!a.valueMatched||seen.has(sourceKey))reason='现金流项目、原值或分配来源无效或重复';seen.add(sourceKey);if(item?.[1]==='in')assignedIn+=storedCents(a.amount);if(item?.[1]==='out')assignedOut+=storedCents(a.amount);}
   if(!reason&&(assignedIn!==incoming||assignedOut!==outgoing))reason='分类分配合计与凭证实际收付金额不一致';
   if(reason){unknown.push({voucherId:id,date:entries[0].voucher_date,summary:entries[0].voucher_summary,incoming:money(incoming),outgoing:money(outgoing),reason});continue;}
   for(const a of allocations){values.set(a.item,values.get(a.item)+storedCents(a.amount));transactions.push({voucherId:id,date:entries[0].voucher_date,summary:entries[0].voucher_summary,item:a.item,amount:a.amount,direction:items.get(a.item)[1],reason:a.reason,sources:a.sources,origin:'agent_selection_with_source',callId:group.callId,status:'classified'});}
  }
  const totals=Object.fromEntries(['operating','investing','financing'].map(category=>[category,[...items.values()].filter(x=>x[2]===category).reduce((n,x)=>n+(x[1]==='in'?1n:-1n)*values.get(x[0]),0n)])),net=Object.values(totals).reduce((n,v)=>n+v,0n),unknownIn=sum(unknown,'incoming'),unknownOut=sum(unknown,'outgoing');
  return {period,rows:SMALL_CASH_FLOW_ITEMS.map(([label,kind,category],i)=>({line:i+1,label,value:money(kind==='total'?totals[category]:kind==='net'?net:kind==='begin'?begin:kind==='end'?end:values.get(label))})),transactions,unknown,unknownIncoming:money(unknownIn),unknownOutgoing:money(unknownOut),internalTransfers:money(internal),begin:money(begin),end:money(end),classifiedNet:money(net),cashChange:money(end-begin),classificationDifference:money(end-begin-net),ledgerDifference:money(end-begin-net-unknownIn+unknownOut),complete:unknown.length===0,classificationReviewed:false};
 });
 const present=months.filter(m=>!m.missing),quarter=present.length===3?{rows:SMALL_CASH_FLOW_ITEMS.map(([label,kind],i)=>({line:i+1,label,value:kind==='begin'?present[0].begin:kind==='end'?present.at(-1).end:money(present.reduce((n,m)=>n+storedCents(m.rows[i].value),0n))})),unknownIncoming:money(sum(present,'unknownIncoming')),unknownOutgoing:money(sum(present,'unknownOutgoing')),classificationDifference:money(sum(present,'classificationDifference')),ledgerDifference:money(sum(present,'ledgerDifference')),complete:present.every(m=>m.complete)}:null;
 return {method:'小企业现金流量表项目，按实际收付和调用时选取的分类归集',ruleSource:{title:'小企业会计准则附录财务报表',url:'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf',locator:'现金流量表第1至22行'},classificationPolicy:{approved:false,status:'待确认',reason:'业务收付分类的适用性待人工复核；金额及项目模板核对不等于处理政策与业务性质已审定。'},scope:'仅现金与银行存款科目；现金等价物、受限资金需另核；分类选择不因金额匹配而视为已人审。分类金额按当前选择展示，适用政策仍待确认。',months,quarter};
}
