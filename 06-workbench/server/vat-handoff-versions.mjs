import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const handoffFiles={report:'vat-handoff.html',data:'vat-handoff.json',evidence:'vat-planning-evidence.json'};
export const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
// 文件名来自产品，历史记录只能提供摘要。
export function vatCodeVersion(){
 const code=createHash('sha256');
 for(const name of ['vat-planning.mjs','vat-planning-contracts.mjs','vat-planning-evidence.mjs','finance-summary-engine.mjs','agency-tax-rules.mjs','vat-period-handoff.mjs','vat-handoff-html.mjs','vat-handoff-books-worker.mjs','vat-handoff-versions.mjs','vat-period-handoff-contract.mjs']){
  code.update(name).update(readFileSync(fileURLToPath(new URL('./'+name,import.meta.url))));
 }
 const ledgers=new URL('./vat-planning-ledgers.mjs',import.meta.url);
 if(existsSync(ledgers))code.update(readFileSync(ledgers));
 return code.digest('hex');
}
export function bookSnapshot(binding,bankQueries=[]){
 try{
  const {period,accountSetId,databaseInstanceId,enterpriseKey}=binding.scope;
  const bytes=execFileSync(process.execPath,[fileURLToPath(new URL('./vat-handoff-books-worker.mjs',import.meta.url)),binding.databasePath,String(accountSetId),period,databaseInstanceId,enterpriseKey],{windowsHide:true,input:JSON.stringify(bankQueries),stdio:['pipe','pipe','pipe'],timeout:30000,maxBuffer:32*1024*1024});
  return JSON.parse(bytes);
 }catch{return {sales:null,taxAccounts:[],entries:null,reports:{},issues:['未取得同账套同月只读快照，须核对账库身份、凭证与报表']};}
}
