// 对交付物实际附带的科目余额表复核。原生表复用导出校验，派生表允许仅列非零科目。
import {parseCsv} from './csv-rows.mjs';
import {checkNativeBalanceRows} from './finance-delivery-check.mjs';
import {parseMoney} from './money.mjs';

const names=['期初余额','本期借方','本期贷方','期末余额'];
const sided=['期初借方','期初贷方','本期借方','本期贷方','期末借方','期末贷方'];
const clean=v=>String(v??'').trim().normalize('NFKC').replace(/\s|\(元\)$/gu,'');
const categorySets={'资产':['资产'],'负债':['负债'],'权益':['权益'],'所有者权益':['权益'],'负债及所有者权益':['负债','权益'],'成本':['成本'],'损益':['损益']};
const signed=(code,value)=>code==='借'||code==='借方'?value:code==='贷'||code==='贷方'?-value:0n;
function parseAmount(cell){
  const raw=String(cell??'').trim();
  if(!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw))return null;
  const n=parseMoney(raw.replaceAll(',',''),{allowEmpty:false,allowNegative:true,maxCents:null});
  return n.ok?n.cents:null;
}
export function identifyTrialBalances(files){
  const tables=[];
  for(const file of files){
    if(!/\.csv$/i.test(file.name))continue;
    const lines=[],rows=parseCsv(file.bytes.toString('utf8'),lines);
    const header=rows.findIndex(row=>row.some(x=>['科目编码','科目代码'].includes(clean(x)))&&row.some(x=>clean(x)==='本期贷方'));
    const native=rows.some(row=>row[0]==='报表'&&row[1]==='科目余额表')||
      header>=0 && rows[header].includes('本年借方') && rows[header].includes('方向') &&
      rows.slice(0,header).some(row=>['账套ID','试算口径','映射版本'].includes(row[0]));
    if(native||header>=0||/科目余额|试算平衡|trial[-_ ]?balance/i.test(file.name))
      tables.push({name:file.name,native,header,rows,lines});
  }
  return tables;
}
function expectedRow(amounts,split){
  const {opening,debit,credit,closing}=amounts;
  return split?[opening>0n?opening:0n,opening<0n?-opening:0n,debit,credit,closing>0n?closing:0n,closing<0n?-closing:0n]:
    [opening,debit,credit,closing];
}
function requiredCols(header,labels){
  return labels.map(k=>header.indexOf(k)===header.lastIndexOf(k)?header.indexOf(k):-1);
}
function reviewCustom(table,snapshot,amounts,add){
  const {name,header,rows,lines}=table;
  if(header<0){add('trial_layout_unverified','bookkeeper',name);return 0;}
  const h=rows[header].map(clean);
  const codeCol=h.findIndex(k=>['科目编码','科目代码'].includes(k)),nameCol=h.indexOf('科目名称');
  const split=sided.every(k=>h.includes(k)),labels=split?sided:names,cols=requiredCols(h,labels);
  const dirs=requiredCols(h,['期初方向','期末方向']);
  if(codeCol<0 || cols.includes(-1) || !split&&dirs.includes(-1)){add('trial_layout_unverified','bookkeeper',name);return 0;}
  const entries = new Map(snapshot.accounts.map(a=>[a.code,{...a,values:expectedRow(amounts.get(a.code),split)}]));
  const seen=new Set(),totals=new Set();
  // 两种常见编码：借贷各列绝对额；方向独列且贷方以负数保存。后一种须全表一致。
  const signedValues=!split&&rows.slice(header+1).some(row=>entries.has(row[codeCol]?.trim())&&[cols[0],cols.at(-1)].some(j=>(parseAmount(row[j])??0n)<0n));
  for(let i=header+1;i<rows.length;i++){
    const row=rows[i],code=String(row[codeCol]??'').trim(),entry=entries.get(code),where=name+'/'+lines[i]+'/'+code;
    let expected;
    if(entry){
      if(seen.has(code))add('trial_account_duplicate','bookkeeper',where);
      seen.add(code);
      if(nameCol>=0 && row[nameCol]!==entry.name)add('trial_account_name_mismatch','bookkeeper',where,row[nameCol],entry.name);
      expected=entry.values;
    }else{
      const group=/^(.+?)类?(?:科目)?(?:小计|合计)$/.exec(code)?.[1];
      const cats=group&&Object.hasOwn(categorySets,group)?categorySets[group]:null;
      if(!['合计','总计'].includes(code)&&!cats){add('trial_unknown_row','bookkeeper',where);continue;}
      const groupKey=cats?cats.join(','):'全部';
      if(totals.has(groupKey))add('trial_subtotal_duplicate','bookkeeper',where);
      totals.add(groupKey);
      expected=Array(labels.length).fill(0n);
      for(const item of entries.values())if(!cats||cats.includes(item.category))
        item.values.forEach((value,j)=>{expected[j]+=value;});
    }
    for(let j=0;j<cols.length;j++){
      const raw=parseAmount(row[cols[j]]),field=labels[j];
      let value=raw;
      if(!split&&(j===0||j===3)){
        const dir=clean(row[dirs[j===0?0:1]]);
        if(dir||entry){
          const target=expected[j];
          const directionOK=target>0n?['借','借方'].includes(dir):target<0n?['贷','贷方'].includes(dir):['平','借','借方','贷','贷方'].includes(dir);
          if(!directionOK)add('trial_direction_mismatch','bookkeeper',where+'/'+field,dir,target>0n?'借':target<0n?'贷':'平');
          if(!signedValues && raw!==null)value=raw<0n?null:signed(dir,raw);
          if(['平',''].includes(dir)&&raw!==0n)value=null;
        }
      }
      if(value===null||value!==expected[j])add('trial_amount_mismatch','bookkeeper',where+'/'+field,value?.toString(),String(expected[j]));
    }
  }
  for(const a of entries.values())if(a.values.some(v=>v!==0n)&&!seen.has(a.code))add('trial_active_account_omitted','bookkeeper',name+'/'+a.code);
  return seen.size;
}
export function reviewTrialBalances(tables,snapshot,amounts,add){
  return tables.map(table=>{
    let accounts;
    if(table.native){
      const report=checkNativeBalanceRows(table.rows,table.lines,snapshot.nativeTrial,{add:(code,d={})=>{
        const position=[table.name,d.line,d.accountCode,d.field].filter(v=>v!=null).join('/');
        add('trial_'+code,'bookkeeper',position,undefined,d.expectedSignedDebitOrActivity);
      }});
      accounts=report.accounts;
    }else accounts=reviewCustom(table,snapshot,amounts,add);
    return {file:table.name,accounts,native:table.native};
  });
}
