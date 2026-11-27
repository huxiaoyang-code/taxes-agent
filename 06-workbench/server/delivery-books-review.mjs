// 交付文件与同一 SQLite 只读快照逐行核对。金额接口为整数分字符串。
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {parseCsv} from './csv-rows.mjs';
import {formatCents,parseMoney,storedCents} from './money.mjs';
import {accountSetProfileForControls} from './period-end-controls.mjs';
import {balanceReviewSource,getAccountingReportRules,resolveAccountingAccountRule,evaluateAccountingStatement} from './accounting-report-rules.mjs';
import {readDeliveryWorkbook} from './delivery-workbook.mjs';
import {nativeBooks} from './finance-delivery-check.mjs';
import {identifyTrialBalances,reviewTrialBalances} from './delivery-trial-review.mjs';
import {expensePostings} from './delivery-stock-expense-proof.mjs';

const numberMinor = cents => {
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) throw Error('book_amount_out_of_range');
  return n;
};
const asMinor = value => {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(String(raw))) return null;
  const money = parseMoney(typeof raw === 'string' ? raw.replaceAll(',','') : raw,{allowEmpty:false,allowNegative:true,maxCents:null});
  return money.ok && !money.subCent ? money.cents.toString() : null;
};
const balanced = report => report.totals.assets !== undefined && BigInt(report.totals.assets) === BigInt(report.totals.liabilities) + BigInt(report.totals.equity);

function readSnapshot(db,binding,withNativeTrial) {
  const {accountSetId,period,enterpriseKey,databaseInstanceId} = binding.scope;
  const instances = db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').all();
  const owners = db.prepare('SELECT * FROM import_enterprise_account_sets WHERE account_set_id=?').all(accountSetId);
  if (instances.length !== 1 || instances[0].instance_id !== databaseInstanceId || owners.length !== 1 || owners[0].enterprise_key !== enterpriseKey) throw Error('delivery_identity_changed');
  const {profile,set} = accountSetProfileForControls(db,accountSetId);
  const registered = db.prepare('SELECT status FROM periods WHERE account_set_id=? AND period=?').get(accountSetId,period);
  if (!registered || period < set.start_period) throw Error('delivery_period_unregistered');
  const accounts = db.prepare('SELECT code,name,direction,category,contra FROM accounts WHERE account_set_id=? ORDER BY code').all(accountSetId).map(row=>({...row,contra:!!row.contra}));
  const opening = db.prepare('SELECT code,debit,credit FROM opening_balances WHERE account_set_id=? ORDER BY code').all(accountSetId);
  // 以凭证作左表，保留零分录凭证，并让凭证状态及分录变更进入相同版本摘要。
  const voucherSummary=db.prepare('PRAGMA table_info(vouchers)').all().some(c=>c.name==='summary')?'v.summary':'NULL';
  const entries = db.prepare(`SELECT v.id AS voucherId,v.period,v.voucher_date,v.kind,v.status,v.word,v.number,${voucherSummary} AS voucherSummary,e.line_no AS line,e.code,e.debit,e.credit
    FROM vouchers v LEFT JOIN voucher_entries e ON v.id=e.voucher_id
    WHERE v.account_set_id=? AND v.period<=? ORDER BY v.period,v.id,e.line_no`).all(accountSetId,period);
  const taxIds = ['taxpayer_id','taxpayer_number','taxpayer_no','credit_code','tax_id'].map(k=>set[k]).filter(v=>typeof v === 'string' && v.trim());
  const enterpriseName = owners[0].enterprise_name || set.name || null;
  const nameBasis = owners[0].enterprise_name ? 'registered_enterprise_name' : 'bound_account_set_name';
  const bookDigest = createHash('sha256').update(JSON.stringify([binding.scope,registered.status,set.name,set.accounting_standard,profile.id,profile.reportMappingVersion,enterpriseName,taxIds,accounts,opening,entries])).digest('hex');
  const nativeTrial=withNativeTrial?nativeBooks(db,accountSetId,period):null;
  return {accounts,opening,entries,profile,set,period,enterpriseName,nameBasis,taxIds,bookDigest,nativeTrial};
}

