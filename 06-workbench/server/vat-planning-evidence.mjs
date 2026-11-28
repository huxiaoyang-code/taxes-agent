// 把获准来源中的行和固定表头还原为决定当日可见的观察。原始标识不进模型投影。
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {extname,join,resolve} from 'node:path';
import {baselineBytes,isGeneratedMaterialPath,baselineInside} from './business-baseline-materials.mjs';
import {registeredMaterialIdentity,matchMaterialParty} from './material-identity.mjs';
import {readXlsxStructure} from './offline-invoice-xlsx.mjs';
import {readPreparedSource,parseJson,pointer,digest} from './finance-prebook-evidence.mjs';
import {VAT_INPUT_SCHEMA,VAT_FIELDS,VAT_NUMERIC_FIELDS} from './vat-planning-contracts.mjs';
import {validateSchemaValue} from './schema-validation.mjs';
import {annotateFinanceCall,currentFinanceCall} from './finance-call-chain.mjs';

export const fail=code=>{throw Object.assign(Error(code),{code});};
export const isMonth=v=>typeof v==='string'&&/^20\d\d-(0[1-9]|1[0-2])$/.test(v);
const dateFields=new Set(['period','knownAt','issueDate','receipt','operationDate','taxPeriod','eligibleFrom','eligibleThrough','effectiveThrough','paymentDate','taxPointDate','billingDate','coveredThrough']);
function canonicalDate(value){
 const text=String(value);
 if(/^20\d{2}(0[1-9]|1[0-2])$/.test(text))return text.slice(0,4)+'-'+text.slice(4);
 if(isMonth(value))return value;
 const m=/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?)?$/.exec(text);
 if(!m)fail('finance_vat_known_date_required');
 const day=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
 if(!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)fail('finance_vat_known_date_required');
 return m[4]?day+' '+m[4]+':'+m[5]+(m[6]?':'+m[6]+(m[7]??''):''):day;
}
export function cutoff(value){
 if(isMonth(value)){
  const [year,month]=value.split('-').map(Number);
  return new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
 }
 return value.slice(0,10);
}

export function sheetView(bytes,sheetIndex){
 let layout;
 try{layout=readXlsxStructure(bytes,{sheetIndex});}catch{fail('finance_vat_spreadsheet_layout_unsupported');}
 const rows=new Map(layout.rows.map(row=>[row.rowNumber,row]));
 return {rows,get(row,column,field){
  const item=rows.get(row),value=item?.cells[column-1],type=item?.types[column-1];
  if(type?.type==='n'&&dateFields.has(field)){
   const format=layout.formatCodes.get(type.format)?.toLowerCase()??'';
   if(type.format==='0'&&/^20\d{4}$/.test(value))return canonicalDate(value);
   const monthOnly=/^yyyy[-/]?mm$/.test(format);
   const fullDate=['14','15','22'].includes(type.format)||/^y{2,4}[-/]m{1,2}[-/]d{1,2}(?: h{1,2}:mm(?::ss)?)?$/.test(format);
   if(!monthOnly&&!fullDate||!/^\d{1,6}(\.\d+)?$/.test(value))fail('finance_vat_cell_format_unsupported');
   const serial=Number(value),epoch=Date.UTC(layout.date1904?1904:1899,layout.date1904?0:11,layout.date1904?1:30);
   const iso=new Date(epoch+Math.round(serial*86400000)).toISOString();
   if(monthOnly)return iso.slice(0,7);
   return type.format==='22'||format.includes(':')||!Number.isInteger(serial)?iso.slice(0,19).replace('T',' '):iso.slice(0,10);
  }
  if(type?.type==='n'&&(!VAT_NUMERIC_FIELDS.has(field)||!['0','1','2'].includes(type.format)))fail('finance_vat_cell_format_unsupported');
  return value;
 }};
}

