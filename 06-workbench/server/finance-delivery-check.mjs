// 在同一只读快照内核对实际输出，逐行返回可修复位置。原件和报告正文留在本机。
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {basename, dirname, join, resolve} from 'node:path';
import {loadBoundBusinessSession, sessionPath} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {balancesThrough, postedEntryRows} from './period-end-controls.mjs';
import {formatCents, parseMoney, storedCents} from './money.mjs';
import {parseCsv} from './csv-rows.mjs';

const fields=['期初余额','本期借方','本期贷方','期末余额'];
const categories={'资产':['资产'],'负债':['负债'],'权益':['权益'],'所有者权益':['权益'],'负债及所有者权益':['负债','权益'],'成本':['成本'],'损益':['损益']};
function plainFile(name,extension){
 return typeof name==='string'&&name.length<=128&&name===basename(name)&&!/[<>:"/\\|?*\x00-\x1f]/.test(name)&&!name.startsWith('.')&&extension.test(name);
}
function containsIdentifier(line,id){
 const tokens=line.split(/[\s,;:|，；：、。()（）【】\[\]"'“”]+/u);
 return tokens.includes(id);
}
function citedAmounts(line){
 const amounts=[];
 const units={'元':1n,'千元':1000n,'万':10000n,'万元':10000n,'亿':100000000n,'亿元':100000000n};
 const text=line.normalize('NFKC').replaceAll('−','-');
 const numeric='([+-]?\\d[\\d,]*(?:\\.\\d+)?)';
 const unit='(亿元|万元|千元|元|万|亿|角|分|美元|港元|欧元)';
 const claim=new RegExp('(?:[¥￥]|金额|实付|实收|应付)\\s*[:：]?\\s*'+numeric+'\\s*'+unit+'?|'+numeric+'\\s*'+unit,'gu');
 for(const m of text.matchAll(claim)){
  const money=parseMoney(m[1]??m[3],{allowEmpty:false,allowNegative:true,maxCents:null});
  const factor=units[m[2]??m[4]??'元'];
  amounts.push(money.ok&&factor!==undefined?money.cents*factor:null);
 }
 return amounts;
}
function checkCitedAmounts(line,csv,row,mappings){
 const stated=citedAmounts(line);
 const verified=[];
 for(const item of mappings??[]){
  if(!csv?.length)return false;
  const column=csv[0].indexOf(item.column);
  const actual=parseMoney(row?.[column],{allowEmpty:false,allowNegative:true,maxCents:null});
  const claim=parseMoney(item.value,{allowEmpty:false,allowNegative:true,maxCents:null});
  if(column<0||csv[0].lastIndexOf(item.column)!==column||!actual.ok||!claim.ok||actual.cents!==claim.cents||!stated.includes(claim.cents))return false;
  verified.push(claim.cents);
 }
 return stated.every(value=>verified.includes(value));
}
function issueSink(){
 const issues=[];
 let count=0;
 return {issues,get count(){return count;},add(code,details={}){count++;if(issues.length<60)issues.push({code,...details});}};
}
function nextMonth(period){
 const [year,month]=period.split('-').map(Number);
 return month===12?(year+1)+'-01':year+'-'+String(month+1).padStart(2,'0');
}
function readBoundBooks(binding,read){
 const db=new DatabaseSync(binding.dbPath,{readOnly:true});
 try{
  db.exec('BEGIN');
  const {accountSetId,period,databaseInstanceId,enterpriseKey}=binding.scope;
  const identity=db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').all();
  const enterprise=db.prepare('SELECT enterprise_key FROM import_enterprise_account_sets WHERE account_set_id=?').get(accountSetId);
  if(identity.length!==1||identity[0].instance_id!==databaseInstanceId||enterprise?.enterprise_key!==enterpriseKey)throw Error('delivery_identity_changed');
  return read(db,accountSetId,period);
 }finally{db.close();}
}
function expectedBalances(binding){
 return readBoundBooks(binding,(db,accountSetId,period)=>{
  const balances=balancesThrough(db,accountSetId,period);
  const movement=new Map();
  for(const row of postedEntryRows(db,accountSetId,{fromPeriod:period,toPeriod:period})){
   const sums=movement.get(row.code)??[0n,0n];
   sums[0]+=storedCents(row.debit);sums[1]+=storedCents(row.credit);movement.set(row.code,sums);
  }
  return [...balances.values()].map(b=>{
   const [debit,credit]=movement.get(b.code)??[0n,0n];
   return {code:b.code,category:b.category,direction:b.direction,values:[b.net-debit+credit,debit,credit,b.net]};
  });
 });
}
const nativeFields=['期初借方','期初贷方','本期借方','本期贷方','本年借方','本年贷方','期末借方','期末贷方'];
const nativeHeader=['科目编码','科目名称','方向',...nativeFields];
const trialLabels=['期间期初','本期发生','本年累计','期末'];
const emptyAmounts=()=>Array(nativeFields.length).fill(0n);
const splitBalance=net=>net>=0n?[net,0n]:[0n,-net];
// 原生 CSV 会给可能触发公式的文本加单引号。按真正导出值核对，保留原始编码与名称。
const exportedText=s=>/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(s)?"'"+s:s;
function nativeBooks(db,setId,period){
 const set=db.prepare('SELECT name,start_period FROM account_sets WHERE id=?').get(setId);
 const yearStart=[set.start_period,period.slice(0,4)+'-01'].sort().at(-1);
 const rows=db.prepare('SELECT code,name,direction FROM accounts WHERE account_set_id=?').all(setId);
 const accounts=new Map(rows.map(row=>[row.code,{...row,opening:0n,values:emptyAmounts()}]));
 for(const row of db.prepare('SELECT code,debit,credit FROM opening_balances WHERE account_set_id=?').iterate(setId)){
  accounts.get(row.code).opening+=storedCents(row.debit)-storedCents(row.credit);
 }
 for(const row of postedEntryRows(db,setId,{fromPeriod:set.start_period,toPeriod:period})){
  const account=accounts.get(row.code),debit=storedCents(row.debit),credit=storedCents(row.credit);
  if(row.period<period)account.opening+=debit-credit;
  else {account.values[2]+=debit;account.values[3]+=credit;}
  if(row.period>=yearStart){account.values[4]+=debit;account.values[5]+=credit;}
 }
 const totals=emptyAmounts();
 for(const account of accounts.values()){
  const values=account.values;
  [values[0],values[1]]=splitBalance(account.opening);
  [values[6],values[7]]=splitBalance(account.opening+values[2]-values[3]);
  values.forEach((value,i)=>{totals[i]+=value;});
 }
 return {accounts,totals,metadata:{'报表':'科目余额表','账套':exportedText(set.name),'账套ID':String(setId),'期间':period,
  '币种':'人民币(CNY)','金额单位':'元','数据范围':'仅已过账凭证及建账期初','本年累计起点':yearStart+'-01'}};
}
function nativeMoney(raw){
 if(typeof raw!=='string'||!/^[-]?\d+(?:\.\d{1,2})?$/.test(raw.trim()))return null;
 const parsed=parseMoney(raw,{allowNegative:true,allowEmpty:false,maxCents:null});
 return parsed.ok?parsed.cents:null;
}
function checkNativeBalances(rows,lines,binding,issues){
 const {accounts,totals,metadata}=readBoundBooks(binding,nativeBooks);
 const index=rows.findIndex(row=>row.length===nativeHeader.length&&nativeHeader.every((v,i)=>row[i]===v));
 if(index<0){issues.add('balance_header_invalid');return {accounts:0,subtotals:0};}
 const before=rows.slice(0,index);
 for(const [field,value] of Object.entries(metadata)){
  const matches=before.filter(row=>row[0]===field);
  if(matches.length!==1||matches[0][1]!==value)issues.add('balance_metadata_mismatch',{field});
 }
 const checkAmount=(raw,expected,line,field)=>{
  if(nativeMoney(raw)!==expected)issues.add('balance_amount_or_direction',{line,field,expectedSignedDebitOrActivity:formatCents(expected)});
 };
 for(const [pair,label] of trialLabels.entries()){
  const matches=before.flatMap((row,i)=>row[0]===label?[i]:[]);
  if(matches.length!==1){issues.add('balance_trial_row_missing_or_duplicate',{field:label});continue;}
  const at=matches[0],row=before[at],debit=totals[pair*2],credit=totals[pair*2+1];
  checkAmount(row[1],debit,lines[at],label+'借方');checkAmount(row[2],credit,lines[at],label+'贷方');
  checkAmount(row[3],debit-credit,lines[at],label+'差额');
  if(row[4]!== (debit===credit?'是':'否'))issues.add('balance_trial_status_mismatch',{line:lines[at],field:label});
 }
 const seen=new Set(),byCode=new Map([...accounts.values()].map(a=>[exportedText(a.code),a]));
 let totalRows=0;
 for(let i=index+1;i<rows.length;i++){
  const row=rows[i],line=lines[i];
  let values;
  if(row[0]==='合计'&&row[1]==='各科目自身发生额，不含重复汇总'){
   totalRows++;values=totals;
  }else{
   const account=byCode.get(row[0]);
   if(!account){issues.add('unknown_balance_row',{line});continue;}
   if(seen.has(account.code))issues.add('duplicate_account',{line});
   seen.add(account.code);
   if(row[1]!==exportedText(account.name)||row[2]!==account.direction)issues.add('balance_account_metadata_mismatch',{line});
   values=account.values;
  }
  if(row.length!==nativeHeader.length)issues.add('balance_row_width_mismatch',{line});
  values.forEach((value,j)=>checkAmount(row[j+3],value,line,nativeFields[j]));
 }
 for(const account of accounts.values())if(!seen.has(account.code))issues.add('balance_account_omitted',{accountCode:account.code});
 if(totalRows!==1)issues.add('balance_total_missing_or_duplicate');
 return {accounts:seen.size,subtotals:totalRows};
}
function checkBalances(bytes,binding,issues){
 const lines=[],parsed=parseCsv(bytes.toString('utf8'),lines);
 if(parsed[0]?.[0]==='报表')return checkNativeBalances(parsed,lines,binding,issues);
 const [header=[],...rows]=parsed;
 const columns=fields.map(field=>header.findIndex(name=>name.trim().startsWith(field)));
 const codeColumn=header.findIndex(name=>['科目编码','科目代码'].includes(name.trim()));
 const directions=['期初方向','期末方向'].map(field=>header.findIndex(name=>name.trim()===field));
 if(codeColumn<0||columns.includes(-1)||directions.includes(-1)){issues.add('balance_header_invalid');return {accounts:0,subtotals:0};}
 const expected=expectedBalances(binding),byCode=new Map(expected.map(b=>[b.code,b])),seen=new Set(),summed=new Set();
 let subtotals=0;
 for(const [i,row] of rows.entries()){
  const line=i+2,key=row[codeColumn]?.trim(),entry=byCode.get(key);
  let values;
  if(entry){
   if(seen.has(key))issues.add('duplicate_account',{line});
   seen.add(key);values=entry.values;
  }else{
   const group=/^(.+?)(?:小计|合计)$/.exec(key)?.[1], selected=Object.hasOwn(categories,group)?categories[group]:null;
   if(!selected){issues.add('unknown_balance_row',{line});continue;}
   if(selected.some(category=>summed.has(category)))issues.add('overlapping_subtotal',{line});
   for(const category of selected)summed.add(category);
   values=[0n,0n,0n,0n];
   for(const b of expected.filter(b=>selected.includes(b.category)))b.values.forEach((v,j)=>{values[j]+=v;});
   subtotals++;
  }
  for(const [j,expectedValue] of values.entries()){
   const raw=row[columns[j]]?.trim()??'';
   const money=parseMoney(raw,{allowNegative:false,allowEmpty:false,maxCents:null});
   let actual=money.ok&&/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)?money.cents:null;
   if(j===0||j===3){
    const dir=row[directions[j===0?0:1]]?.trim();
    if(['贷','贷方'].includes(dir)&&actual!==null)actual=-actual;
    else if(!['借','借方'].includes(dir)&&!(dir==='平'&&actual===0n))actual=null;
   }
   if(actual!==expectedValue)issues.add('balance_amount_or_direction',{line,field:fields[j],expectedSignedDebitOrActivity:formatCents(expectedValue)});
  }
 }
 for(const b of expected.filter(b=>b.values.some(v=>v!==0n))){
  if(!seen.has(b.code))issues.add('active_account_omitted',{accountCode:b.code});
  if(!summed.has(b.category)){issues.add('category_subtotal_omitted',{category:b.category});summed.add(b.category);}
 }
 if(!rows.length)issues.add('empty_balance_export');
 return {accounts:seen.size,subtotals};
}
export function reviewDeliveryFiles(binding,request,readSafe){
 const sessionFile=process.env.FINANCE_BUSINESS_SESSION;
 if(!sessionFile)throw Error('finance_delivery_session_required');
 const workspace=dirname(dirname(resolve(sessionFile)));
 if(sessionPath(workspace)!==resolve(sessionFile))throw Error('finance_delivery_session_required');
 const {session}=loadBoundBusinessSession(workspace);
 if(session.databasePath!==binding.dbPath||Object.keys(binding.scope).some(k=>session.scope[k]!==binding.scope[k]))throw Error('finance_delivery_scope_conflict');
 const issues=issueSink(),digests={},directory=join(workspace,'outputs'),period=session.scope.period;
 function read(name,ext,kind,root){
  const parts=typeof name==='string'?name.split('/'):[];
  const valid=kind==='source'?parts.length>=1&&parts.length<=12&&parts.every((part,i)=>plainFile(part,i===parts.length-1?ext:/./)):plainFile(name,ext);
  if(!root||!valid){issues.add(kind+'_file_invalid');return null;}
  try{
   const bytes=readSafe(join(root,name),2*1024*1024);
   if(kind!=='source')digests[kind]=createHash('sha256').update(bytes).digest('hex');
   return bytes;
  }catch{issues.add(kind+'_file_unavailable');return null;}
 }
 const balances=read(request.balanceFile,/\.csv$/i,'balance',directory);
 if(!request.balanceFile.includes(period))issues.add('balance_period_missing_in_filename');
 const checked=balances?checkBalances(balances,binding,issues):{accounts:0,subtotals:0};
 const report=read(request.handoffFile,/\.md$/i,'handoff',directory)?.toString('utf8')??'';
 if(!report.includes(period))issues.add('handoff_period_missing');
 if(!report.includes(nextMonth(period)))issues.add('handoff_next_period_missing');
 const refs=request.references??[];
 let verified=0,pending=0;
 const unique=new Set(),coveredLines=new Set();
 const reportLines=report.split(/\r?\n/);
 for(const [index,ref] of refs.entries()){
  const identity=JSON.stringify([ref.file,ref.line,ref.id]);
  if(unique.has(identity)){issues.add('duplicate_reference',{reference:index+1});continue;}
  unique.add(identity);
  const source=read(ref.file,/\.(csv|md|txt)$/i,'source',session.sourceRoot);
  const sourceText=source?.toString('utf8')??'';
  const csv=/\.csv$/i.test(ref.file)?parseCsv(sourceText):null;
  const row=csv?.[ref.line-1];
  const sourceMatches=csv?row?.some(field=>field.trim()===ref.id):containsIdentifier(sourceText.split(/\r?\n/)[ref.line-1]??'',ref.id);
  const matching=reportLines.flatMap((line,i)=>containsIdentifier(line,ref.id)&&line.includes(ref.file)?[i]:[]);
  const marker=ref.disposition==='outstanding'?'待办':'已解释';
  if(!sourceMatches||matching.length!==1||!reportLines[matching[0]].includes(marker)){issues.add('handoff_source_reference_unmatched',{reference:index+1,line:ref.line});continue;}
  if(!checkCitedAmounts(reportLines[matching[0]],csv,row,ref.amounts)){issues.add('handoff_source_amount_unverified',{reference:index+1,line:ref.line});continue;}
  coveredLines.add(matching[0]);
  verified++;
  if(ref.disposition==='outstanding')pending++;
 }
 for(const item of request.missingMaterials??[]){
  const matches=reportLines.flatMap((line,i)=>line.includes('待办')&&line.includes(item.id)&&line.includes(item.impact)&&line.includes(item.period)?[i]:[]);
  if(matches.length!==1||coveredLines.has(matches[0])){issues.add('missing_material_item_unmatched');continue;}
  coveredLines.add(matches[0]);pending++;
 }
 reportLines.forEach((line,index)=>{
  if(coveredLines.has(index))return;
  const content=line.trim().replace(/^#+\s*/,'');
  if(!content||/^(?:本期)?(?:待办|已解释)(?:事项)?[：:]?$/.test(content)||/^(?:无待办(?:事项)?|待办[：:]\s*无)[。.]?$/.test(content))return;
  if(/待办|已解释/.test(content)&&(refs.length||pending||content.includes('待办')))issues.add('handoff_item_reference_missing',{line:index+1});
 });
 const status=issues.count?'needs_repair':pending?'needs_materials':!refs.length?'partial':'checked';
 return {status,period,nextPeriod:nextMonth(period),balanceFile:request.balanceFile,handoffFile:request.handoffFile,digests,...checked,verifiedReferences:verified,outstandingReferences:pending,
  issueCount:issues.count,issues:issues.issues,coverage:'balance_rows_subtotals_and_supplied_handoff_references',nextStep:issues.count?'repair_report_or_source_reference_then_rerun':pending?'carry_identified_outstanding_items':!refs.length?'check_original_references':'continue_period_goal_review'};
}