function buildBalances(snapshot,add) {
  const {accounts,opening,entries,period} = snapshot;
  const amounts = new Map(accounts.map(a=>[a.code,{opening:0n,debit:0n,credit:0n,closing:0n}]));
  for (const row of opening) {
    const net = storedCents(row.debit)-storedCents(row.credit);
    if (net === 0n) continue;
    const account = amounts.get(row.code);
    if (!account) {add('book_opening_unknown_account','bookkeeper','期初/'+row.code);continue;}
    account.opening += net;
    account.closing += net;
  }
  const vouchers = new Map();
  for (const entry of entries) {
    const {voucherId,code,status,line} = entry;
    const voucher = vouchers.get(voucherId) ?? {status,period:entry.period,date:entry.voucher_date,number:entry.number,summary:entry.voucherSummary??'',debit:0n,credit:0n,lines:[]};
    vouchers.set(voucherId,voucher);
    if (line == null || status !== 'posted') continue;
    const debit = storedCents(entry.debit), credit = storedCents(entry.credit);
    const location = '凭证/'+voucherId+'/'+line;
    voucher.lines.push({code,debit,credit});
    voucher.debit += debit;
    voucher.credit += credit;
    // 红字冲销允许同侧负数。借贷同列填数仍需核实。
    if (debit!==0n && credit!==0n) add('book_entry_amount_invalid','bookkeeper',location);
    const account = amounts.get(code);
    if (!account) {add('book_entry_unknown_account','bookkeeper',location);continue;}
    account.closing += debit-credit;
    if (entry.period < period) account.opening += debit-credit;
    else {account.debit+=debit;account.credit+=credit;}
  }
  let posted = 0, pending = 0;
  for (const [id,v] of vouchers) {
    if (v.status === 'posted') {
      if (!v.lines.length || v.debit!==v.credit) add('book_posted_voucher_invalid','bookkeeper','凭证/'+id,v.debit.toString(),v.credit.toString());
      if (v.period===period) posted++;
    } else if (v.status!=='superseded' && v.period===period) {
      pending++;
      add('book_voucher_not_posted','bookkeeper','凭证/'+id,v.status,'posted');
    }
  }
  return {amounts,vouchers,posted,pending};
}

function inventoryPurchasePostings(snapshot,vouchers,goods) {
  const inventory=new Set(goods.map(a=>a.code));
  const payable=snapshot.profile.coa.find(a=>a.name==='应付账款' && a.scope?.status==='mapped');
  if(!payable)return [];
  const suppliers=new Map(snapshot.accounts.filter(a=>a.code.startsWith(payable.code) &&
    /^\d+$/u.test(a.code.slice(payable.code.length))).map(a=>[a.code,a.name]));
  const postings=[];
  for(const [voucherId,v] of vouchers) {
    if(v.status!=='posted' || v.period!==snapshot.period)continue;
    for(const line of v.lines){
      const seller=suppliers.get(line.code);
      if(!seller || line.credit<=0n)continue;
      const simple=v.lines.length===2 && v.debit===line.credit && v.credit===line.credit && line.debit===0n &&
        v.lines.some(l=>inventory.has(l.code) && l.debit===line.credit && l.credit===0n);
      postings.push({voucherId,date:v.date,seller,grossMinor:String(line.credit),summary:simple?v.summary:''});
    }
  }
  return postings;
}

