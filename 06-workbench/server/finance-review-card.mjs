// 固定交付层：读取明确格式的派生账务与独立输入快照，不编排做账、不判断规则适用。
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const REVIEW_CARD_VERSION='cn-finance-review-card/1';
export const REVIEW_CARD_SCHEMA={type:'object',description:'可选固定中文账务卡片；quarter-ledger/v1 接受明确的科目/期初/月度发生及期末/凭证/报表 JSON，不解析任意文件。数据格式按需读自主计算参考。',additionalProperties:false,required:['format','dataPath'],properties:{
 format:{enum:['quarter-ledger/v1']},dataPath:{type:'string',minLength:1,maxLength:1000},
 bankSourceIndex:{type:'integer',minimum:0,maximum:63},findingsSourceIndex:{type:'integer',minimum:0,maximum:63},cashSourceIndex:{type:'integer',minimum:0,maximum:63}
}};
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=message=>{throw Object.assign(Error(message),{code:'finance_review_card_data_invalid'});};
const object=(v,name)=>{if(!v||typeof v!=='object'||Array.isArray(v))fail(name+' 必须为对象');return v;};
const list=(v,name,max=10000)=>{if(v==null)return null;if(!Array.isArray(v)||v.length>max)fail(name+' 必须为有界数组');return v;};
const string=(v,name)=>{if(typeof v!=='string'||v.length>8000)fail(name+' 必须为文本');return v;};
function money(v,name){if(v==null)return null;if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>9e12||Math.abs(v*100-Math.round(v*100))>0.001)fail(name+' 必须为两位精度有限数值或 null');return v;}
const sum=values=>values.some(x=>x==null)?null:values.reduce((s,x)=>s+Math.round(x*100),0)/100;
const diff=(a,b)=>a==null||b==null?null:(Math.round(a*100)-Math.round(b*100))/100;
const field=(row,key,name)=>money(row?.[key],name+'.'+key);
const known=v=>v!==null;
function reports(rows,name,keys){return list(rows,name)?.map((row,i)=>{object(row,name);const item=string(row.item,name+'.item');return {item,values:keys.map(k=>field(row,k,name+'.'+i)),sourcePointer:`/${name}/${i}`,heading:row.heading===true||/[：:]$/.test(item),bold:row.bold===true};})??null;}
function dateValue(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail('日期格式无效');return v;}
function parseBank(text,period,ledger,source,monthlyLedger){
 const headers=['交易日期','回单号','对方户名','用途摘要','收入','支出','交易后余额','关联单据'];let headerFound=false;const all=[];
 for(const [i,line]of text.split(/\r?\n/).entries()){
  const c=line.trim().split('|').slice(1,-1).map(x=>x.trim());
  if(c.length===headers.length&&c.every((v,j)=>v===headers[j])){headerFound=true;continue;}
  if(!headerFound||!line.trim().startsWith('|'))continue;
  if(c.length===8&&c.every(v=>/^:?-+:?$/.test(v)))continue;
  if(c.length!==8)fail('银行流水列数不符');
  const dateParts=c[0].match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(!dateParts)fail('银行表内交易日期无法识别，第 '+(i+1)+' 行');
  const amount=index=>{if(!/^-?\d+(\.\d{1,2})?$/.test(c[index]))fail('银行流水金额格式无效');return money(Number(c[index]),'银行流水');};
  all.push({date:dateValue(`${dateParts[1]}-${dateParts[2].padStart(2,'0')}-${dateParts[3].padStart(2,'0')}`),originalDate:c[0],receipt:c[1],counterparty:c[2],memo:c[3],inflow:amount(4),outflow:amount(5),balance:amount(6),related:c[7],line:i+1});
 }
 if(!headerFound)fail('仅支持合同指定的中文 Markdown 银行流水表头');
 if(all.some((r,i)=>i&&r.date<all[i-1].date))fail('银行流水必须按日期顺序');
 const rows=all.filter(r=>r.date>=period.start&&r.date<=period.end);
 const initial=text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*期初余额\s*([\d.]+)元/);
 const initialDate=initial?`${initial[1]}-${initial[2].padStart(2,'0')}-${initial[3].padStart(2,'0')}`:null;
 const previous=all.filter(r=>r.date<period.start).at(-1);
 const opening=initialDate===period.start?money(Number(initial[4]),'银行期初'):previous?.balance??null;
 let prior=opening;const mismatches=[];
 for(const r of rows){if(prior!==null&&diff(sum([prior,r.inflow,-r.outflow]),r.balance)!==0)mismatches.push(r.line);prior=r.balance;}
 const months=Object.keys(monthlyLedger).map(month=>{const selected=rows.filter(r=>Number(r.date.slice(5,7))===Number(month)),monthStart=period.start.slice(0,4)+'-'+month.padStart(2,'0')+'-01',before=rows.filter(r=>r.date<monthStart).at(-1),monthOpening=Number(month)===Number(period.start.slice(5,7))?opening:before?.balance??null;return {month,opening:monthOpening,inflow:selected.length?sum(selected.map(r=>r.inflow)):null,outflow:selected.length?sum(selected.map(r=>r.outflow)):null,ledger:monthlyLedger[month],statement:selected.at(-1)?.balance??null,difference:diff(monthlyLedger[month],selected.at(-1)?.balance??null)};});
 return {status:rows.length?'available':'missing',account:'指定流水账户（归属及完整性待核）',opening,inflow:rows.length?sum(rows.map(r=>r.inflow)):null,outflow:rows.length?sum(rows.map(r=>r.outflow)):null,statement:rows.at(-1)?.balance??null,ledger,difference:diff(ledger,rows.at(-1)?.balance??null),rows,months,mismatches,source,excludedRows:all.length-rows.length,scopeStatus:'输入快照的主体、账户归属及完整性待核；仅按明确账务期间筛选。'};
}

