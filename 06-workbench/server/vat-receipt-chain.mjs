import {isMonth} from './vat-planning-evidence.mjs';
// 原确认、撤销及更正需由同一票（或同一税期）内的回执链明确关联。
export function currentReceipts(rows,key,gaps){
 const indexed=Map.groupBy(rows.filter(r=>r.data.receiptId),r=>r.data.receiptId),replaced=new Map();
 const recordIssue=r=>gaps.push({code:'receipt_correction_chain_unverified',...key,sources:[r.source]});
 for(const r of rows){
  const {receiptId,supersedes,confirmationState}=r.data;
  if(confirmationState!==undefined&&!['confirmed','revoked'].includes(confirmationState)||
     confirmationState==='revoked'&&(!supersedes||!r.data.operationDate))recordIssue(r);
  if(!supersedes)continue;
  const prior=indexed.get(supersedes);
  if(typeof receiptId!=='string'||!prior||receiptId===supersedes||
   confirmationState==='revoked'&&(!isMonth(r.data.taxPeriod)||prior.some(p=>p.data.taxPeriod!==r.data.taxPeriod))||
   prior.some(p=>(p.data.operationDate??p.data.knownAt)>(r.data.operationDate??r.data.knownAt))||
   replaced.has(supersedes)&&replaced.get(supersedes)!==receiptId){
   recordIssue(r);continue;
  }
  replaced.set(supersedes,receiptId);
 }
 for(const id of replaced.keys()){
  const seen=new Set([id]);let next=replaced.get(id);
  while(next){
   if(seen.has(next)){recordIssue(indexed.get(id)[0]);break;}
   seen.add(next);next=replaced.get(next);
  }
 }
 return rows.filter(r=>!replaced.has(r.data.receiptId));
}