function vatBridge(snapshot,amounts,vouchers) {
  const {accounts,period} = snapshot;
  // 仅认登记的增值税明细及其数字下级。2221 整类包含其他税种。
  const roots = accounts.filter(a=>/^2221\d*$/.test(a.code) && /^(?:(?:应交|应缴)税费[-—/／])?(?:应交增值税|未交增值税|简易计税|预交增值税)$/.test(a.name)).map(a=>a.code);
  if (!roots.length) return null;
  const vat = new Set(accounts.filter(a=>roots.some(root=>a.code===root || a.code.startsWith(root)&&/^\d+$/.test(a.code.slice(root.length)))).map(a=>a.code));
  const parent = amounts.get('2221');
  if (!vat.has('2221') && (parent?.opening || parent?.closing || [...vouchers.values()].some(v=>v.period===period && v.lines.some(l=>l.code==='2221')))) return null;
  const byCode=new Map(accounts.map(a=>[a.code,a]));
  const title=code=>byCode.get(code)?.name.split(/[-—/／]/u).at(-1)?.trim();
  const unpaidRoots=accounts.filter(a=>vat.has(a.code)&&title(a.code)==='未交增值税').map(a=>a.code);
  const unpaid=new Set([...vat].filter(code=>unpaidRoots.some(root=>code===root||code.startsWith(root)&&/^\d+$/.test(code.slice(root.length)))));
  // 有独立未交科目时从该明细取领缴余额。进项、销项及转出科目不得混入未缴栏。
  // 没有未交科目时只接受独立简易总账；细分进销项但缺少转结依据时不能断定应缴。
  if(!unpaid.size && [...vat].some(code=>!roots.includes(code)))return null;
  const payable=unpaid.size?unpaid:vat;
  let opening = 0n, closing = 0n, paid = 0n, current = 0n;
  for (const code of payable) { opening -= amounts.get(code).opening; closing -= amounts.get(code).closing; }
  for (const v of vouchers.values()) {
    if (v.period!==period || v.status!=='posted') continue;
    const taxLines = v.lines.filter(l=>payable.has(l.code));
    if(!taxLines.length) continue;
    if(v.debit!==v.credit) return null;
    const bank = l=>/^100[12]\d*$/.test(l.code);
    const delta = taxLines.reduce((n,l)=>n+l.credit-l.debit,0n);
    if(delta===0n) continue;
    if(delta<0n && v.lines.some(l=>bank(l)&&l.credit>0n)) {
      // 所有贷方均为资金支出时，可按未交增值税独立借方确定缴税款；
      // 混有其他贷方，或总账应交增值税与进货成本共同借记，均不能直接归因为实缴。
      if(taxLines.some(l=>l.credit!==0n || l.debit<0n) ||
        !v.lines.every(l=>l.debit>=0n && l.credit>=0n && (l.credit===0n || bank(l))) ||
        (!unpaid.size && v.lines.some(l=>l.debit>0n && !/^2221\d*$/.test(l.code)))) return null;
      paid -= delta;
    } else if(delta>0n && v.lines.some(l=>bank(l)&&l.debit>0n)) {
      // 专设未交科目对应现金收回须查明退抵税所属期；销售收款直接贷记总账应交允许计提。
      if(unpaid.size || !v.lines.some(l=>l.credit>0n && !vat.has(l.code) && !bank(l)))return null;
      current+=delta;
    } else {
      current+=delta;
    }
  }
  if(opening+current-paid!==closing)return null;
  return {openingMinor:String(opening),currentMinor:String(current),paidMinor:String(paid),closingMinor:String(closing)};
}

// 在两侧总计追溯基础行参与的次数及符号。仅检查借贷相抵会漏过两侧同时漏项。
function contributions(rules) {
  const byId = new Map(rules.rows.map(r=>[r.rowId,r])), uses = new Map();
  function visit(id,sign) {
    const row=byId.get(id);
    if (!row) return;
    if (row.terms) {
      for (const term of row.terms) visit(term.rowId,sign*term.sign);
    } else {
      const leaf = uses.get(id) ?? {count:0,weight:0};
      leaf.count++;
      leaf.weight += row.natural==='credit' ? -sign : sign;
      uses.set(id,leaf);
    }
  }
  visit(rules.totals.assets,1);
  visit(rules.totals.liabilitiesAndEquity,-1);
  return uses;
}

