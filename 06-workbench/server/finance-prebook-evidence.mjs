// 账前原件读取与精确值绑定；完整原值只保存在本机。
import {readFileSync,lstatSync,realpathSync,openSync,closeSync,fstatSync} from 'node:fs';
import {resolve,dirname,isAbsolute,relative,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {parseBankCsv} from './bank-import.mjs';
import {cents} from './agency-tax-rules.mjs';
export const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:stable(value)).digest('hex');
export const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`:JSON.stringify(value);
export const reject=code=>{throw Object.assign(new Error(code),{code});};
export function readSource(path){
 try{
  const root=process.env.FINANCE_SOURCE_ROOT;if(!root||!isAbsolute(root)||typeof path!=='string'||!isAbsolute(path))reject('finance_prebook_source_root_required');
  const full=resolve(path),base=resolve(root),rel=relative(base,full);if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))reject('finance_prebook_source_outside_root');
  for(let p=full;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())reject('finance_prebook_source_path_invalid');if(dirname(p)===p)break;}
  const before=lstatSync(full);if(!before.isFile()||before.nlink!==1||before.size>5*1024*1024||realpathSync(full).toLowerCase()!==full.toLowerCase())reject('finance_prebook_source_path_invalid');
  const fd=openSync(full,'r');let bytes;try{const opened=fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev||opened.nlink!==1)reject('finance_prebook_source_changed');bytes=readFileSync(fd);const after=fstatSync(fd);if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ino!==opened.ino||bytes.length!==opened.size)reject('finance_prebook_source_changed');}finally{closeSync(fd);}
  return {path:full,bytes,sha256:digest(bytes)};
 }catch(error){if(error.code?.startsWith('finance_prebook_'))throw error;reject('finance_prebook_source_unreadable');}
}
export function parseJson(source){try{return JSON.parse(source.bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{reject('finance_prebook_json_invalid');}}
export function pointer(value,path){if(path==='')return value;if(typeof path!=='string'||!path.startsWith('/')||/~[^01]/.test(path))reject('finance_prebook_pointer_invalid');let out=value;for(const part of path.slice(1).split('/')){const key=part.replaceAll('~1','/').replaceAll('~0','~');if(!out||typeof out!=='object'||!Object.hasOwn(out,key))reject('finance_prebook_pointer_missing');out=out[key];}return out;}
const escaped=key=>key.replaceAll('~','~0').replaceAll('/','~1');
function leaves(value,path=''){if(value&&typeof value==='object'&&Object.keys(value).length)return Object.entries(value).flatMap(([key,item])=>leaves(item,`${path}/${escaped(key)}`));return [{path,value}];}
function normalize(value,transform){
 if(transform==='decimal'){if(!['string','number'].includes(typeof value)||! /^-?\d{1,12}(\.\d{1,2})?$/.test(String(value)))reject('finance_prebook_decimal_invalid');return cents(String(value)).toString();}
 if(transform==='boolean'){if(value===true||value==='true')return true;if(value===false||value==='false')return false;reject('finance_prebook_boolean_invalid');}return value;
}
export function bindEvidence(input){
 const sources=new Map(),files=[];const scope=input.facts.scope;let totalBytes=0;
 for(const original of input.originals){
  if(sources.has(original.id))reject('finance_prebook_original_id_duplicate');
  if(original.scope.enterpriseKey!==scope.enterpriseKey||original.scope.from>original.scope.through)reject('finance_prebook_original_scope_conflict');
  const source=readSource(original.path);totalBytes+=source.bytes.length;if(totalBytes>20*1024*1024)reject('finance_prebook_source_limit');if(original.sha256&&original.sha256!==source.sha256)reject('finance_prebook_original_changed');
  let data,csv;if(extname(source.path).toLowerCase()==='.csv'){csv=parseBankCsv(source.bytes.toString('utf8'));if(!csv.ok||new Set(csv.headers).size!==csv.headers.length)reject('finance_prebook_csv_invalid');}
  else{data=parseJson(source);if(typeof data.version==='string'&&/^(finance-|agency-)/.test(data.version)||['native_engine','conditional_summary_engine'].includes(data.resultOrigin))reject('finance_prebook_generated_not_original');const actual=data.scope;if(actual?.enterpriseKey!==undefined&&actual.enterpriseKey!==scope.enterpriseKey)reject('finance_prebook_original_scope_conflict');}
  const loaded={...source,data,csv,scope:original.scope,id:original.id};sources.set(original.id,loaded);files.push(loaded);
 }
 const bound=new Map();
 for(const binding of input.bindings){
  const source=sources.get(binding.originalId);if(!source)reject('finance_prebook_original_missing');
  const target=pointer(input.facts,binding.inputPointer),emptySet=binding.transform==='empty_set',emptyCsv=emptySet&&source.csv&&binding.csvRow===undefined&&binding.column===undefined;let actual;
  if(emptyCsv){if(binding.jsonPointer!==undefined||source.csv.rows.length)reject('finance_prebook_empty_set_invalid');actual=[];}
  else if(source.csv){if(binding.jsonPointer!==undefined||binding.csvRow===undefined||!binding.column)reject('finance_prebook_csv_locator_required');const row=source.csv.rows.find(row=>row.lineNumber===binding.csvRow),index=source.csv.headers.indexOf(binding.column);if(!row||index<0)reject('finance_prebook_csv_locator_missing');actual=row.cells[index];}
  else{if(binding.jsonPointer===undefined||binding.csvRow!==undefined||binding.column!==undefined)reject('finance_prebook_json_locator_required');actual=pointer(source.data,binding.jsonPointer);}
  // 除值相等外还核对定位路径的主体/日期上下文；不能从另一企业同金额行抄值。
  const month=Number(scope.period.slice(5)),start=scope.periodType==='quarterly'?month-2:month,first=`${scope.period.slice(0,4)}-${String(start).padStart(2,'0')}`,prior=new Date(Date.UTC(Number(scope.period.slice(0,4)),start-1,0)).toISOString().slice(0,7),opening=binding.inputPointer.startsWith('/opening')||/\/opening(Balance|Date)$/.test(binding.inputPointer);
  const recordMatch=binding.inputPointer.match(/^\/(purchases|receipts|sales|invoices|bankTransactions)\/(\d+)(?:\/|$)/),fundMatch=binding.inputPointer.match(/^\/fundsAccounts\/(\d+)\/(opening|closing)(Balance|Date)$/),countMatch=binding.inputPointer.match(/^\/inventoryCounts\/(\d+)(?:\/|$)/),targetDate=recordMatch?input.facts[recordMatch[1]][Number(recordMatch[2])].date:fundMatch?input.facts.fundsAccounts[Number(fundMatch[1])][`${fundMatch[2]}Date`]:countMatch?input.facts.inventoryCounts[Number(countMatch[1])].asOf:null,openingCutoff=input.facts.opening?.asOf;
  if(targetDate&&(targetDate<source.scope.from||targetDate>source.scope.through))reject('finance_prebook_source_period_conflict');
  if(binding.inputPointer.startsWith('/opening')&&!['/opening/inputVatTransferOut','/opening/prepaidVat'].includes(binding.inputPointer)&&openingCutoff&&(openingCutoff<source.scope.from||openingCutoff>source.scope.through))reject('finance_prebook_source_period_conflict');
  const inspectContext=value=>{if(!value||typeof value!=='object')return;if(value.enterpriseKey!==undefined&&value.enterpriseKey!==scope.enterpriseKey||value.scope?.enterpriseKey!==undefined&&value.scope.enterpriseKey!==scope.enterpriseKey)reject('finance_prebook_original_scope_conflict');const p=value.period??value.scope?.period;if(typeof p==='string'&&/^\d{4}-\d{2}$/.test(p)&&!((p>=first&&p<=scope.period)||(opening&&p===prior)))reject('finance_prebook_source_period_conflict');for(const key of ['date','asOf','openingDate','closingDate'])if(typeof value[key]==='string'&&(value[key]<source.scope.from||value[key]>source.scope.through))reject('finance_prebook_source_period_conflict');for(const key of ['date','asOf']){if(targetDate&&typeof value[key]==='string'&&value[key]!==targetDate)reject('finance_prebook_source_period_conflict');if(binding.inputPointer.startsWith('/opening/')&&!['/opening/inputVatTransferOut','/opening/prepaidVat'].includes(binding.inputPointer)&&typeof value[key]==='string'&&value[key]!==openingCutoff)reject('finance_prebook_source_period_conflict');}};
  if(source.csv){if(!emptyCsv){const row=source.csv.rows.find(r=>r.lineNumber===binding.csvRow);inspectContext(Object.fromEntries(source.csv.headers.map((h,i)=>[h,row.cells[i]])));}}
  else{inspectContext(source.data);let context=source.data;for(const raw of binding.jsonPointer.split('/').slice(1)){context=context?.[raw.replaceAll('~1','/').replaceAll('~0','~')];inspectContext(context);}const walk=value=>{inspectContext(value);if(value&&typeof value==='object')for(const child of Object.values(value))walk(child);};walk(actual);}
  if(emptySet){
   const collection=binding.inputPointer.slice(1),priorCollection=/^opening\/(receivables|payables|inventory)$/.test(collection),currentCollection=['purchases','receipts','sales','invoices','bankTransactions','fundsAccounts','inventoryCounts'].includes(collection),coverageKey={fundsAccounts:'bankTransactions',inventoryCounts:'inventory'}[collection]??collection;
   const words=['无记录',...(priorCollection&&collection!=='opening/inventory'?['无往来']:[]),...(['opening/inventory','inventoryCounts'].includes(collection)?['无库存']:[])];
   if(!priorCollection&&!currentCollection||!Array.isArray(target)||target.length||binding.valueMap||!emptyCsv&&!words.includes(actual))reject('finance_prebook_empty_set_invalid');
   const end=new Date(Date.UTC(Number(scope.period.slice(0,4)),month,0)).toISOString().slice(0,10);
   if(priorCollection?(!openingCutoff||openingCutoff<source.scope.from||openingCutoff>source.scope.through):(input.facts.coverage[coverageKey]!=='complete'||source.scope.from>`${first}-01`||source.scope.through<end))reject('finance_prebook_empty_set_coverage_missing');
   actual=[];
  }
  if(binding.valueMap){if(!/^\/(taxpayer\/[^/]+|coverage\/[^/]+|(?:sales|invoices|bankTransactions)\/\d+\/(?:direction|status|invoiceKind|deductionStatus|category|vatCategory))$/.test(binding.inputPointer)||typeof actual!=='string'||!Object.hasOwn(binding.valueMap,actual))reject('finance_prebook_value_map_invalid');actual=binding.valueMap[actual];}
  if(stable(normalize(target,binding.transform))!==stable(normalize(actual,binding.transform)))reject('finance_prebook_source_value_mismatch');
  for(const leaf of leaves(target,binding.inputPointer)){const ref={originalId:source.id,path:source.path,sha256:source.sha256,scope:source.scope,inputPointer:leaf.path,...(emptyCsv?{csvEmpty:true}:source.csv?{csvRow:binding.csvRow,column:binding.column}:{jsonPointer:binding.jsonPointer+leaf.path.slice(binding.inputPointer.length)}),transform:binding.transform??'identity',...(binding.valueMap?{valueMap:binding.valueMap}:{} )};if(bound.has(leaf.path))reject('finance_prebook_binding_overlap');bound.set(leaf.path,ref);}
 }
 const declarations=[];
 for(const declaration of input.declarations??[]){const path=declaration.inputPointer;pointer(input.facts,path);if(!/^\/(scope\/[^/]+|taxpayer\/[^/]+|coverage\/[^/]+|(?:purchases|receipts|sales|invoices|bankTransactions|fundsAccounts|inventoryCounts)\/\d+\/(?:businessId|accountId|itemId|kind|category|status|direction|invoiceKind|deductionStatus|vatCategory)|opening\/(?:receivables|payables)\/\d+\/businessId|opening\/inventory\/\d+\/itemId)$/.test(path)||bound.has(path)||declarations.some(d=>d.inputPointer===path))reject('finance_prebook_declaration_invalid');declarations.push({...declaration,value:pointer(input.facts,path),sourceType:declaration.kind});}
 const declared=new Set(declarations.map(d=>d.inputPointer)),internalIds=leaves(input.facts).filter(x=>/^\/(?:purchases|receipts|sales|invoices|bankTransactions|fundsAccounts|opening\/(?:receivables|payables))\/\d+\/id$/.test(x.path)).map(x=>x.path);
 return {files,sourceRefs:[...bound.values()],declarations,internalIds,unbound:leaves(input.facts).filter(x=>!bound.has(x.path)&&!declared.has(x.path)&&!internalIds.includes(x.path)).map(x=>x.path)};
}
