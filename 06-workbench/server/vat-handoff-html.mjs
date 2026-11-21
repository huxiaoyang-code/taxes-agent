import {pathToFileURL} from 'node:url';

const esc=v=>String(v??'待核').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const table=(headers,rows)=>rows.length?'<table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'<p>本次材料没有可列记录。</p>';
const section=(title,body)=>'<section><h2>'+esc(title)+'</h2>'+body+'</section>';
const fmt=(v,unit='')=>v==null?'待核':v+unit;
const name={baseline:'基准方案',plan:'比较方案'};
const reportNames={'income-statement':'利润表','trial-balance':'科目余额表','balance-sheet':'资产负债表','cash-flow-statement':'现金流量表'};
const ref=s=>'原件 '+(s.source+1)+'／表 '+(s.table+1)+(s.row==null?'':'／行位 '+s.row)+(s.verification==='host_observation'?'（宿主观察）':'');
const refs=rows=>(rows??[]).map(ref).join('、')||'待补原件';
const reasons={
 agreement_unverified:'税负约定的来源或生效期间待核',cash_comparison_without_confirmed_target:'尚无确认的税负目标，按年末与近期付款比较',agreement_basis_incomplete:'缺少同口径历史税额、销售额或适用约定',clarify_customer_burden_mode:'单月和累计口径会改变选票，须向客户确认口径',same_choice_under_both_burden_modes:'单月和累计口径均支持同一选择',meets_customer_minimum:'选取满足客户最低税负的方案',cash_within_customer_minimum:'已覆盖月份均符合约定，按年末和近期付款取舍',earliest_cash_within_customer_minimum:'两个方案均满足约定，优先较早使用进项、减少近期付款',customer_minimum_unattained_among_options:'两方案均未达最低税负，列出其中可达到的较高值供复核',
};
export function renderVatHandoff(p){
 const parts=[],rec=p.recommendation,choice=name[rec?.choice]??'尚无推荐';
 parts.push('<h1>增值税月结会计交接</h1><p>企业 '+esc(p.scope.enterpriseKey)+' · 账套 '+esc(p.scope.accountSetId)+' · '+esc(p.scope.period)+' 所属期 · 金额单位为元</p><p>资料截止 '+esc(p.asOf)+'，覆盖至 '+esc(p.through)+'。调用版本 '+esc(p.callId)+'</p>');
 parts.push(section('选票结论','<p>'+esc(choice)+'。'+esc(reasons[rec?.reason]??'两种方案供会计比较，尚缺有效推荐依据。')+(rec?.agreement?.status==='active'?'。已确认'+esc(({monthly:'单月',ytd:'累计'})[rec.agreement.burdenMode]??'口径待核')+'税负下限 '+esc(rec.agreement.minimumPercent)+'%，起始月 '+esc(rec.agreement.from)+'，来源 '+esc(refs(rec.agreement.sources)):'')+'</p><p>下表展示'+esc(name[p.displayChoice])+'。勾选、申报与缴款分别核对原件。</p>'+
 table(['所属期','方案','预缴抵减前应纳','抵减后应补','可比销售额','单月税负','年初累计税额','年初累计销售额','累计税负','付款月','预计付款'],Object.entries(p.scenarios).flatMap(([k,s])=>(s?.months??[]).map(m=>[m.period,name[k],m.dueBeforePrepayment,m.due,m.salesExcludingVat,fmt(m.burden?.monthly?.percent,'%'),m.burden?.ytd?.dueBeforePrepayment,m.burden?.ytd?.salesExcludingVat,fmt(m.burden?.ytd?.percent,'%'),m.paymentMonth,m.expectedPayment])))));
 if(rec?.cashComparison){
  const c=rec.cashComparison;
  parts.push(section('客户约定和现金的取舍',table(['核对月份','实际／预测','基准税负','基准离约定差额','比较税负','比较离约定差额','原件'],(rec.checks??[]).map(r=>[r.period,r.basis==='forecast'?'预测':'实际资料',fmt(r.baseline.percent,'%'),r.baseline.shortfall,fmt(r.plan.percent,'%'),r.plan.shortfall,refs(r.sources)]))+
   table(['方案','至年末增值税现金流出','年末已发生次年待付','年末留抵','年末预缴余额','未用进项','至预测窗口最后付款日流出'],Object.entries(name).map(([k,title])=>{const v=c[k];return [title,v.throughYearEnd,v.yearAccruedOutstandingAfterYearEnd,v.yearEndCarryCredit,v.yearEndPrepayment,v.yearEndUnusedInput,v.throughLastPayment];}))+
   '<p>比较方案相对基准，首笔付款差发生在 '+esc(c.firstDifference?.paymentMonth??'无差额')+'，保留现金 '+esc(c.firstDifference?.planCashRetained??'0.00')+' 元。'+esc(c.firstRecovery?'累计现金差于 '+c.firstRecovery+' 收回。':c.firstDifference?'本次窗口内尚未观察到累计现金差收回。':'')+' 截至年末相差 '+esc(fmt(c.planYearEndCashRetained))+' 元。'+esc(rec.provisional?'未核期间的税负与付款仍可能改变选择。':'')+'</p>'));
 }
 parts.push(section('逐票选期与复核理由','<p>本版列出 '+p.invoices.length+' 张，候选簿共 '+p.inventoryTotal+' 张。原件序号及字段映射见下方索引。</p>'+
 table(['原票号／销方','税额','用途／状态','最早可选','最晚可选','已确认期','基准选期','比较选期','推荐期','理由','取数位置'],p.invoices.map(i=>[[i.invoiceNumber,i.issuer].filter(Boolean).join('／')||i.invoiceRef,i.taxAmount,i.eligibility,i.firstPeriod,i.lastPeriod??'未给终期',i.fixedPeriod??'未见确认',i.baseline??'未选',i.plan??'未选',i.recommendedPeriod??'未选／待定',i.reason,refs(i.sources)]))));
 const reports=Object.entries(p.books.reports).map(([k,r])=>'<a href="'+esc(r.file)+'">'+esc(reportNames[k])+'</a>').join(' · ');
 parts.push(section('账簿、报表与申报准备','<p>'+esc(p.books.issues.join('。')||'本期账表取自同一只读账库快照。')+'</p><p>'+reports+'</p>'+
 table(['所属期','利润表营业收入','可比不含税销售','账表与税基差','账簿销项','税表销项','销项差','账簿进项','方案抵扣','进项差','进项转出','期初留抵','抵减前应纳','可用预缴','应补','申报应补','申报与试算差','申报依据'],p.months.map(m=>[m.period,m.reportedRevenue,m.salesExcludingVat,m.revenueDifference,m.ledgerOutputVat,m.outputVat,m.outputDifference,m.ledgerInputVat,m.selectedAndFixedInput,m.inputDifference,m.inputVatTransferOut,m.openingCarryCredit,m.dueBeforePrepayment,m.prepaidVat,m.due,m.declaredDue,m.filingDifference,m.filedAmountConflict?'多项申报金额冲突':m.filingStatus+'；'+refs(m.filingEvidence)]))+
 '<p>差额分别按账表金额减计税口径、申报应补减试算应补列示。进项确认、账上取得及转出可能跨期。收入与计税销售有差异时需核未开票、会计确认时点和简易计税业务。金额空缺须补证。</p>'+
 table(['已过账凭证','日期','科目','借方','贷方'],(p.books.entries??[]).map(e=>[e.word+'-'+e.number+' (#'+e.voucherId+')',e.date,e.code+' '+e.name,e.debit,e.credit]))));
 parts.push(section('按付款月核对现金','<p>预计应付、完税实付与退税到账分列。有实付资料时核对所属期、凭证与银行记录。</p>'+
 table(['付款月','已缴','预缴','退税到账','预计尚应付','净流出','来源'],p.cash.map(c=>[c.paymentMonth,c.observedActualPaid,c.observedPrepaid,c.observedRefund,c.expectedOutstanding,c.netCashOutflow,refs(c.sources)]))+
 table(['付款月','比较方案相对基准的税后现金变化'],(p.deltas?.byPaymentMonth??[]).map(r=>[r.paymentMonth,r.afterVatCash]))+
 table(['完税／退款回执流水号','发生日','金额','银行核对','候选流水号／编号','匹配的已过账凭证','银行批次／原始行／摘要'],(p.books.bank??[]).map(b=>[b.receiptId,b.day,b.amount,b.state,b.match?.id??b.candidates.join('、'),b.match?.voucher_status==='posted'?b.match.voucher_id:null,b.match?[b.match.batch_id,b.match.row_index,b.match.content_sha256].join('／'):null]))+
 table(['业务事件','所属期','实际发生日','金额','收付及更正依据'],p.activities.map(a=>[a.eventType,a.period,a.operationDate,a.amount,refs(a.sources)]))));
 parts.push(section('政策原文、企业条件与影响',table(['复核事项','已读条款','发文机关／文号','公布日／成文日','读取版本／日期','观察到的效力状态','生效至失效／时间证据','企业原件','本期判断','适用解释及影响','未读附件／插图'],p.policy.map(s=>[s.question,s.passage,[s.source?.issuingAuthority,s.source?.documentNumber].filter(Boolean).join(' '),[s.source?.publishedOn,s.source?.issuedOn].filter(Boolean).join('／'),[s.source?.sha256,s.source?.retrievedAt].filter(Boolean).join('／'),s.source?.observedStatus,[s.validity?.from,s.validity?.through,s.validity?.fromPassage,s.validity?.transitionPassage,s.timing].filter(Boolean).join(' ／ '),s.condition.path?s.condition.path+' '+s.condition.locator.valuePointer:s.condition.state,s.state,s.interpretation,fmt(s.unreadAttachments)+'／'+fmt(s.unreadImages)]))+
 p.policy.filter(s=>s.source).map(s=>'<p><a href="'+esc(s.source.url)+'">'+esc(s.source.title??s.source.url)+'</a> · 调用 '+esc(s.callId)+'</p>').join('')+
 '<p>下列为计算器规则出处，适用期间和企业条件另据上列证据审定。</p>'+table(['计算器出处','条款或定位','链接'],p.formulas.map(r=>[r.title,r.locator,r.url]))));
 parts.push(section('次月与年度交接',table(['所属期','发生或预测','期末留抵','期末预缴余额','下一付款月','预计金额'],p.months.map(m=>[m.period,m.basis==='actual'?'实际资料基础':m.basis==='forecast'?'预测':'待核',m.endingCarryCredit,m.endingPrepayment,m.paymentMonth,m.expectedPayment]))+
 table(['年末','测算起点以来应补','模拟期付款','年末留抵','未用票金额','失效未用','次年承接月','首个消耗留抵月份'],p.yearEnd?[[p.yearEnd.period,p.yearEnd.dueFromStart,p.yearEnd.paymentsFromSimulatedPeriods,p.yearEnd.carryCredit,p.yearEnd.unusedVat,p.yearEnd.expiredUnusedVat,p.nextYear?.period,p.nextYearUse?.firstNetOutputUsingCarry]]:[])+
 table(['年度覆盖月份','资料范围','历史发生额（可比销售／抵减前应纳）','申报原件数','实际缴付日期和金额','进销项或异常来源'],p.yearHistory.months.map(m=>[m.period,m.status,m.history.map(f=>fmt(f.data.salesExcludingVat)+'／'+fmt(f.data.dueBeforePrepayment)).join('、')||'待核',m.returns.length,m.payments.map(a=>a.operationDate+' '+a.amount).join('、')||'待核',refs([...m.history.map(f=>f.source),...m.returns.map(f=>f.source),...m.payments.flatMap(a=>a.sources)])]))+
 table(['承接期初','年初累计可比销售','年初累计抵减前应纳','来源'],p.yearHistory.opening.map(f=>[f.data.period,f.data.ytdSalesExcludingVat,f.data.ytdDueBeforePrepayment,ref(f.source)]))+'<p>实际资料覆盖 '+esc(p.yearHistory.coverage.observedPeriods.join('、')||'尚无')+'；预测期 '+esc(p.yearHistory.coverage.forecastPeriods.join('、')||'无')+'；前期逐月资料仍缺 '+esc(p.yearHistory.coverage.missingHistoricalDetail.join('、')||'无')+'。累计承接核对状态 '+esc(p.yearHistory.coverage.openingHistoryCheck??'见同口径累计及原始资料')+'。</p><p>全年申报资料按所属期复核。前期取得的实际回执列示如下。年中接账时，累计栏须核同口径期初与历史连续性。</p>'+table(['实际申报记录所属期','首次可知','申报金额','原件定位'],p.filingHistory.map(f=>[f.data.period,f.data.knownAt,f.data.declaredDue,ref(f.source)]))));
 const prev=p.previous;
 parts.push(section('版本、变化与待核事项','<p>'+esc(prev?('前版 '+prev.callId+' · '+prev.status):'本次未指定前版。')+'</p>'+
 table(['所属期','原应补','现应补','应补变化','原留抵','现留抵','原付款月','现付款月','预计付款变化'],(prev?.changes??[]).map(x=>[x.period,x.oldDue,x.newDue,x.dueChange,x.oldCarry,x.newCarry,x.oldPaymentMonth,x.newPaymentMonth,x.expectedPaymentChange]))+
 table(['付款月','前版预计净流出','本版预计净流出','变化'],(prev?.cashChanges??[]).map(s=>[s.paymentMonth,s.previous,s.current,s.change]))+table(['变动来源','变化'],(prev?.sourceChanges??[]).map(s=>[s.path,s.state]))+table(['政策问题','前版判断','本版判断','原文摘要改变'],(prev?.policyChanges??[]).map(s=>[s.question,s.oldState,s.newState,s.rawVersionChanged]))+
 table(['未决事项','所属期／票据','取数位置'],p.gaps.map(g=>[g.code,g.period??g.invoiceRef,refs(g.sources??(g.source?[g.source]:[]))]))+
 '<p>'+esc((p.conditions??[]).join(' '))+'</p>'));
 parts.push(section('会计底稿与原件','<p><a href="vat-handoff.json">完整交接数据、字段与变更记录</a> · <a href="vat-planning-evidence.json">原件字段映射及读取记录</a></p>'+
 p.originals.map(s=>'<p>原件 '+(s.source+1)+' · <a href="'+esc(pathToFileURL(s.path).href)+'">'+esc(s.path)+'</a> · SHA256 '+esc(s.sha256)+'</p>').join('')+
 '<p>JSON 行位从 0 起，工作表行号从 1 起。每份原件保留文件摘要、表头、字段及假设定位。</p>'));
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>增值税月结会计交接</title><style>body{font:15px/1.6 system-ui,sans-serif;margin:2rem;color:#162f39}section{overflow:auto;margin:2rem 0}table{border-collapse:collapse;font-size:14px}th,td{border:1px solid #b9c8c9;padding:5px 8px;vertical-align:top}th{background:#eff5f3}p{max-width:105ch;overflow-wrap:anywhere}a{color:#125c60}@media print{body{margin:0}section{overflow:visible}table{font-size:9px}}</style><main>'+parts.join('\n')+'</main></html>';
}