function evaluateWindow(snapshot,amounts,window,rules,uses,coverage,add) {
  const accounts = snapshot.accounts, profileId = snapshot.profile.id;
  const active = accounts.filter(a=>amounts.get(a.code)[window]!==0n);
  const report=evaluateAccountingStatement(profileId,{kind:'balance-sheet',accounts,amounts:active.map(a=>({code:a.code,netMinor:numberMinor(amounts.get(a.code)[window])}))});
  const failures=new Map(report.diagnostics.map(d=>[d.accountCode,d]));
  const reclass = new Map(report.reclassifications.map(r=>[r.accountCode,r.toRowId]));
  let omittedForDetail=0n, hasUnexplainedMapping=false;
  const missingDetails=[];
  for(const account of active){
    const resolved=resolveAccountingAccountRule(profileId,account), diagnosis=failures.get(account.code);
    const net=amounts.get(account.code)[window], location=window+'/'+account.code;
    const matches=rules.rows.filter(r=>r.roots?.includes(resolved.matchedRoot));
    const rowId=reclass.get(account.code) ?? resolved.statements.balanceSheet?.rowId ?? null;
    const use=uses.get(rowId);
    const rowError=!rowId || !matches.length || !use ? 'native_account_omitted' :
      matches.length!==1 || use.count!==1 || use.weight!==1 ? 'native_account_multiple_or_wrong_sign' : null;
    const reason=diagnosis?.code ?? rowError;
    const presented=diagnosis ? diagnosis.presentedRowId===rowId && !rowError : !rowError;
    if (diagnosis?.presentedRowId && rowError) add(rowError,'product',location,String(net));
    coverage.push({window,account:account.code,accountName:account.name,category:account.category,direction:account.direction,netMinor:String(net),root:resolved.matchedRoot,row:presented ? rowId : null,
      ...(reason?{reason}:{}),...(reclass.has(account.code)?{reclassifiedFrom:resolved.statements.balanceSheet?.rowId}:{})});
    if(reason){
      const owner=diagnosis && ['account_direction_conflict','account_category_conflict','account_contra_conflict'].includes(reason)?'bookkeeper':
        ['account_reverse_balance_requires_detail','account_requires_detail'].includes(reason)?'accountant':'product';
      if (!presented) {
        if (owner==='accountant' && diagnosis && !diagnosis.presentedRowId) {
          omittedForDetail+=net;
          missingDetails.push(account.code);
        } else hasUnexplainedMapping=true;
      }
      const rowLabel=presented ? matches[0]?.label : null;
      const note=owner==='accountant'
        ? (rowLabel ? `已按账面列入「${rowLabel}」。` : '余额尚待列报。')+balanceReviewSource(diagnosis?.reason)
        : diagnosis?.reason;
      add(reason,owner,location,String(net),undefined,note);
    }
  }
  const trial=[...amounts.values()].reduce((sum,amount)=>sum+amount[window],0n);
  if(trial!==0n)add('book_trial_balance_difference','bookkeeper',window,String(trial),'0');
  if(!balanced(report)){
    const assets=BigInt(report.totals.assets), funding=BigInt(report.totals.liabilities)+BigInt(report.totals.equity);
    // 仅当试算平衡、其余行正确且待明细净额逐分解释差额，才由会计查明原因。
    const detailExplains=trial===0n && !hasUnexplainedMapping && missingDetails.length>0 && assets-funding===-omittedForDetail;
    add(detailExplains?'native_balance_sheet_detail_gap':'native_balance_sheet_unbalanced',detailExplains?'accountant':'product',window,String(assets),String(funding),
      detailExplains?`差额由 ${missingDetails.length} 项待明细科目的未列金额解释（借正贷负合计 ${omittedForDetail} 分），见同期间逐科目待核项。`:undefined);
  }
  return report;
}

const summaryRows = {assets:'total-assets',liabilities:'total-liabilities',equity:'total-equity',cash:'cash',receivables:'accounts-receivable',inventory:'inventory',fixedAssetsNet:'fixed-assets-net'};
const summaryProfiles={'small-2011-basic-v1':'small_basic_v1','enterprise-2019-general-basic-v1':'enterprise_basic_v1','legacy-small-coa-v1':'legacy_small_v1'};
const totalIds = new Set(['total-assets','total-liabilities','total-equity','total-liabilities-and-equity']);
const normalized = value => String(value??'').trim().normalize('NFKC').replaceAll(' ','');
const truth = value => ['是','true','TRUE'].includes(String(value)) ? true : ['否','false','FALSE'].includes(String(value)) ? false : null;
function compareValue(raw,expected,location,add) {
  const actual=asMinor(raw);
  if(actual===null || actual!==String(expected)) add('statement_amount_mismatch','bookkeeper',location,actual??'金额缺失或精度未核',String(expected));
  return actual;
}

