// 独立只读事务内复用原生报表。仅在配置库就是报表模块支持的文件时载入它。
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {basename,dirname} from 'node:path';
import {storedCents,formatCents} from './money.mjs';

const [path,id,period,instance,enterprise] = process.argv.slice(2);
const bankQueries=JSON.parse(readFileSync(0,'utf8')||'[]');
const standardFile = basename(path).toLowerCase()==='workbench.db';
let db, buildReportExport;
if (standardFile) {
 process.env.WORKBENCH_DATABASE_MODE='readonly';
 process.env.WORKBENCH_DATA_DIR=dirname(path);
 ({db}=await import('./db.mjs'));
 ({buildReportExport}=await import('./report-export.mjs'));
} else db=new DatabaseSync(path,{readOnly:true});
try {
 db.exec('BEGIN');
 const instances=db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').all();
 const owners=db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').all(Number(id));
 if(instances.length!==1||instances[0].instance_id!==instance||owners.length!==1||owners[0].enterprise_key!==enterprise)throw Error('scope_changed');
 const books={period,entries:null,sales:null,taxAccounts:[],reports:{},issues:[]};
 try{
  const entries=db.prepare(`SELECT v.id AS voucherId,v.voucher_date AS date,v.word,v.number,e.code,a.name,e.debit,e.credit
   FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id JOIN accounts a ON a.code=e.code AND a.account_set_id=v.account_set_id
   WHERE v.account_set_id=? AND v.period=? AND v.status='posted' ORDER BY v.voucher_date,v.number,v.id,e.id`).all(Number(id),period);
  books.postedEntries=entries.length;
  // 名称与科目同时列出供人工判读。大类应交税费含其他税种，不能代填增值税。
  books.entries=entries.filter(r=>r.code.startsWith('2221')||r.name.includes('增值税'));
  for(const [label,type] of [['销项税额','outputVat'],['进项税额','inputVat']]){
   const matching=books.entries.filter(row=>row.name===label||row.name.replaceAll('（','(').replaceAll('）',')').endsWith('('+label+')')||row.name.endsWith('—'+label));
   if(matching.length)books.taxAccounts.push({type,amount:formatCents(matching.reduce((n,r)=>n+(type==='outputVat'?storedCents(r.credit)-storedCents(r.debit):storedCents(r.debit)-storedCents(r.credit)),0n)),voucherIds:[...new Set(matching.map(r=>r.voucherId))]});
  }
 }catch{books.issues.push('凭证明细未能读取');}
 books.bank=[];
 if(bankQueries.length){
  try{
   const lookup=db.prepare(`SELECT t.id,t.txn_date,t.bank_ref_id,t.amount_cents,t.direction,t.batch_id,t.row_index,b.content_sha256,
    m.voucher_id,m.entry_id,v.status AS voucher_status
    FROM bank_transactions t JOIN bank_batches b ON t.account_set_id=b.account_set_id AND t.bank_account_id=b.bank_account_id AND t.batch_id=b.batch_id
    LEFT JOIN bank_matches m ON m.account_set_id=t.account_set_id AND m.bank_account_id=t.bank_account_id AND m.transaction_id=t.id AND m.status='confirmed'
    LEFT JOIN vouchers v ON v.id=m.voucher_id AND v.account_set_id=t.account_set_id
    WHERE t.account_set_id=? AND t.currency='CNY' AND t.txn_date=? AND t.amount_cents=? AND t.direction=? ORDER BY t.id LIMIT 21`);
   for(const q of bankQueries){
    const rows=lookup.all(Number(id),q.day,BigInt(q.amount.replace('.','')),q.direction);
    const exact=rows.filter(r=>r.bank_ref_id===q.receiptId);
    // 同日同额只能形成候选。银行单号一致且候选未截断时才关联。
    const linked=rows.length<21&&exact.length===1;
    const match=linked?exact[0]:null;
    books.bank.push({eventRef:q.eventRef,day:q.day,amount:q.amount,receiptId:q.receiptId,
     state:linked?'流水号、日期、币种、方向及金额相符':rows.length?'有同日同额流水，单号待核':'未见对应银行流水',
     candidates:rows.slice(0,20).map(r=>r.id),truncated:rows.length>20,match});
   }
  }catch{books.issues.push('银行交易或核销表未取得，收付事件须核对银行回单');}
 }
 if(buildReportExport){
  for(const kind of ['trial-balance','income-statement','balance-sheet','cash-flow-statement']){
   try{
    const {report,body}=buildReportExport(Number(id),{kind,period});
    books.reports[kind]={csv:body,checks:report.checks,empty:report.dataStatus.empty,scope:report.scope,reportStatus:report.reportStatus};
    if(kind==='income-statement'&&!report.dataStatus.empty&&report.reportStatus.complete)books.sales=report.data.current['营业收入']??null;
   }catch{books.issues.push(kind+' 报表缺少期间或账簿资料');}
  }
 }else books.issues.push('当前账库文件布局不支持原生财务报表导出');
 process.stdout.write(JSON.stringify(books));
}finally{db.close();}