export function buildFinanceReviewCard(data,{dataSource,runId,callId,generatedAt,bankSource=null,findingsSource=null,cashSource=null}={}){
 object(data,'账务数据');object(data.meta,'meta');
 const company=string(data.meta.company,'meta.company'),periodText=string(data.meta.period,'meta.period');
 const dates=periodText.match(/^(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})$/);if(!dates)fail('meta.period 必须为 YYYY-MM-DD 至 YYYY-MM-DD');
 const period={start:dateValue(dates[1]),end:dateValue(dates[2])};if(period.start>period.end||period.start.slice(0,4)!==period.end.slice(0,4))fail('账务期间必须为同年顺序区间');
 const quarterEnds={'01-01':'03-31','04-01':'06-30','07-01':'09-30','10-01':'12-31'};
 if(quarterEnds[period.start.slice(5)]!==period.end.slice(5))fail('quarter-ledger/v1 仅适配完整自然季度');
 const accounts=list(data.accounts,'accounts',1000);if(!accounts?.length)fail('缺少科目目录');
 const codes=new Set();for(const a of accounts){object(a,'accounts');string(a.code,'科目编码');string(a.name,'科目名称');if(!a.code||codes.has(a.code))fail('科目编码空或重复');codes.add(a.code);}
 const opening=object(data.opening??{},'opening'),balances=object(data.balances??{},'balances');
 const months=Array.from({length:Number(period.end.slice(5,7))-Number(period.start.slice(5,7))+1},(_,i)=>String(Number(period.start.slice(5,7))+i));
 const raw=accounts.map(a=>({code:a.code,name:a.name,values:[field(opening[a.code],'debit','opening'),field(opening[a.code],'credit','opening'),sum(months.map(m=>money(balances[m]?.dr?.[a.code],`balances.${m}.dr`))),sum(months.map(m=>money(balances[m]?.cr?.[a.code],`balances.${m}.cr`))),field(balances[months.at(-1)]?.closing?.[a.code],'debit','closing'),field(balances[months.at(-1)]?.closing?.[a.code],'credit','closing')]}));
 // 本格式规定上级是目录、下级为原始分录归集，拒绝不明的预汇总值以免重复合计。
 for(const a of raw)if(raw.some(x=>x.code.startsWith(a.code+'.'))){
  // 不先跨月相加：缺月会把合计变为 null，不能掩盖其他月的非零目录值。
  const direct=[field(opening[a.code],'debit','opening'),field(opening[a.code],'credit','opening')];
  for(const m of months)direct.push(money(balances[m]?.dr?.[a.code],`balances.${m}.dr`),money(balances[m]?.cr?.[a.code],`balances.${m}.cr`),field(balances[m]?.closing?.[a.code],'debit','closing'),field(balances[m]?.closing?.[a.code],'credit','closing'));
  if(direct.some(v=>v!==null&&v!==0))fail('上级科目包含非零原始值，无法确定是否重复汇总：'+a.code);
 }
 const leaves=raw.filter(a=>!raw.some(x=>x.code.startsWith(a.code+'.'))),totals=Array.from({length:6},(_,i)=>sum(leaves.map(a=>a.values[i])));
 const rows=raw.map(a=>{const descendants=leaves.filter(x=>x.code===a.code||x.code.startsWith(a.code+'.'));return {...a,level:a.code.includes('.')?1:0,rollup:!leaves.includes(a),values:a.values.map((_,i)=>sum(descendants.map(x=>x.values[i])))};});
 const vouchers=list(data.vouchers,'vouchers')?.map((v,i)=>{object(v,'voucher');const lines=list(v.lines,'voucher.lines',1000);if(!lines)fail('凭证行缺失');const originalDate=string(v.date,'voucher.date');let normalizedDate=null;const parsed=originalDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(parsed){try{normalizedDate=dateValue(`${parsed[1]}-${parsed[2].padStart(2,'0')}-${parsed[3].padStart(2,'0')}`);}catch{}}
  return {month:v.month??null,no:string(v.no,'voucher.no'),date:originalDate,normalizedDate,periodState:normalizedDate===null?'invalid':normalizedDate<period.start||normalizedDate>period.end?'outside':'in_period',summary:string(v.summary,'voucher.summary'),sourcePointer:`/vouchers/${i}`,sources:list(v.sources,'voucher.sources',64)?.map(s=>string(s,'voucher.source'))??[],lines:lines.map(l=>{object(l,'voucher.line');if(!codes.has(l.code))fail('凭证科目不在目录');return {code:l.code,name:typeof l.name==='string'?l.name:l.code,debit:field(l,'debit','voucher'),credit:field(l,'credit','voucher')};})};})??null;
 const checks=[];
 for(const [a,b,label]of [[0,1,'期初借贷'],[2,3,'本期借贷'],[4,5,'期末借贷']])checks.push({name:label,difference:diff(totals[a],totals[b])});
 for(const a of rows){const v=a.values;checks.push({name:a.code+' 余额滚算',difference:v.every(known)?diff(sum([v[0],-v[1],v[2],-v[3]]),diff(v[4],v[5])):null});}
 const taxes=list(data.tax_rows,'tax_rows',1000)?.map((r,i)=>({code:typeof r.code==='string'?r.code:null,name:string(r.name,'tax_rows.name'),values:['opening','accrued','paid','closing'].map(k=>field(r,k,'tax_rows')),basis:typeof r.basis==='string'?r.basis:null,sourcePointer:`/tax_rows/${i}`}))??null;
 for(const v of vouchers??[])if(v.periodState!=='in_period')checks.push({name:`凭证 ${v.no} 日期 ${v.date} ${v.periodState==='invalid'?'无效或不明确':'不在本季度'}，未计入本期凭证核对`,difference:null,status:'mismatch'});
 for(const a of leaves){
  const lines=vouchers?.filter(v=>v.periodState==='in_period').flatMap(v=>v.lines).filter(l=>l.code===a.code);
  checks.push({name:a.code+' 凭证借方与科目发生',difference:lines?diff(sum(lines.map(l=>l.debit)),a.values[2]):null});
  checks.push({name:a.code+' 凭证贷方与科目发生',difference:lines?diff(sum(lines.map(l=>l.credit)),a.values[3]):null});
 }
 for(const t of taxes??[]){const v=t.values;checks.push({name:t.name+' 税费余额滚算',difference:v.every(known)?diff(sum([v[0],v[1],-v[2]]),v[3]):null});}
 const income=list(data.income,'income')?.map((row,i)=>{
  object(row,'income');const item=string(row.item,'income.item');let values;
  if(row.byMonth!==undefined){object(row.byMonth,'income.byMonth');values=months.map(m=>field(row.byMonth,m,'income.byMonth'));}
  else if(months[0]==='1')values=['jan','feb','mar'].map(k=>field(row,k,'income'));
  else{if(['jan','feb','mar'].some(k=>row[k]!=null))fail('非一季度利润表须使用 byMonth');values=months.map(()=>null);}
  return {item,values:[...values,field(row,'total','income')],sourcePointer:`/income/${i}`,heading:row.heading===true||/[：:]$/.test(item),bold:row.bold===true};
 })??null;
 const reportsData={income,balance:reports(data.balance_sheet,'balance_sheet',['begin','end']),cashflow:reports(data.cashflow,'cashflow',['amount'])};
 const bankLedger=rows.find(a=>a.code==='1002'),bankLeaves=leaves.filter(a=>a.code==='1002'||a.code.startsWith('1002.'));
 const monthlyBank=Object.fromEntries(months.map(m=>[m,bankLeaves.length?diff(sum(bankLeaves.map(a=>field(balances[m]?.closing?.[a.code],'debit','bank.closing'))),sum(bankLeaves.map(a=>field(balances[m]?.closing?.[a.code],'credit','bank.closing')))):null]));
 const bank=bankSource?parseBank(bankSource.text,period,bankLedger?diff(bankLedger.values[4],bankLedger.values[5]):null,bankSource.reference,monthlyBank):{status:'missing',rows:[],scopeStatus:'未指定独立银行输入快照；不使用账务结果中的对账单值自证。'};
 checks.push({name:'银行账面与指定流水期末',difference:bank.difference??null});
 for(const month of bank.months??[])checks.push({name:month.month+' 月银行账面与指定流水期末',difference:month.difference});
 checks.push({name:'银行期初加收支与期末',difference:bank.status==='available'?diff(sum([bank.opening,bank.inflow,bank.outflow===null?null:-bank.outflow]),bank.statement):null});
 // 每笔滚算异常保留具体行；不能被最终余额恰巧相等掩盖。
 for(const line of bank.mismatches??[])checks.push({name:'银行流水第 '+line+' 行滚算异常',difference:null,status:'mismatch'});
 const cash=rows.find(a=>a.code==='1001');
 let cashCount=null;if(cashSource){object(cashSource.value,'现金盘点');if(cashSource.value.periodEnd!==period.end)fail('现金盘点期间与账务期末不符');cashCount=money(cashSource.value.countedAmount,'countedAmount');if(cashCount===null)fail('现金盘点金额缺失');}
 checks.push({name:'库存现金账面与盘点输入',difference:diff(cash?diff(cash.values[4],cash.values[5]):null,cashCount)});
 const findings=findingsSource?list(object(findingsSource.value,'复核记录').findings,'findings',1000)?.map(r=>({severity:string(r.severity,'findings.severity'),finding:string(r.finding,'findings.finding')})):null;
 const spec={version:REVIEW_CARD_VERSION,format:'quarter-ledger/v1',company,period,months,generatedAt,runId,callId,businessStatus:'unreviewed',provenance:{data:dataSource,bank:bankSource?.reference??null,findings:findingsSource?.reference??null,cash:cashSource?.reference??null,rendererSha256:sha(readFileSync(fileURLToPath(import.meta.url)))},accounts:rows,totals,vouchers,checks,taxes,taxTotals:taxes?Array.from({length:4},(_,i)=>sum(taxes.map(t=>t.values[i]))):null,reports:reportsData,bank,cash:{opening:cash?diff(cash.values[0],cash.values[1]):null,inflow:cash?.values[2]??null,outflow:cash?.values[3]??null,closing:cash?diff(cash.values[4],cash.values[5]):null,count:cashCount,difference:diff(cash?diff(cash.values[4],cash.values[5]):null,cashCount),status:cashSource?'已列输入差额，盘点真实性待核':'未核实'},findings:findings??null};
 return spec;
}