// 交接页也可能以一段文字重复列示本期三项总额，只核完整、同口径且明确以元计的数列。
const summaryMoney=String.raw`\s*[:=]?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*元?`;
const summarySep=String.raw`\s*[;，,、|]\s*`;
const statementClaim=new RegExp('^(?:(?:本期|期末|本期末|资产负债表|账面底稿|账面|原生报表|本期账载)[: ]*)*资产(?:总计|合计)?'+summaryMoney+summarySep+'负债(?:总计|合计)?'+summaryMoney+summarySep+'(?:所有者)?权益(?:总计|合计)?'+summaryMoney+'(?=$|[;，,、|。])','u');
const statedGap=new RegExp('^'+summarySep+'(?:平衡差额|平衡|资产减负债及权益)'+summaryMoney+'(?=$|[;，,、|。])','u');
function reviewRepeatedTotals(name,rows,state,add){
  for(const row of rows){
    if(row.cells.some(c=>typeof c==='string' && /期初|上期|上月|上年|历史|原版|旧版|修前|假设|测算|预算|调整前|万元|亿元/u.test(c)))continue;
    for(const [column,cell] of row.cells.entries()){
      if(typeof cell!=='string'||!cell.includes('资产')||!cell.includes('权益'))continue;
      const line=cell.trim().normalize('NFKC'),match=statementClaim.exec(line);
      if(!match)continue;
      for(const [i,key] of ['assets','liabilities','equity'].entries()){
        const claimed=asMinor(match[i+1]),expected=state.current.totals[key];
        if(claimed!==String(expected))add('statement_repeated_total_mismatch','bookkeeper',name+'/'+row.number+'/'+(column+1),
          match[i+1]+' 元',formatCents(BigInt(expected))+' 元','修订附表中重复列出的'+['资产总计','负债合计','所有者权益合计'][i]+'，并重读各处引用。');
      }
      const gap=statedGap.exec(line.slice(match[0].length));
      const balance=BigInt(state.current.totals.assets)-BigInt(state.current.totals.liabilitiesAndEquity);
      if(gap && asMinor(gap[1])!==String(balance))add('statement_repeated_total_mismatch','bookkeeper',name+'/'+row.number+'/'+(column+1),
        gap[1]+' 元',formatCents(balance)+' 元','按本期原生报表重算附表所列平衡差额。');
    }
  }
}

