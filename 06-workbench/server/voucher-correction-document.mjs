import {createHash} from 'node:crypto';
import {extname,resolve} from 'node:path';
import {captureEvidenceSource} from './business-evidence.mjs';
import {parseMoney} from './money.mjs';

// 字段含义由固定原件的实际表头给出。模型传来的列名、参数名和说明不能替科目决定借贷方向。
const aliases={
  date:['凭证日期','记账日期','日期','voucher_date','voucherDate','date'],
  code:['科目编码','科目代码','accountCode','account_code','code'],
  debitCode:['借方科目编码','借方科目代码','借方科目','debitCode','debit_code','debitAccountCode'],
  creditCode:['贷方科目编码','贷方科目代码','贷方科目','creditCode','credit_code','creditAccountCode'],
  debit:['借方金额','借方发生额','借方','debit','debitAmount','debit_amount'],
  credit:['贷方金额','贷方发生额','贷方','credit','creditAmount','credit_amount'],
  summary:['凭证摘要','摘要','summary','voucherSummary'],
  lineSummary:['分录摘要','entrySummary','lineSummary'],
};
const fail=code=>{throw Object.assign(Error(code),{code});};
const rowKey=(sheet,row)=>JSON.stringify([sheet??'',row]);
const jsonParent=pointer=>pointer.slice(0,pointer.lastIndexOf('/'));
const isEntryAmount=pointer=>/^\/entries\/\d+\/(debit|credit)$/.test(pointer);

function amount(value,allowEmpty=false){
  const parsed=parseMoney(value,{allowEmpty,allowNegative:true});
  if(!parsed.ok || parsed.subCent)fail('correction_original_amount_ambiguous');
  return parsed.cents;
}
function voucherDate(value){
  const match=/^(\d{4})[-年/.]?(\d{2})[-月/.]?(\d{2})日?$/.exec(String(value??'').trim());
  if(!match)fail('correction_original_date_ambiguous');
  return match.slice(1).join('-');
}
function fieldsOf(source){
  const headers=source.headers.at(-1),values=source.rows[0].values,fields={};
  for(const [field,names] of Object.entries(aliases)){
    const matches=headers.flatMap((name,i)=>names.includes(String(name).trim())?[i]:[]);
    if(matches.length>1)fail('correction_document_field_ambiguous');
    if(matches.length)fields[field]={index:matches[0],value:values[matches[0]]};
  }
  return fields;
}