export function renderFinanceReviewCard(spec){
 const content=JSON.stringify(spec).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>账务复核卡片</title><style>
 :root{font:14px 'Microsoft YaHei',sans-serif;color:#20332f;background:#f3f5f2}*{box-sizing:border-box}body{margin:0}header{background:#173e35;color:white;padding:28px 4.5%}h1{font-size:26px;margin:8px 0 12px}header p{color:#cee0d7}main{max-width:1440px;margin:auto;padding:24px 4.5%}.status{background:#fff7e7;border:1px solid #e6d6b1;padding:13px 16px;color:#76531b;border-radius:5px;line-height:1.8}summary{cursor:pointer}.top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:24px 0 14px}h2{font-size:18px;margin:0}.muted{color:#7b8580;font-size:12px}.wrap{overflow-x:auto;background:white;border:1px solid #d9e1da;border-radius:5px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:11px 14px;border-bottom:1px solid #e8ece6;text-align:left}th{background:#eaf0e9;font-weight:500;white-space:nowrap}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.group,tfoot{font-weight:600}tfoot{background:#eef4ec}tbody tr:hover{background:#f7faf6}input,select,button{font:inherit}input,select,button{padding:8px;border:1px solid #cdd7cf;background:white;color:#315e4b;border-radius:4px}button{cursor:pointer}.money{padding:0;border:0;border-bottom:1px dotted #9ab4a4;border-radius:0;background:none;font-variant-numeric:tabular-nums}.foot{font-size:12px;color:#758278;line-height:1.8;margin:9px 0 22px}.tabs{display:flex;gap:8px;margin:12px 0}.tabs .active{background:#173e35;color:white}.hide{display:none}.cash{display:flex;gap:20px;background:white;padding:18px;border:1px solid #d9e1da;flex-wrap:wrap}.cash label{display:block;color:#718177;font-size:12px;margin-bottom:8px}footer{border-top:1px solid #d8e0d6;padding:16px 0;font-size:12px;color:#758278;overflow-wrap:anywhere}dialog{width:min(1100px,94vw);max-height:88vh;border:1px solid #c5d2c7;border-radius:7px;padding:24px}dialog::backdrop{background:#17362c70}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f2;padding:14px;font:12px/1.8 monospace}details.trace{margin:12px 0;border:1px solid #d7dfd4;padding:10px}@media(max-width:800px){main{padding:16px}.top{align-items:flex-start;flex-direction:column}td,th{padding:9px}}@media print{input,select,button,.tabs{display:none}.money{display:inline;color:black;border:0}.hide{display:block}body,header{background:white;color:black}.status{display:block}.status>*{display:block!important}.wrap{overflow:visible}td,th{padding:5px}main{padding:0}}
 </style></head><body><header><div>固定账务复核卡片</div><h1 id="company"></h1><p id="period"></p></header><main>
 <details class="status" id="issues"><summary id="issueTitle"></summary><div id="findings"></div><p>数值核对不等于业务正确；账务尚未人工验收，不代表已入账或已申报。</p></details>
 <section><div class="top"><h2>科目余额表</h2><div><select id="level" aria-label="科目层级"><option value="main">总账科目</option><option value="all">总账及明细</option></select> <input id="search" placeholder="搜索编码或科目名称" aria-label="搜索科目"></div></div><div class="wrap"><table><thead><tr><th>编码</th><th>科目名称</th><th class="num">期初借方</th><th class="num">期初贷方</th><th class="num">本期借方</th><th class="num">本期贷方</th><th class="num">期末借方</th><th class="num">期末贷方</th></tr></thead><tbody id="accounts"></tbody><tfoot id="total"></tfoot></table></div><p class="foot">点击金额查看凭证。上级汇总其明细；合计只计算末级科目。本期发生额按输入账簿原值展示，结转状态以实际凭证为准。</p></section>
 <section><div class="top"><h2>银行核对</h2><button id="bankButton">查看输入流水</button></div><div id="bank"></div><p class="foot" id="bankNote"></p><h3>库存现金</h3><div class="cash" id="cash"></div><p class="foot">盘点金额仅来自指定独立输入快照；账面金额不能证明实盘，输入真实性待核。</p></section>
 <section><div class="top"><h2>税费余额</h2><span class="muted">账面余额，不代表已申报</span></div><div id="taxes"></div></section>
 <section><div class="top"><h2>财务报表</h2></div><div class="tabs"><button data-tab="income" class="active">利润表</button><button data-tab="balance">资产负债表</button><button data-tab="cashflow">现金流量表</button></div><div id="income" class="report"></div><div id="balance" class="report hide"></div><div id="cashflow" class="report hide"></div></section><footer id="footer"></footer></main><dialog id="detail"><button id="close">关闭</button><h3 id="detailTitle"></h3><div id="detailBody"></div></dialog><script>
 const D=${content};
 const el=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt=x=>x==null?'未提供':x.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
 const td=x=>'<td class="num">'+fmt(x)+'</td>',button=(x,kind,index,field)=>'<td class="num"><button class="money" data-kind="'+kind+'" data-index="'+index+'" data-field="'+field+'">'+fmt(x)+'</button></td>';
 const table=(heads,body,foot='')=>'<div class="wrap"><table><thead><tr>'+heads.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody>'+foot+'</table></div>';
 el('company').textContent=D.company;el('period').textContent='所属期间：'+D.period.start+' 至 '+D.period.end+' · 人民币元';
 const errors=D.checks.filter(c=>(c.difference!==null&&c.difference!==0)||c.status==='mismatch'),missing=D.checks.filter(c=>c.difference===null&&c.status!=='mismatch');
 el('issueTitle').textContent=(D.findings===null?'外部复核记录未提供':D.findings.length+' 项外部复核记录')+'；'+errors.length+' 项数值差额、'+missing.length+' 项缺数核对';
 el('findings').innerHTML=(D.findings===null?'<p>未提供外部复核记录，不能据此认定没有问题。</p>':'<p>以下来自指定复核输入，来源及结论待核，不是系统自动发现的业务错误。</p><ul>'+D.findings.map(f=>'<li><b>'+esc(f.severity)+'</b>：'+esc(f.finding)+'</li>').join('')+'</ul>')+errors.map(c=>'<p>'+esc(c.name)+(c.difference===null?'，需要核查':'差额：'+fmt(c.difference))+'</p>').join('')+missing.map(c=>'<p>'+esc(c.name)+'：缺少核对数据</p>').join('');
 function accounts(){const q=el('search').value.trim();el('accounts').innerHTML=D.accounts.map((a,i)=>({a,i})).filter(({a})=>(el('level').value==='all'||a.level===0||q)&&(a.name.includes(q)||a.code.includes(q))).map(({a,i})=>'<tr class="'+(a.level===0?'group':'')+'"><td>'+esc(a.code)+'</td><td>'+esc(a.name)+'</td>'+a.values.map((x,f)=>button(x,'account',i,f)).join('')+'</tr>').join('');el('total').innerHTML='<tr><td colspan="2">全部科目合计（不随筛选改变）</td>'+D.totals.map(td).join('')+'</tr>';}
 el('search').addEventListener('input',accounts);el('level').addEventListener('change',accounts);accounts();
 el('bank').innerHTML=D.bank.status==='missing'?'<p>未提供可用的独立银行流水，未核实。</p>':table(['账户','期初余额','收入','支出','账面期末','流水期末','差额'],[...D.bank.months.map(m=>({...m,label:m.month+' 月'})),{...D.bank,label:'季度汇总'}].map(r=>'<tr><td>'+esc(r.label)+'</td>'+['opening','inflow','outflow','ledger','statement','difference'].map(k=>td(r[k])).join('')+'</tr>').join(''));
 el('bankNote').textContent=D.bank.scopeStatus+(D.bank.excludedRows?' 已排除期间外 '+D.bank.excludedRows+' 笔。':'')+(D.bank.mismatches?.length?' 流水滚算不符行：'+D.bank.mismatches.join('、'):'');
 el('cash').innerHTML=[['期初账面','opening'],['本期收入','inflow'],['本期支出','outflow'],['期末账面','closing'],['实际盘点','count'],['差额','difference']].map(([label,k])=>'<div><label>'+label+'</label><strong>'+fmt(D.cash[k])+'</strong></div>').join('')+'<div><label>账实核对</label><strong>'+esc(D.cash.status)+'</strong></div>';
 el('taxes').innerHTML=D.taxes===null?'<p>税费余额未提供。</p>':table(['税费','期初未缴','本期计提 / 代扣','本期缴纳','期末未缴'],D.taxes.map((r,i)=>'<tr><td>'+esc(r.name)+'</td>'+r.values.map((x,f)=>button(x,'tax',i,f)).join('')+'</tr>').join(''),'<tfoot><tr><td>合计</td>'+D.taxTotals.map(td).join('')+'</tr></tfoot>');
 for(const [id,labels]of [['income',[...D.months.map(m=>m+'月'),'季度累计']],['balance',['年初余额','季末余额']],['cashflow',['季度累计']]]){const rows=D.reports[id];el(id).innerHTML=rows===null?'<p>报表未提供。</p>':table(['项目',...labels],rows.map((r,i)=>'<tr class="'+(r.bold?'group':'')+'"><td>'+esc(r.item)+'</td>'+r.values.map((x,f)=>x===null?'<td class="num">'+(r.heading?'—':'未提供')+'</td>':button(x,id,i,f)).join('')+'</tr>').join(''));}
 document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.report').forEach(r=>r.classList.add('hide'));el(b.dataset.tab).classList.remove('hide');document.querySelectorAll('[data-tab]').forEach(x=>x.classList.remove('active'));b.classList.add('active');}));
 const trace=()=>'<details class="trace"><summary>执行与输入版本</summary><pre>'+esc(JSON.stringify({runId:D.runId,callId:D.callId,version:D.version,provenance:D.provenance},null,2))+'</pre></details>';
 function vouchers(code){if(!D.vouchers)return '<p>凭证明细未提供。</p>';const rows=D.vouchers.map(v=>({...v,selected:v.lines.filter(l=>l.code===code||l.code.startsWith(code+'.'))})).filter(v=>v.selected.length);return table(['日期 / 凭证','摘要','借方','贷方'],rows.map(v=>'<tr><td>'+esc(v.date)+' / '+esc(v.no)+(v.periodState==='in_period'?'':'（日期待核，未参与本期核对）')+'</td><td>'+esc(v.summary)+'<br><span class="muted">'+esc(v.sourcePointer)+'；输入引用：'+esc(v.sources.join('、'))+'</span></td>'+td(v.selected.some(l=>l.debit==null)?null:v.selected.reduce((s,l)=>s+l.debit,0))+td(v.selected.some(l=>l.credit==null)?null:v.selected.reduce((s,l)=>s+l.credit,0))+'</tr>').join(''));}
 function show(title,body){el('detailTitle').textContent=title;el('detailBody').innerHTML=body;el('detail').showModal();}
 document.addEventListener('click',e=>{const b=e.target.closest('[data-kind]');if(!b)return;const i=Number(b.dataset.index),f=Number(b.dataset.field),kind=b.dataset.kind;
 if(kind==='account'){const a=D.accounts[i],labels=['期初借方','期初贷方','本期借方','本期贷方','期末借方','期末贷方'];show(a.code+' '+a.name,'<p><b>'+labels[f]+'：'+fmt(a.values[f])+'</b></p><p>下列为该科目全期凭证；期初和期末须结合期初余额核对。</p>'+vouchers(a.code)+'<details class="trace"><summary>规则与参数</summary><p>此格式未提供逐笔规则与原字段映射；系统不猜测。</p></details>'+trace());}
 else if(kind==='tax'){const t=D.taxes[i],labels=['期初未缴','本期计提 / 代扣','本期缴纳','期末未缴'];show(t.name+' · '+labels[f],'<p><b>'+labels[f]+'：'+fmt(t.values[f])+'</b></p><p>来源：'+esc(t.sourcePointer)+'。以下科目凭证仅供辅助核查，不意味着全部借方就是缴纳或全部贷方就是净计提。</p>'+(t.code?vouchers(t.code):'<p>科目映射未提供。</p>')+'<details class="trace"><summary>原结果所附余额依据（不能代替全期发生公式）</summary><p>'+esc(t.basis??'未提供')+'</p></details>'+trace());}
 else{const r=D.reports[kind][i];show(r.item,'<p><b>'+fmt(r.values[f])+'</b></p><p>取数位置：'+esc(r.sourcePointer)+'；列 '+(f+1)+'。</p><p>未提供该报表单元格到凭证的完整映射；不得据此声称逐格追溯完成。</p>'+trace());}});
 el('bankButton').addEventListener('click',()=>show('指定输入流水',table(['日期 / 回单','对方 / 摘要','收入','支出','余额'],D.bank.rows.map(r=>'<tr><td>'+esc(r.date)+' / '+esc(r.receipt)+'</td><td>'+esc(r.counterparty)+' · '+esc(r.memo)+'<br><span class="muted">源文件第 '+r.line+' 行；'+esc(r.related)+'</span></td>'+td(r.inflow)+td(r.outflow)+td(r.balance)+'</tr>').join(''))+trace()));
 el('close').addEventListener('click',()=>el('detail').close());let priorOpen=false;window.addEventListener('beforeprint',()=>{priorOpen=el('issues').open;el('issues').open=true;});window.addEventListener('afterprint',()=>el('issues').open=priorOpen);
 el('footer').textContent='模板 '+D.version+' · 账务摘要 '+D.provenance.data.sha256+' · 生成时间 '+new Date(D.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）。由系统固定取数渲染；规则选择、参数及执行日志保留后台，不在主界面重复展示。';
 </script></body></html>`;
}