function reviewSheet(name,rows,state,seenDocuments,add) {
  const {current,opening,profile,scope,set,rules}=state;
  const data = rows.map(r=>r.cells.map(normalized));
  for (const match of name.matchAll(/(?:^|[^\d])(20\d\d-(?:0[1-9]|1[0-2]))(?=$|[^\d])/g)) {
    if(match[1]!==scope.period)add('statement_period_mismatch','bookkeeper',name,match[1],scope.period);
  }
  const isSummary=data.some(c=>c[0]==='assets') && data.some(c=>c[0]==='liabilities');
  const actual=new Map();
  const fullName = name;
  if(isSummary) {
    const byId=new Map(current.rows.map(r=>[r.id,r.valueMinor]));
    const flags={balanced:balanced(current),complete:state.complete};
    for(const [key,id] of Object.entries(summaryRows)){
      const matches=data.flatMap((r,i)=>r[0]===key?[i]:[]);
      if(!matches.length && !['assets','liabilities','equity'].includes(key)) continue;
      if(matches.length!==1){add('statement_summary_missing_or_duplicate','bookkeeper',name+'/'+key);continue;}
      const i=matches[0];
      actual.set(id,compareValue(rows[i].cells[1],byId.get(id),name+'/'+rows[i].number+'/'+key,add));
    }
    for(const [key,value] of Object.entries(flags)){
      const matches=data.filter(r=>r[0]===key);
      if(key==='complete' && !matches.length)continue;
      if(matches.length!==1 || truth(matches[0][1])!==value) add('statement_summary_status_mismatch','bookkeeper',name+'/'+key,matches[0]?.[1],String(value));
    }
    for(const [key,value] of Object.entries({profile:summaryProfiles[profile.id]??profile.id,mappingStatus:state.complete?'complete':'incomplete',lineCount:current.rows.length,diagnosticCount:current.diagnostics.length+Number(state.profileMismatch)})){
      const matches=data.filter(r=>r[0]===key);
      if(matches.length && (matches.length!==1 || matches[0][1]!==String(value))) add('statement_summary_status_mismatch','bookkeeper',name+'/'+key,matches[0][1],String(value));
    }
    seenDocuments.push({name:fullName,actual,summary:true});
    return;
  }
  const headers=data.findIndex(row=>row.includes('项目')&&row.some(v=>/^(?:期末(?:余额|金额)?|金额(?:\(元\))?)$/.test(v)));
  if(headers<0){add('statement_layout_unverified','bookkeeper',name);return;}
  const header=data[headers], labelCol=header.indexOf('项目'), closeCol=header.findIndex(v=>/^(?:期末(?:余额|金额)?|金额(?:\(元\))?)$/.test(v)), openCol=header.findIndex(v=>['期间期初','期间期初(上期末)','期初','期初余额','期初金额'].includes(v));
  const categoryCol=header.findIndex(v=>['类别','分类'].includes(v));
  const labelMap=new Map(current.rows.map(r=>[normalized(r.label),r]));
  const openingRows=new Map(opening.rows.map(r=>[r.id,r.valueMinor]));
  const office=data.some(r=>r[0]==='报表类型'&&r[1]==='资产负债表(内部管理报表)');
  const native=office||data.some(r=>r[0]==='报表'&&r[1]==='资产负债表')||
    (data.some(r=>r[0]==='期间期初资产负债表平衡')&&data.some(r=>r[0]==='持久profile'));
  const metrics=!native && /指标|摘要|概览|summary|metrics/i.test(fullName.split('/').at(-1));
  if(native) {
    const metadata=office?{'账套ID':String(scope.accountSetId),'账套名称':normalized(set.name),'金额单位':'人民币元(金额保留两位小数)','持久profile':profile.id}:
      {'账套ID':String(scope.accountSetId),'账套':normalized(/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(set.name)?"'"+set.name:set.name),'期间':scope.period,'币种':'人民币(CNY)','金额单位':'元','持久profile':profile.id};
    if(office){
      const matches=data.filter(r=>r[0]==='所属期间');
      if(matches.length!==1||!matches[0][1]?.startsWith(scope.period+'('))add('statement_scope_or_unit_mismatch','bookkeeper',name+'/所属期间',undefined,scope.period);
    }
    for(const [key,value] of Object.entries(metadata)){
      const matches=data.filter(r=>r[0]===key);
      if(matches.length!==1 || matches[0][1]!==value)add('statement_scope_or_unit_mismatch','bookkeeper',name+'/'+key,undefined,value);
    }
    const flags=office?{'期末:资产=负债+所有者权益':balanced(current),'期间期初:资产=负债+所有者权益':balanced(opening)}:
      {'资产负债表平衡':balanced(current),'期间期初资产负债表平衡':balanced(opening)};
    for(const [key,value] of Object.entries({...flags,'映射完整':state.complete&&opening.complete})){
      const matches=data.filter(r=>r[0]===key);
      if(matches.length!==1 || truth(matches[0][1])!==value)add('statement_summary_status_mismatch','bookkeeper',name+'/'+key,matches[0]?.[1],String(value));
    }
  }
  for(let i=headers+1;i<rows.length;i++){
    const row=data[i], label=row[labelCol];
    if(office && row[0]==='平衡检查')break;
    if(!label || /^注\d*$/.test(row[0]) || row.join('')===header.join('') || office&&row[0]==='负债和所有者权益'&&!row[1])continue;
    const location=name+'/'+rows[i].number+'/'+label;
    if(label==='平衡差额'){
      compareValue(rows[i].cells[closeCol],BigInt(current.totals.assets)-BigInt(current.totals.liabilitiesAndEquity),location,add);
      continue;
    }
    const rule=labelMap.get(label);
    if(!rule){
      if(metrics)continue;
      const amount=asMinor(rows[i].cells[closeCol]),key='交付行/'+label;
      add('statement_row_basis_unverified','accountant',location,amount);
      if(actual.has(key))add('statement_row_duplicate','bookkeeper',location);
      actual.set(key,amount);
      continue;
    }
    if(categoryCol>=0){
      const group=row[categoryCol],section=state.sections.get(rule.id);
      const liabilityOrEquity=['负债及权益','负债和所有者权益','负债及所有者权益'].includes(group) && ['负债','权益','负债及权益'].includes(section);
      if(group!==section && !(group==='所有者权益'&&section==='权益') && !liabilityOrEquity && !(group==='检查'&&totalIds.has(rule.id)))
        add('statement_category_mismatch','bookkeeper',location,group,section);
    }
    if(actual.has(rule.id))add('statement_row_duplicate','bookkeeper',location);
    actual.set(rule.id,compareValue(rows[i].cells[closeCol],rule.valueMinor,location,add));
    if(openCol>=0)compareValue(rows[i].cells[openCol],openingRows.get(rule.id),location+'/期初',add);
  }
  for(const rule of rules.rows) {
    const id=rule.rowId;
    const active=state.activeRows.has(id);
    if(!metrics&&(native||totalIds.has(id)||active)&&!actual.has(id))add('statement_row_omitted','bookkeeper',name+'/'+rule.label);
  }
  seenDocuments.push({name:fullName,actual,summary:metrics});
}

