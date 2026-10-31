// 独立只读进程，所有账表与凭证明细取自同一 SQLite 读事务。
import {dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
const [databasePath,idText,endPeriod]=process.argv.slice(2);
if(!databasePath||basename(databasePath)!=='workbench.db'||!/^\d+$/.test(idText??'')||!/^202[67]-(03|06|09|12)$/.test(endPeriod??''))throw Error('finance_quarter_arguments_invalid');
process.env.WORKBENCH_DATA_DIR=dirname(databasePath);process.env.WORKBENCH_DATABASE_MODE='readonly';
const {db}=await import('./db.mjs');
const {buildReportExport}=await import('./report-export.mjs');
const {storedCents,centsToNumber}=await import('./money.mjs');
const id=Number(idText),month=Number(endPeriod.slice(5)),periods=[month-2,month-1,month].map(m=>`${endPeriod.slice(0,4)}-${String(m).padStart(2,'0')}`);
try{
 db.exec('BEGIN');
 const accountSet=db.prepare('SELECT * FROM account_sets WHERE id=?').get(id);if(!accountSet)throw Error('finance_target_account_set_missing');
 const instance=db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get()?.instance_id;
 const enterprise=db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(id)?.enterprise_key;
 const accounts=db.prepare('SELECT code,name,category,direction FROM accounts WHERE account_set_id=? ORDER BY code').all(id);
 const openings=db.prepare('SELECT code,debit,credit FROM opening_balances WHERE account_set_id=? ORDER BY code').all(id);
 const entries=db.prepare(`SELECT e.*,v.account_set_id,v.period,v.voucher_date,v.word,v.number,v.summary voucher_summary,v.status,v.kind FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.period BETWEEN ? AND ? ORDER BY v.voucher_date,v.number,v.id,e.line_no`).all(id,periods[0],periods[2]);
 const assets=db.prepare('SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id').all(id);
 const months=periods.map(period=>{
  const state=db.prepare('SELECT status FROM periods WHERE account_set_id=? AND period=?').get(id,period);
  if(!state||period<accountSet.start_period)return {period,missing:true,status:'missing'};
  const reports=Object.fromEntries(['trial-balance','income-statement','balance-sheet','cash-flow-statement'].map(kind=>[kind,buildReportExport(id,{kind,period}).report]));
  // 同一版本中剔除本月实际已过账损益结转，明确标为重建口径，不伪称历史快照。
  const preClose=structuredClone(reports['trial-balance'].data),carry=entries.filter(e=>e.period===period&&e.status==='posted'&&e.kind==='carryforward');
  for(const line of preClose.lines){const selected=carry.filter(e=>e.code===line.code),debit=selected.reduce((n,e)=>n+storedCents(e.debit),0n),credit=selected.reduce((n,e)=>n+storedCents(e.credit),0n);
   for(const key of ['period_debit','ytd_debit'])line[key]=centsToNumber(storedCents(line[key])-debit);
   for(const key of ['period_credit','ytd_credit'])line[key]=centsToNumber(storedCents(line[key])-credit);
   const net=storedCents(line.closing_debit)-storedCents(line.closing_credit)-debit+credit;line.closing_debit=centsToNumber(net>0n?net:0n);line.closing_credit=centsToNumber(net<0n?-net:0n);
  }
  preClose.totals=Object.fromEntries(Object.keys(preClose.totals).map(k=>[k,centsToNumber(preClose.lines.reduce((n,r)=>n+storedCents(r[k]),0n))]));
  return {period,status:state.status,reports,preClose,preCloseMeaning:'同一账簿版本剔除本月已过账损益结转后的重建余额',carryVoucherIds:[...new Set(carry.map(e=>e.voucher_id))]};
 });
 const journal={accountSet,accounts,openings,entries,assets,months:months.map(m=>({period:m.period,status:m.status}))};
 const snapshotDigest=createHash('sha256').update(JSON.stringify(journal)).digest('hex');
 process.stdout.write(JSON.stringify({version:'quarter-ledger-snapshot/1',capturedAt:new Date().toISOString(),snapshotDigest,scope:{accountSetId:id,enterpriseKey:enterprise,databaseInstanceId:instance,period:endPeriod,currency:'CNY'},periods,...journal,months}));
 db.exec('ROLLBACK');
}finally{db.close();}