export function verifyDocument({before,after,proof,path,root,businessEvidence,previousEvidence,getPeers}){
  if([...before.entries,...after.entries].some(e=>e.code.startsWith('1002')))fail('correction_bank_statement_required');
  if(!Array.isArray(businessEvidence?.mappings))fail('correction_document_mapping_required');
  const json=extname(path).toLowerCase()==='.json',cache=new Map();
  const keyOf=loc=>rowKey(json?'':loc.sheet,json?jsonParent(loc.jsonPointer):loc.row);
  const oldRows=new Map(),oldDates=new Set();
  for(const m of previousEvidence?.mappings??[]){
    for(const loc of m.sources??[]){
      if(loc.sha256!==proof.sha256 || !loc.path || resolve(loc.path)!==path)continue;
      if(json?typeof loc.jsonPointer!=='string'||!loc.jsonPointer.startsWith('/'):!Number.isSafeInteger(loc.row))continue;
      const key=keyOf(loc);
      if(m.inputPointer==='/voucher_date')oldDates.add(key);
      if(!isEntryAmount(m.inputPointer))continue;
      const oldIndex=Number(m.inputPointer.split('/')[2]);
      if(!before.entries[oldIndex])continue;
      if(!oldRows.has(key))oldRows.set(key,new Set());
      oldRows.get(key).add(oldIndex);
    }
  }
  if(!oldRows.size)fail('correction_document_original_event_mismatch');
  const fieldAt=pointer=>{
    const matches=businessEvidence.mappings.filter(m=>m.inputPointer===pointer);
    const m=matches[0],loc=m?.sources?.[0];
    if(matches.length!==1||m.transform!=='identity'||m.sources.length!==1||!loc?.path||resolve(loc.path)!==path)
      fail('correction_document_mapping_required');
    if(json?(typeof loc.jsonPointer!=='string'||!loc.jsonPointer.startsWith('/')||loc.row!=null||loc.sheet!=null):
      (loc.jsonPointer!=null||(extname(path).toLowerCase()==='.csv'&&loc.sheet!=null)||
       (loc.headerRows!=null&&(loc.headerRows.length!==1||loc.headerRows[0]!==1))))fail('correction_document_mapping_required');
    const source=captureEvidenceSource(loc,{sourceRoot:root,fileCache:cache});
    if(source.sha256!==proof.sha256)fail('correction_original_changed');
    const parent=json?jsonParent(loc.jsonPointer):null;
    const name=json?loc.jsonPointer.slice(parent.length+1).replaceAll('~1','/').replaceAll('~0','~'):null;
    return {key:keyOf(loc),parent,fields:fieldsOf(source),
      index:json?source.headers.at(-1).indexOf(name):source.column-1};
  };
  const date=fieldAt('/voucher_date');
  if(!oldRows.has(date.key)&&!oldDates.has(date.key))fail('correction_document_original_event_mismatch');
  if(date.fields.date?.index!==date.index || voucherDate(date.fields.date.value)!==after.voucher_date)
    fail('correction_document_mismatch');
  if(after.summary!==before.summary && date.fields.summary?.value!==after.summary)fail('correction_document_summary_mismatch');

  const seenCells=new Set(),seenRows=new Map();
  for(const [index,entry] of after.entries.entries()){
    const debit=amount(entry.debit??0),credit=amount(entry.credit??0);
    if((debit===0n)===(credit===0n))fail('correction_entry_direction_invalid');
    const side=debit===0n?'credit':'debit';
    const code=fieldAt('/entries/'+index+'/code'),money=fieldAt('/entries/'+index+'/'+side);
    if(code.key!==money.key)fail('correction_document_mixed_entry');
    if(!oldRows.has(code.key))fail('correction_document_original_event_mismatch');
    const cell=JSON.stringify([money.key,money.index]);
    if(seenCells.has(cell))fail('correction_document_duplicate_amount');
    seenCells.add(cell);
    const fields=code.fields;
    // 日期可在同一行，也可来自同一 JSON 凭证头。后者须是原凭证已经引用的头。
    const nestedHeader=json&&/(?:^|\/)(entries|lines|分录|明细)\/\d+$/.test(code.parent)&&
      jsonParent(jsonParent(code.parent))===date.parent&&oldDates.has(date.key);
    if(!oldRows.has(date.key)&&!nestedHeader)fail('correction_document_original_event_mismatch');
    if(fields.date?voucherDate(fields.date.value)!==after.voucher_date:!nestedHeader)
      fail('correction_document_original_event_mismatch');
    const wide=fields.debitCode!=null||fields.creditCode!=null;
    const account=wide?fields[side+'Code']:fields.code;
    if((wide&&fields.code)||!account||account.index!==code.index||String(account.value)!==entry.code ||
       fields[side]?.index!==money.index||amount(fields[side].value)!==debit+credit)fail('correction_document_mismatch');
    if(!fields.debit||!fields.credit)fail('correction_document_field_ambiguous');
    const sourceSides=['debit','credit'].filter(s=>amount(fields[s].value??0,true)!==0n);
    if(!wide&&sourceSides.length!==1)fail('correction_document_field_ambiguous');
    if(!seenRows.has(code.key))seenRows.set(code.key,{sourceSides,seen:new Set()});
    seenRows.get(code.key).seen.add(side);
    const summary=entry.summary??after.summary;
    const oldSummary=[...oldRows.get(code.key)].some(i=>(before.entries[i].summary??before.summary)===summary);
    if(!oldSummary&&summary!==after.summary&&summary!==fields.lineSummary?.value&&summary!==fields.summary?.value)
      fail('correction_document_summary_mismatch');
  }
  if(seenRows.size!==oldRows.size || [...seenRows.values()].some(({sourceSides,seen})=>sourceSides.some(s=>!seen.has(s))))
    fail('correction_document_incomplete');
  for(const peer of getPeers?.()??[]){
    for(const m of peer.previousEvidence?.mappings??[]){
      if(!isEntryAmount(m.inputPointer))continue;
      for(const loc of m.sources??[]){
        // 相同原件的副本也指向同一业务。同一文件可由多张凭证合法引用不同业务行。
        if(loc.sha256!==proof.sha256)continue;
        if(json?typeof loc.jsonPointer!=='string'||!loc.jsonPointer.startsWith('/'):!Number.isSafeInteger(loc.row))continue;
        if(seenRows.has(keyOf(loc)))fail('correction_document_source_already_used');
      }
    }
  }
  return [...seenRows.keys()].map(key=>createHash('sha256').update(JSON.stringify([proof.sha256,key])).digest('hex'));
}