function compareDocuments(files,state,add){
  const documents=[];
  for(const file of files) {
    if(/\.csv$/i.test(file.name)){
      const numbers=[],parsed=parseCsv(file.bytes.toString('utf8'),numbers);
      const rows=parsed.map((cells,i)=>({cells,number:numbers[i]}));
      reviewRepeatedTotals(file.name,rows,state,add);
      if(!/资产负债|balance[-_ ]?sheet/i.test(file.name) && !parsed.some(r=>r.includes('资产总计')||r[0]==='assets'||r.includes('资产负债表')))continue;
      reviewSheet(file.name,rows,state,documents,add);
    } else if(/\.xlsx$/i.test(file.name)){
      let sheets;
      const named=/财务报表|资产负债|statements?|balance.?sheet/i.test(file.name);
      try {sheets=readDeliveryWorkbook(file.bytes);} catch {if(named)add('statement_workbook_unreadable','bookkeeper',file.name);continue;}
      for(const sheet of sheets)reviewRepeatedTotals(file.name+'/'+sheet.name,sheet.rows,state,add);
      const matches=sheets.filter(sh=>/资产负债|balance.?sheet/i.test(sh.name) || sh.rows.some(r=>r.cells.includes('资产总计')));
      if(!matches.length){if(named)add('statement_workbook_sheet_missing','bookkeeper',file.name);continue;}
      for(const sheet of matches)reviewSheet(file.name+'/'+sheet.name,sheet.rows,state,documents,add);
    }
  }
  if(!documents.some(d=>!d.summary))add('balance_sheet_delivery_missing','bookkeeper','交付目录/资产负债表');
  const baseline=new Map();
  for(const doc of documents){
    for(const [row,amount] of doc.actual) {
      if(amount===null)continue;
      const first=baseline.get(row);
      if(first && first.amount!==amount) add('statement_versions_disagree','bookkeeper',doc.name+'/'+row,amount,first.amount,first.name);
      else if(!first)baseline.set(row,{amount,name:doc.name});
    }
  }
  return documents.map(d=>({file:d.name,summary:d.summary,checkedRows:d.actual.size}));
}

