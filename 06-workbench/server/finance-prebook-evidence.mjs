// 账前只核对宿主整理的观察、原件字节摘要及业务范围。
import {readFileSync,lstatSync,realpathSync,openSync,closeSync,fstatSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute,relative,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {cents} from './agency-tax-rules.mjs';
import {AGENT_MATERIALS_SUBDIRECTORY} from './business-baseline-contracts.mjs';
import {isGeneratedMaterialPath} from './business-baseline-materials.mjs';

const maxFileBytes=5*1024*1024;
export const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:stable(value)).digest('hex');
export const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`:JSON.stringify(value);
export const reject=code=>{throw Object.assign(new Error(code),{code});};
const inside=(root,path)=>{
 const part=relative(root,path);
 return part!==''&&part!=='..'&&!part.startsWith('../')&&!part.startsWith('..\\')&&!isAbsolute(part);
};
const filesystemKey=path=>process.platform==='win32'?path.toLowerCase():path;

function readBoundedFile(path){
 try{
  for(let parent=path;;parent=dirname(parent)){
   if(lstatSync(parent).isSymbolicLink())reject('finance_prebook_source_path_invalid');
   if(parent===dirname(parent))break;
  }
  const before=lstatSync(path);
  if(!before.isFile()||before.nlink!==1||before.size>maxFileBytes||filesystemKey(realpathSync(path))!==filesystemKey(path))reject('finance_prebook_source_path_invalid');
  const fd=openSync(path,'r');
  let bytes;
  try{
   const opened=fstatSync(fd);
   if(opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==1||opened.size>maxFileBytes)reject('finance_prebook_source_changed');
   bytes=readFileSync(fd);
   const after=fstatSync(fd);
   if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||bytes.length!==opened.size)reject('finance_prebook_source_changed');
  }finally{closeSync(fd);}
  return {path,bytes,sha256:digest(bytes)};
 }catch(error){
  if(error.code?.startsWith('finance_prebook_'))throw error;
  reject('finance_prebook_source_unreadable');
 }
}

export function readPreparedSource(path,auditDir){
 const root=join(auditDir,AGENT_MATERIALS_SUBDIRECTORY);
 if(typeof path!=='string'||!isAbsolute(path)||!inside(root,resolve(path))||extname(path).toLowerCase()!=='.json')reject('finance_prebook_prepared_path_outside_root');
 return readBoundedFile(resolve(path));
}

function readOriginalDigest(path,sourceRoot,auditDir){
 if(typeof sourceRoot!=='string'||!isAbsolute(sourceRoot)||typeof path!=='string'||!isAbsolute(path))reject('finance_prebook_source_root_required');
 const full=resolve(path);
 const root=resolve(sourceRoot);
 if(!inside(root,full))reject('finance_prebook_source_outside_root');
 if(isGeneratedMaterialPath(full,root,auditDir))reject('finance_prebook_generated_not_original');
 const source=readBoundedFile(full);
 return {path:source.path,sha256:source.sha256,bytes:source.bytes.length};
}

export function parseJson(source){try{return JSON.parse(source.bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{reject('finance_prebook_json_invalid');}}
export function pointer(value,path){
 if(path==='')return value;
 if(typeof path!=='string'||!path.startsWith('/')||/~(?:[^01]|$)/.test(path))reject('finance_prebook_pointer_invalid');
 let out=value;
 for(const part of path.slice(1).split('/')){
  const key=part.replaceAll('~1','/').replaceAll('~0','~');
  if(!out||typeof out!=='object'||!Object.hasOwn(out,key))reject('finance_prebook_pointer_missing');
  out=out[key];
 }
 return out;
}
const escaped=key=>key.replaceAll('~','~0').replaceAll('/','~1');
function leaves(value,path=''){
 if(value&&typeof value==='object'&&Object.keys(value).length)return Object.entries(value).flatMap(([key,item])=>leaves(item,`${path}/${escaped(key)}`));
 return [{path}];
}
function normalize(value,transform){
 if(transform==='decimal'){
  if(!['string','number'].includes(typeof value)||! /^-?\d{1,12}(\.\d{1,2})?$/.test(String(value)))reject('finance_prebook_decimal_invalid');
  return cents(String(value)).toString();
 }
 if(transform==='boolean'){
  if(value===true||value==='true')return true;
  if(value===false||value==='false')return false;
  reject('finance_prebook_boolean_invalid');
 }
 return value;
}
// 由已校验的事实形状约束比较深度，避免递归进入任意观察数据。
function sameObservation(fact,observed){
 if(fact===observed)return true;
 if(!fact||!observed||typeof fact!=='object'||typeof observed!=='object'||Array.isArray(fact)!==Array.isArray(observed))return false;
 const keys=Object.keys(fact);
 return keys.length===Object.keys(observed).length&&keys.every(key=>Object.hasOwn(observed,key)&&sameObservation(fact[key],observed[key]));
}

function bindingDates(inputPointer,facts){
 const record=inputPointer.match(/^\/(purchases|receipts|sales|invoices|bankTransactions)\/(\d+)(?:\/|$)/);
 const funds=inputPointer.match(/^\/fundsAccounts\/(\d+)\/(opening|closing)(Balance|Date)$/);
 const count=inputPointer.match(/^\/inventoryCounts\/(\d+)(?:\/|$)/);
 const targetDate=record?facts[record[1]][Number(record[2])].date:funds?facts.fundsAccounts[Number(funds[1])][`${funds[2]}Date`]:count?facts.inventoryCounts[Number(count[1])].asOf:null;
 const opening=inputPointer.startsWith('/opening')||/\/opening(Balance|Date)$/.test(inputPointer);
 const openingCutoff=inputPointer.startsWith('/opening')&&!['/opening/inputVatTransferOut','/opening/prepaidVat'].includes(inputPointer)?facts.opening?.asOf:null;
 return {targetDate,opening,openingCutoff};
}

function assertObservationScope(context,source,scope,bounds,dates){
 if(!context||typeof context!=='object')return;
 if(context.enterpriseKey!==undefined&&context.enterpriseKey!==scope.enterpriseKey||context.scope?.enterpriseKey!==undefined&&context.scope.enterpriseKey!==scope.enterpriseKey)reject('finance_prebook_original_scope_conflict');
 const period=context.period??context.scope?.period;
 if(typeof period==='string'&&/^\d{4}-\d{2}$/.test(period)&&!((period>=bounds.first&&period<=scope.period)||(dates.opening&&period===bounds.prior)))reject('finance_prebook_source_period_conflict');
 for(const key of ['date','asOf','openingDate','closingDate']){
  const value=context[key];
  if(typeof value!=='string')continue;
  if(value<source.scope.from||value>source.scope.through)reject('finance_prebook_source_period_conflict');
  if((key==='date'||key==='asOf')&&(dates.targetDate&&value!==dates.targetDate||dates.openingCutoff&&value!==dates.openingCutoff))reject('finance_prebook_source_period_conflict');
 }
}

function currentBounds(scope){
 const [year,month]=scope.period.split('-').map(Number),start=scope.periodType==='quarterly'?month-2:month;
 return {first:`${scope.period.slice(0,4)}-${String(start).padStart(2,'0')}`,prior:new Date(Date.UTC(year,start-1,0)).toISOString().slice(0,7),end:new Date(Date.UTC(year,month,0)).toISOString().slice(0,10)};
}
const currentCollections=new Set(['purchases','receipts','sales','invoices','bankTransactions','fundsAccounts','inventoryCounts']);
function emptyObservation(target,binding,source,facts,bounds){
 const collection=binding.inputPointer.slice(1),opening=/^opening\/(receivables|payables|inventory)$/.test(collection);
 const words=['无记录',...(opening&&collection!=='opening/inventory'?['无往来']:[]),...(['opening/inventory','inventoryCounts'].includes(collection)?['无库存']:[])];
 const emptyTable=Object.hasOwn(binding.locator,'headerRow');
 const actual=binding.observedValue;
 if((!opening&&!currentCollections.has(collection))||!Array.isArray(target)||target.length||binding.valueMap)reject('finance_prebook_empty_set_invalid');
 if(emptyTable?(!Array.isArray(actual)||actual.length):!words.includes(actual))reject('finance_prebook_empty_set_invalid');
 const cut=facts.opening?.asOf,coverageKey={fundsAccounts:'bankTransactions',inventoryCounts:'inventory'}[collection]??collection;
 if(opening?(!cut||cut<source.scope.from||cut>source.scope.through):(facts.coverage[coverageKey]!=='complete'||source.scope.from>`${bounds.first}-01`||source.scope.through<bounds.end))reject('finance_prebook_empty_set_coverage_missing');
 return [];
}

export function bindEvidence(input,{sourceRoot,auditDir}){
 const sources=new Map(),facts=input.facts,scope=facts.scope,bounds=currentBounds(scope);
 let totalBytes=0;
 for(const original of input.originals){
  if(sources.has(original.id))reject('finance_prebook_original_id_duplicate');
  if(original.scope.enterpriseKey!==scope.enterpriseKey||original.scope.from>original.scope.through)reject('finance_prebook_original_scope_conflict');
  const source=readOriginalDigest(original.path,sourceRoot,auditDir);
  totalBytes+=source.bytes;
  if(totalBytes>20*1024*1024)reject('finance_prebook_source_limit');
  if(original.sha256!==source.sha256)reject('finance_prebook_original_changed');
  sources.set(original.id,{...source,scope:original.scope,id:original.id});
 }

 const bound=new Map();
 for(const binding of input.bindings){
  const source=sources.get(binding.originalId);
  if(!source)reject('finance_prebook_original_missing');
  const target=pointer(facts,binding.inputPointer);
  const {locator,transform='identity'}=binding;
  if(Object.hasOwn(locator,'start')&&locator.end<=locator.start)reject('finance_prebook_locator_invalid');
  if(Object.hasOwn(locator,'headerRow')&&transform!=='empty_set')reject('finance_prebook_empty_set_invalid');
  if(target&&typeof target==='object'&&!Object.hasOwn(locator,'jsonPointer')&&transform!=='empty_set')reject('finance_prebook_collection_locator_required');
  const dates=bindingDates(binding.inputPointer,facts),{targetDate,openingCutoff}=dates;
  if(targetDate&&(targetDate<source.scope.from||targetDate>source.scope.through)||openingCutoff&&(openingCutoff<source.scope.from||openingCutoff>source.scope.through))reject('finance_prebook_source_period_conflict');
  const checkScope=value=>assertObservationScope(value,source,scope,bounds,dates);
  checkScope(binding.observedContext);
  let observed=transform==='empty_set'?emptyObservation(target,binding,source,facts,bounds):binding.observedValue;
  if(binding.valueMap){
   if(!/^\/(taxpayer\/[^/]+|coverage\/[^/]+|(?:sales|invoices|bankTransactions)\/\d+\/(?:direction|status|invoiceKind|deductionStatus|category|vatCategory))$/.test(binding.inputPointer)||typeof observed!=='string'||!Object.hasOwn(binding.valueMap,observed))reject('finance_prebook_value_map_invalid');
   observed=binding.valueMap[observed];
  }
  if(!sameObservation(normalize(target,transform),normalize(observed,transform)))reject('finance_prebook_source_value_mismatch');
  const checkTree=value=>{
   checkScope(value);
   if(value&&typeof value==='object')Object.values(value).forEach(checkTree);
  };
  checkTree(target);
  for(const leaf of leaves(target,binding.inputPointer)){
   if(bound.has(leaf.path))reject('finance_prebook_binding_overlap');
   const position=Object.hasOwn(locator,'jsonPointer')?{jsonPointer:locator.jsonPointer+leaf.path.slice(binding.inputPointer.length)}:locator;
   bound.set(leaf.path,{originalId:source.id,path:source.path,sha256:source.sha256,scope:source.scope,inputPointer:leaf.path,locator:position,
    sourceType:'agent_observation',verification:'source_digest_matched',transform,...(binding.valueMap?{valueMap:binding.valueMap}:{})});
  }
 }
 const declarations=[];
 for(const declaration of input.declarations??[]){
  const path=declaration.inputPointer;
  pointer(facts,path);
  if(!/^\/(scope\/[^/]+|taxpayer\/[^/]+|coverage\/[^/]+|(?:purchases|receipts|sales|invoices|bankTransactions|fundsAccounts|inventoryCounts)\/\d+\/(?:businessId|accountId|itemId|kind|category|status|direction|invoiceKind|deductionStatus|vatCategory)|opening\/(?:receivables|payables)\/\d+\/businessId|opening\/inventory\/\d+\/itemId)$/.test(path)||bound.has(path)||declarations.some(d=>d.inputPointer===path))reject('finance_prebook_declaration_invalid');
  declarations.push({...declaration,value:pointer(facts,path),sourceType:declaration.kind});
 }
 const factLeaves=leaves(facts),declared=new Set(declarations.map(d=>d.inputPointer));
 const internalIds=factLeaves.filter(x=>/^\/(?:purchases|receipts|sales|invoices|bankTransactions|fundsAccounts|opening\/(?:receivables|payables))\/\d+\/id$/.test(x.path)).map(x=>x.path);
 return {files:[...sources.values()],sourceRefs:[...bound.values()],declarations,internalIds,unbound:factLeaves.filter(x=>!bound.has(x.path)&&!declared.has(x.path)&&!internalIds.includes(x.path)).map(x=>x.path)};
}