function sourceView(bytes,source){
 const extension=extname(source.path).toLowerCase();
 const json=extension==='.json'?parseJson({bytes}):undefined;
 const sheet=extension==='.xlsx'?sheetView(bytes,source.sheetIndex??0):undefined;
 return {
  rows(table){
   if(table.rowsPointer!==undefined){
    if(!json||table.firstRow||table.lastRow)fail('finance_vat_table_layout_invalid');
    const rows=pointer(json,table.rowsPointer);
    if(!Array.isArray(rows)||rows.length>4000)fail('finance_vat_source_limit');
    return rows.map((record,index)=>({record,position:index}));
   }
   if(table.firstRow!==undefined){
    if(!sheet||table.lastRow<table.firstRow)fail('finance_vat_table_layout_invalid');
    return [...sheet.rows.values()].filter(r=>r.rowNumber>=table.firstRow&&(!table.lastRow||r.rowNumber<=table.lastRow)&&r.cells.some(Boolean)).map(r=>({position:r.rowNumber}));
   }
   if(table.lastRow!==undefined)fail('finance_vat_table_layout_invalid');
   return [{}];
  },
  read(location,row={},field){
   if(!location)return undefined;
   if(Object.hasOwn(location,'value')){
    if(json||sheet)fail('finance_vat_use_original_cell_or_pointer');
    return location.value;
   }
   if(Object.hasOwn(location,'jsonPointer')&&json)return pointer(json,location.jsonPointer);
   if(location.key&&row.record&&Object.hasOwn(row.record,location.key))return row.record[location.key];
   if(location.key&&json)return undefined;
   if(location.column&&sheet)return sheet.get(location.row??row.position,location.column,field);
   fail('finance_vat_source_locator_invalid');
  },
 };
}

function fieldsOf(table,view,row,asOf){
 const fields=table.fields;
 if(Object.keys(fields).some(k=>!VAT_FIELDS[table.kind].includes(k)))fail('finance_vat_field_not_applicable');
 const allowedAssumptions={scope:'monthly_general_domestic',inventoryCoverage:'complete',basis:'forecast',state:'open',otherEffects:'none',inputVatTransferOut:0,prepaidVat:0};
 const read=name=>{
  const location=fields[name];
  if(!location||!Object.hasOwn(location,'assume')){
   const value=view.read(location,row,name);
   if(value===undefined||value===''||!dateFields.has(name))return value;
   const date=canonicalDate(value);
   // 表头所属期常以月首日期保存，日期字段本身保持原精度。
   return ['period','taxPeriod','eligibleFrom','eligibleThrough','effectiveThrough'].includes(name)?date.slice(0,7):date;
  }
  const isForecastPeriod=name==='period'&&table.kind==='month'&&isMonth(location.assume)&&read('basis')==='forecast';
  if(!isForecastPeriod&&(!Object.hasOwn(allowedAssumptions,name)||location.assume!==allowedAssumptions[name]))fail('finance_vat_assumption_not_allowed');
  return location.assume;
 };
 let statusUnresolved=false;
 if(table.statusFilter){
  const {location,include,exclude}=table.statusFilter,status=view.read(location,row);
  if(exclude.includes(status)&&!include.includes(status))return null;
  statusUnresolved=!include.includes(status)||exclude.includes(status);
 }
 const knownAt=read('knownAt')??(table.kind==='invoice'?read('receipt'):undefined);
 if(!knownAt)fail('finance_vat_known_date_required');
 if(cutoff(knownAt)>asOf)return null;
 if(statusUnresolved)fail('finance_vat_row_status_unresolved');
 if(table.kind==='month'){
  for(const [a,b] of [['invoicedOutputVat','uninvoicedOutputVat'],['invoicedSales','uninvoicedSales']]){
   if(fields[a]&&fields[b]&&digest(fields[a])===digest(fields[b]))fail('finance_vat_overlapping_month_components');
  }
 }
 const fact={};
 for(const name of Object.keys(fields)){
  let value=read(name);
  if(value===undefined||value==='')continue;
  if(table.translations?.[name]){
   const matches=table.translations[name].filter(t=>t.from===value);
   if(matches.length!==1)fail('finance_vat_translation_unresolved');
   value=matches[0].to;
  }
  fact[name]=value;
 }
 // 门户操作的所属期可以早于实际操作月。未来操作不能成为已确认事实。
 if(['confirmation','event'].includes(table.kind)&&fact.operationDate&&cutoff(fact.operationDate)>asOf)return null;
 if(table.kind==='sale'){
  if(fact.taxPointDate&&cutoff(fact.taxPointDate)>asOf)return null;
  if(fact.billingDate&&cutoff(fact.billingDate)>asOf)delete fact.billingDate;
 }
 if(table.kind==='filing'&&!isMonth(fact.period))fail('finance_vat_known_date_required');
 if(table.kind==='month'&&fact.basis==='actual'&&fact.period>asOf.slice(0,7))return null;
 if(table.kind==='invoice'){
  for(const value of [fact.issueDate,fact.receipt].filter(v=>v!==undefined)){
   const last=cutoff(value);
   if(isMonth(value)?value>asOf.slice(0,7):last>asOf)return null;
  }
 }
 return {...fact,knownAt};
}