export function readDeliveryBooks(binding,files) {
  const trialTables=identifyTrialBalances(files);
  const db=new DatabaseSync(binding.dbPath,{readOnly:true});
  let snapshot;
  try {
    db.exec('BEGIN');
    snapshot=readSnapshot(db,binding,trialTables.some(t=>t.native));
  } finally {db.close();}
  const {profile,set,period,bookDigest,enterpriseName,taxIds}=snapshot, issues=[];
  const add=(code,owner,location,actual,expected,note)=>issues.push({code,owner,location,...(actual!=null?{actual}:{}),...(expected!=null?{expected}:{}),...(note?{note}:{})});
  const {amounts,vouchers,posted,pending}=buildBalances(snapshot,add);
  const vatLedger=vatBridge(snapshot,amounts,vouchers);
  const result={issues,coverage:{period,profile:profile.id,posted,pending,accounts:[],files:[]},inventoryMinor:null,inventoryLedger:null,vatLedger,bookDigest,enterpriseName,nameBasis:snapshot.nameBasis,taxpayerId:taxIds[0]??null};
  result.coverage.trialBalances=reviewTrialBalances(trialTables,snapshot,amounts,add);
  if(profile.legacy){add('legacy_statement_rules_unverified','product','账套/列报规则');return result;}
  const profileMismatch=set.accounting_standard!==profile.declaredStandard;
  if(profileMismatch)add('book_statement_standard_mismatch','accountant','账套/准则',set.accounting_standard,profile.declaredStandard);
  const rules=getAccountingReportRules(profile.id).balanceSheet, uses=contributions(rules);
  const opening=evaluateWindow(snapshot,amounts,'opening',rules,uses,result.coverage.accounts,add);
  const current=evaluateWindow(snapshot,amounts,'closing',rules,uses,result.coverage.accounts,add);
  const inventoryRow=current.rows.find(r=>r.id==='inventory');
  result.coverage.statementInventoryMinor=inventoryRow?String(inventoryRow.valueMinor):null;
  // 商品台账与“库存商品”总账核对；资产负债表的存货还包括原材料、生产成本。
  const goodsRoot=profile.coa.find(a=>a.name==='库存商品'&&a.scope?.status==='mapped');
  const goods=goodsRoot?snapshot.accounts.filter(a=>a.code===goodsRoot.code||
    a.code.startsWith(goodsRoot.code)&&/^\d+$/.test(a.code.slice(goodsRoot.code.length))):[];
  if(goods.length&&!current.diagnostics.some(d=>goods.some(a=>a.code===d.accountCode))){
    result.inventoryLedger=Object.fromEntries(['opening','debit','credit','closing'].map(key=>
      [key,String(goods.reduce((sum,a)=>sum+amounts.get(a.code)[key],0n))]));
    result.inventoryMinor=result.inventoryLedger.closing;
    result.inventoryLedger.purchasePostings=inventoryPurchasePostings(snapshot,vouchers,goods);
    result.inventoryLedger.expensePostings=expensePostings(snapshot,vouchers);
    result.inventoryLedger.purchaseBuyer={name:enterpriseName,taxpayerId:result.taxpayerId};
  }
  const activeRows=new Set(result.coverage.accounts.filter(a=>a.row).map(a=>a.row));
  const sections=new Map(),byId=new Map(rules.rows.map(r=>[r.rowId,r]));
  function markSection(id,section){
    sections.set(id,section);
    for(const term of byId.get(id)?.terms??[])markSection(term.rowId,section);
  }
  markSection(rules.totals.assets,'资产');
  markSection(rules.totals.liabilities,'负债');
  markSection(rules.totals.equity,'权益');
  sections.set(rules.totals.liabilitiesAndEquity,'负债及权益');
  result.coverage.files=compareDocuments(files,{current,opening,profile,scope:binding.scope,set,rules,activeRows,sections,complete:!profileMismatch && current.complete,profileMismatch},add);
  return result;
}