export function readVatFacts(args,binding,auditDir){
 const prepared=readPreparedSource(args.inputPath,auditDir),input=parseJson(prepared);
 if(validateSchemaValue(VAT_INPUT_SCHEMA,input).length)fail('finance_vat_materials_schema_invalid');
 const db=new DatabaseSync(binding.dbPath,{readOnly:true});
 let identity;
 try{identity=registeredMaterialIdentity(db,binding.scope);}finally{db.close();}
 if(!['一般纳税人','vat_general'].includes(identity.taxpayer_type))fail('finance_vat_monthly_general_only');
 const root=process.env.FINANCE_SOURCE_ROOT;
 if(!root)fail('finance_vat_source_root_required');
 const sources=[{path:prepared.path,sha256:prepared.sha256,locator:'agent_materials'}],facts=[],usedTables=new Map();
 let totalBytes=0,rowsRead=0;
 for(const [index,source] of input.sources.entries()){
  const path=resolve(source.path);
  if(isGeneratedMaterialPath(path,root,auditDir)||baselineInside(join(auditDir,'artifacts'),path))fail('finance_vat_generated_not_original');
  const bytes=baselineBytes(source.path,root);
  if((totalBytes+=bytes.length)>20*1024*1024)fail('finance_vat_source_limit');
  if(digest(bytes)!==source.sha256)fail('finance_vat_source_changed');
  sources.push({path,sha256:source.sha256,locator:'vat_original'});
  const view=sourceView(bytes,source);
  if(source.availableAt&&cutoff(canonicalDate(view.read(source.availableAt,{},'knownAt')))>args.asOf)continue;
  const owner=view.read(source.owner);
  const matched=source.ownerField==='enterpriseKey'?owner===binding.scope.enterpriseKey:matchMaterialParty({role:'enterprise',name:owner},identity).matched;
  if(!matched)fail('finance_vat_original_owner_conflict');
  for(const [tableIndex,table] of source.tables.entries()){
   for(const row of view.rows(table)){
    if(++rowsRead>4000)fail('finance_vat_source_limit');
    let data,issue;
    try{data=fieldsOf(table,view,row,args.asOf);}catch(error){
     if(!['finance_vat_row_status_unresolved','finance_vat_known_date_required','finance_vat_translation_unresolved','finance_vat_cell_format_unsupported','finance_prebook_pointer_missing','finance_vat_overlapping_month_components'].includes(error.code))throw error;
     issue=error.code;data={};
     for(const name of ['issuer','invoiceNumber','period']){
      try{const value=view.read(table.fields[name],row,name);if(typeof value==='string')data[name]=value;}catch{}
     }
    }
    if(!data)continue;
    if(row.record?.enterpriseKey!==undefined&&row.record.enterpriseKey!==binding.scope.enterpriseKey)fail('finance_vat_original_owner_conflict');
    const observed=[source.owner,...Object.values(table.fields)].some(v=>Object.hasOwn(v,'value'));
    usedTables.set(index+'-'+tableIndex,{source:index,table:tableIndex,path,sha256:source.sha256,owner:source.owner,ownerField:source.ownerField,availableAt:source.availableAt,sheetIndex:source.sheetIndex??0,mapping:table});
    const assumptions=Object.keys(table.fields).filter(k=>Object.hasOwn(table.fields[k],'assume'));
    facts.push({kind:table.kind,data,...(issue?{issue}:{}),source:{source:index,table:tableIndex,row:row.position??null,verification:observed?'host_observation':'source_value_bound',assumptions}});
   }
  }
 }
 const call=currentFinanceCall();
 if(call)writeFileSync(join(call.recordPath,'vat-planning-evidence.json'),JSON.stringify({version:'vat-planning-evidence/1',asOf:args.asOf,scope:binding.scope,mappings:[...usedTables.values()],facts},null,2),{flag:'wx',mode:0o600});
 annotateFinanceCall({sources,scope:binding.scope,configuredTarget:{databasePath:binding.dbPath,accountSetId:binding.scope.accountSetId,period:binding.scope.period,bindingOrigin:binding.bindingOrigin}});
 return facts;
}
