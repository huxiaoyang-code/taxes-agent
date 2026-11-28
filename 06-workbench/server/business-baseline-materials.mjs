// 接收宿主归纳的观察。后端校验材料位置、来源字节及账套范围。
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,openSync,fstatSync,closeSync,readdirSync,opendirSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,basename,extname,join} from 'node:path';
import {readEvidencePointer} from './business-evidence.mjs';
import {validateSchemaValue} from './schema-validation.mjs';
import {registeredMaterialIdentity,matchMaterialParty} from './material-identity.mjs';
import {canonicalEnterpriseKey} from './enterprise-identity.mjs';
import {getAccountingRoles,getAccountingProfile} from './accounting-profiles.mjs';
import {parseMoney,formatCents} from './money.mjs';
import {businessMemoryDigest} from './business-memory-storage.mjs';
import {AGENT_MATERIALS_SUBDIRECTORY,BASELINE_OBSERVATIONS_SCHEMA,BASELINE_FACT_VALUES,BASELINE_ALIASES,BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS} from './business-baseline-contracts.mjs';

const fail=(code,details)=>{throw Object.assign(Error(code),{code,...(details?{details}:{})});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=businessMemoryDigest;
export const baselineInside=(root,path)=>{const r=relative(resolve(root),resolve(path));return !!r&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../');};
export function baselineDirectoryAvailable(root){
 if(typeof root!=='string'||!isAbsolute(root))return false;
 try{const full=resolve(root);for(let p=full;;p=dirname(p)){if(lstatSync(p).isSymbolicLink()||realpathSync(p).toLowerCase()!==p.toLowerCase())return false;if(p===dirname(p))break;}if(!lstatSync(full).isDirectory())return false;const directory=opendirSync(full);directory.closeSync();return true;}catch{return false;}
}
export function baselineDirectoryIdentity(root){
 if(!baselineDirectoryAvailable(root))return null;
 try{const stat=lstatSync(resolve(root),{bigint:true});return stat.ino===0n?null:digest({device:String(stat.dev),inode:String(stat.ino)});}catch{return null;}
}
export function baselineBytes(path,root,{max=5*1024*1024,unboundedRoot=false}={}){
 if(typeof path!=='string'||!isAbsolute(path)||!unboundedRoot&&(typeof root!=='string'||!isAbsolute(root)||!baselineInside(root,path)))fail('finance_baseline_source_forbidden');
 const full=resolve(path);
 for(let p=full;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())fail('finance_baseline_source_forbidden');if(p===dirname(p))break;}
 const before=lstatSync(full);if(!before.isFile()||before.nlink!==1||before.size>max||realpathSync(full).toLowerCase()!==full.toLowerCase())fail('finance_baseline_source_forbidden');
 const fd=openSync(full,'r');let bytes;try{const s=fstatSync(fd);if(s.dev!==before.dev||s.ino!==before.ino||s.nlink!==1)fail('finance_baseline_source_changed');bytes=readFileSync(fd);const e=fstatSync(fd);if(s.dev!==e.dev||s.ino!==e.ino||s.size!==e.size||s.mtimeMs!==e.mtimeMs||bytes.length!==s.size)fail('finance_baseline_source_changed');}finally{closeSync(fd);}
 return bytes;
}
const month=value=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)return undefined;return value;}
export function normalizeBaselineValue(field,value){
 if(BASELINE_FACT_VALUES[field])return BASELINE_FACT_VALUES[field].includes(value)?value:BASELINE_ALIASES[field]?.[value];
 if(BASELINE_DATE_FIELDS.includes(field))return date(value);
 if(BASELINE_PERIOD_FIELDS.includes(field))return month(value)?value:date(value)?.slice(0,7);
 if(BASELINE_AMOUNT_FIELDS.includes(field)){if(!['number','string'].includes(typeof value)||!/^\d{1,12}(\.\d{1,2})?$/.test(String(value)))return undefined;const n=Number(value);return Number.isFinite(n)&&n<=1e12?n:undefined;}
 if(BASELINE_QUANTITY_FIELDS.includes(field)){if(!['number','string'].includes(typeof value)||!/^\d{1,9}$/.test(String(value)))return undefined;return Number(value);}
 if(field==='creates_asset')return value===true||['是','形成或改良资产'].includes(value)?true:value===false||['否','不形成或改良固定资产','不形成或改良资产'].includes(value)?false:undefined;
 if(field==='business_reference')return typeof value==='string'&&/^[\p{L}\d][\p{L}\d_-]{3,95}$/u.test(value)?value:undefined;
}
const roleNames={cash:'cash',bank:'bank',receivable:'receivable',payable:'payable',inventory:'inventory',mainRevenue:'main_income',otherRevenue:'other_income',mainCost:'main_cost',otherCost:'main_cost',fixedAsset:'fixed_asset',accumulatedDepreciation:'accumulated_depreciation',intangibleAsset:'intangible_asset',accumulatedAmortization:'accumulated_amortization',salesExpense:'sales_expense',managementExpense:'management_expense',adminExpense:'management_expense',defaultDepreciationExpense:'management_expense',financeExpense:'finance_expense',taxPayable:'tax_payable',currentProfit:'current_profit',currentYearProfit:'current_profit',profitDistribution:'retained_profit'};
function roleFunction(profile){const roles={...getAccountingRoles(profile)},trustedNames={'应交税费':'taxPayable','库存现金':'cash','银行存款':'bank','应收账款':'receivable','应付账款':'payable','库存商品':'inventory','原材料':'inventory'};for(const a of getAccountingProfile(profile).coa)if(trustedNames[a.name])roles[trustedNames[a.name]+a.code]=a.code;
 return code=>Object.entries(roles).filter(([,v])=>typeof v==='string'&&String(code).startsWith(v)).sort((a,b)=>b[1].length-a[1].length).map(([k])=>roleNames[k]??Object.entries(trustedNames).find(([,key])=>k.startsWith(key))?.[1]?.replace('taxPayable','tax_payable')??'other')[0]??'unknown';}
const ownerTuple=scope=>[scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId];
const factDigest=(scope,field,value,source)=>'bf:'+digest({owner:ownerTuple(scope),field,value,source});
function fact(scope,field,value,source,{id,group}={}){
 const agent=source.agentArtifact!==undefined;
 return {factRef:factDigest(scope,field,value,source),field,value,source,...(id?{id}:{}),...(group?{group}:{}),
  verification:agent?'agent_observation':'ledger_observation',
  semanticAuthority:agent?'agent_observation':'source_observation_not_human_approval'};
}
export function baselineLedgerFact(db,scope,source){
 if(source.kind==='ledger_configuration'){if(!['accounting_standard','taxpayer_type'].includes(source.column))fail('finance_baseline_record_invalid');const r=db.prepare(`SELECT ${source.column} value FROM account_sets WHERE id=?`).get(scope.accountSetId);return r?digest(r.value):null;}
 if(source.kind==='ledger_voucher'){const voucher=db.prepare('SELECT * FROM vouchers WHERE account_set_id=? AND id=?').get(scope.accountSetId,source.voucherId);if(!voucher)return null;return digest({voucher,entries:db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id').all(voucher.id)});}
 if(source.kind==='ledger_asset'){const r=db.prepare('SELECT * FROM asset_cards WHERE account_set_id=? AND id=?').get(scope.accountSetId,source.assetId);return r?digest(r):null;}
 return null;
}
function ledger(db,scope,args){
 const accountSet=registeredMaterialIdentity(db,scope),facts=[];
 for(const [column,field]of [['accounting_standard','accounting_standard'],['taxpayer_type','taxpayer_type']]){const value=normalizeBaselineValue(field,accountSet[column]);if(value!==undefined)facts.push(fact(scope,field,value,{kind:'ledger_configuration',column,sha256:digest(accountSet[column])}));}
 const role=roleFunction(accountSet.accounting_profile_id),offset=args.historyOffset??0,limit=args.historyLimit??50;
 const total=db.prepare('SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND period<?').get(scope.accountSetId,scope.period).n;
 for(const voucher of db.prepare('SELECT * FROM vouchers WHERE account_set_id=? AND period<? ORDER BY period DESC,id LIMIT ? OFFSET ?').all(scope.accountSetId,scope.period,limit,offset)){
  const entries=db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id').all(voucher.id);
  facts.push(fact(scope,'historical_posting',{period:voucher.period,date:voucher.voucher_date,status:voucher.status,kind:['normal','depreciation','carry_forward'].includes(voucher.kind)?voucher.kind:'other',entries:entries.map(e=>({role:role(e.code),debit:e.debit,credit:e.credit}))},{kind:'ledger_voucher',voucherId:voucher.id,sha256:digest({voucher,entries})}));
 }
 const assetTotal=db.prepare('SELECT COUNT(*) n FROM asset_cards WHERE account_set_id=?').get(scope.accountSetId).n;
 for(const a of db.prepare('SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id LIMIT ? OFFSET ?').all(scope.accountSetId,limit,offset))facts.push(fact(scope,'asset_configuration',{kind:a.kind,originalCost:a.original_cost,usefulLifeMonths:a.useful_life_months,residualRate:a.residual_rate,startPeriod:a.start_period},{kind:'ledger_asset',assetId:a.id,sha256:digest(a)}));
 return {accountSet,facts,pagination:{offset,limit,total,nextOffset:offset+limit<Math.max(total,assetTotal)?offset+limit:null,assetTotal}};
}
const canonicalIdentityName=value=>typeof value==='string'?value.normalize('NFKC').replace(/\s/g,'').toUpperCase():'';
export function materialRegistryDigest(accountSet){
 const names=new Set(accountSet.registeredNames.map(canonicalIdentityName));
 return digest({
  names:[...names].sort(),taxIds:accountSet.registeredTaxIds.map(canonicalIdentityName).sort(),
  conflicting:accountSet.conflictingNames.map(canonicalIdentityName).filter(name=>names.has(name)).sort(),
 });
}

// 这里只解码宿主产物。原件使用同处授权与字节摘要校验。
function readObservationArtifact(inputPath,args,opts){
 const root=join(opts.auditDir,AGENT_MATERIALS_SUBDIRECTORY);
 if(!isAbsolute(inputPath)||extname(inputPath).toLowerCase()!=='.json'||!baselineInside(root,inputPath))fail('finance_baseline_observations_path_invalid');
 let bytes;
 try{bytes=baselineBytes(inputPath,root);}catch(error){
  if(error.code==='finance_baseline_source_forbidden')fail('finance_baseline_observations_path_invalid');
  fail('finance_baseline_observations_unavailable');
 }
 let data;
 try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch{fail('finance_baseline_observations_input_invalid');}
 const problems=validateSchemaValue(BASELINE_OBSERVATIONS_SCHEMA,data).map(({inputPointer,keyword})=>({
  inputPointer:keyword==='additionalProperties'?inputPointer.replace(/[^/]*$/,'<undeclared>'):inputPointer,keyword,
 }));
 if(problems.length)fail('finance_baseline_observations_input_invalid',{problems});
 if(digest(data.target)!==digest(args.target))fail('finance_baseline_observations_scope_conflict');
 const count=(data.records??[]).reduce((n,record)=>n+record.fields.length,0)+2*(data.historicalRows??[]).length;
 if(count>900)fail('finance_baseline_material_limit');
 return {data,artifact:{path:resolve(inputPath),root,rootIdentity:baselineDirectoryIdentity(root),sha256:sha(bytes),bytes:bytes.length}};
}

export function isGeneratedMaterialPath(path,sourceRoot,auditDir){
 const root=resolve(auditDir);
 if(baselineInside(join(root,AGENT_MATERIALS_SUBDIRECTORY),path))return true;
 if(!baselineInside(root,path))return false;
 if(baselineInside(sourceRoot,root))return true;
 // 同根或原件目录位于审计根内时，排除实际的产物目录。
 const top=relative(root,path).split(/[\\/]/)[0].toLowerCase();
 return ['calculations','prebook'].includes(top)||/^\d{8}t\d{9}z_[a-f0-9-]{36}$/.test(top);
}

function originalDescriptor(original,opts,rootIdentity){
 const {id,sha256,extractor}=original;
 if(!isAbsolute(original.path)||!opts.sourceRoot||!isAbsolute(opts.sourceRoot)||!baselineInside(opts.sourceRoot,original.path))fail('finance_baseline_source_forbidden');
 const path=resolve(original.path);
 if(isGeneratedMaterialPath(path,opts.sourceRoot,opts.auditDir))fail('finance_baseline_generated_not_original');
 let bytes;
 try{bytes=baselineBytes(path,opts.sourceRoot);}
 catch(error){if(error.code==='finance_baseline_source_forbidden'||error.code==='finance_baseline_source_changed')throw error;fail('finance_baseline_source_unavailable');}
 if(sha(bytes)!==sha256)fail('finance_baseline_source_changed');
 return {id,path,sha256,bytes:bytes.length,format:extname(path).slice(1).toLowerCase(),rootIdentity,
  owner:false,...(extractor?{extractor}:{}),readState:'agent_observation'};
}

function checkedLocator(locator){
 if(locator.row!==undefined)return {sheetIndex:locator.sheetIndex??0,row:locator.row,column:locator.column};
 if(locator.start!==undefined&&locator.end<=locator.start)fail('finance_baseline_observation_locator_invalid');
 return locator;
}

function positionKey(locator){
 if(locator.row!==undefined)return digest(['row',locator.sheet??null,locator.sheetIndex??0,locator.row]);
 if(locator.jsonPointer!==undefined)return digest(['json',locator.jsonPointer.slice(0,locator.jsonPointer.lastIndexOf('/'))]);
 return digest(['line',locator.page,locator.line]);
}

function registeredOwner(owner,accountSet,scope){
 if(!owner)return null;
 const identity=matchMaterialParty({role:owner.role,name:owner.name?.value,taxId:owner.taxId?.value},accountSet);
 const locators=Object.fromEntries(['name','taxId','enterpriseKey'].filter(key=>owner[key]).map(key=>[key,checkedLocator(owner[key].locator)]));
 if(identity.conflict)fail('finance_baseline_source_scope_conflict');
 if(owner.enterpriseKey){
  const name=canonicalIdentityName(owner.name?.value);
  const otherName=name&&accountSet.conflictingNames.map(canonicalIdentityName).includes(name);
  const conflictsWithName=name&&accountSet.registeredNames.length>0&&!accountSet.registeredNames.map(canonicalIdentityName).includes(name);
  const conflictsWithTaxId=owner.taxId?.value&&accountSet.registeredTaxIds.length>0&&!identity.matched;
  if(owner.role!=='enterprise'||canonicalEnterpriseKey(owner.enterpriseKey.value)!==scope.enterpriseKey||
     otherName||conflictsWithName||conflictsWithTaxId)fail('finance_baseline_source_scope_conflict');
  return {identity:{...identity,matched:true,basis:'registered_enterprise_key'},locators};
 }
 return {identity,locators};
}

function sourceOwner(recordOwner,originalOwner,accountSet,scope){
 const candidate=registeredOwner(recordOwner,accountSet,scope);
 if(originalOwner&&candidate){
  const first=originalOwner.identity,second=candidate.identity;
  if(first.matched!==second.matched||first.role!==second.role&&![first.role,second.role].includes('enterprise'))fail('finance_baseline_source_scope_conflict');
 }
 const selected=candidate??originalOwner;
 if(!selected?.identity.matched)return null;
 const {role,basis,taxIdAvailability,invoiceDirection}=selected.identity;
 return {identity:{role,basis,taxIdAvailability,...(invoiceDirection?{invoiceDirection}:{}),authority:'agent_observation'},ownerLocators:selected.locators};
}

function observedValue(field,recordIndex,fieldIndex){
 const value=normalizeBaselineValue(field.field,field.value);
 if(!field.interpretation)return value;
 const allowedValues=BASELINE_FACT_VALUES[field.field]??(field.field==='creates_asset'?[true,false]:[]);
 const interpreted=normalizeBaselineValue(field.field,field.interpretation.value);
 const reason=!allowedValues.length?'field_not_interpretable':interpreted===undefined?'invalid_enum':
  value!==undefined&&value!==interpreted?'source_value_conflict':null;
 if(reason)fail('finance_baseline_interpretation_invalid',{interpretation:{recordIndex,fieldIndex,field:field.field,reason,allowedValues}});
 return interpreted;
}

const taxBasisFields=['tax_type','tax_measure','tax_stage','period_basis','accumulation','period_start','period_end','tax_amount'];
function observedRecord(record,index,source,scope,diagnostics,gaps){
 const fields=record.fields.map((field,i)=>({...field,locator:checkedLocator(field.locator),observed:observedValue(field,index,i)}));
 const positions=[...new Set(fields.map(field=>positionKey(field.locator)))].sort();
 const reference=fields.find(field=>field.field==='business_reference'&&field.observed!==undefined);
 const contextPath='agent-record:'+digest(reference?reference.locator:positions.length===1?positions[0]:positions);
 const taxRecord=fields.some(field=>['tax_type','tax_amount'].includes(field.field))?
  digest([source.sha256,source.agentArtifact.sha256,record.id]):null;
 const businessKinds=[...new Set(fields.filter(field=>field.field==='business_kind'&&field.observed!==undefined).map(field=>field.observed))];
 const out=[];
 for(const field of fields){
  if(field.observed===undefined){
   gaps.push('unsupported_material');diagnostics.push({code:'unsupported_field',stage:'observation',originalId:source.originalId,field:field.field});
   continue;
  }
  if(out.some(other=>other.field===field.field&&other.value!==field.observed))fail('finance_baseline_observation_field_conflict');
  const located={...source,locator:field.locator,contextPath,...(taxRecord?{taxRecord}:{}),
   ...(field.interpretation?{interpretation:{kind:'model_interpretation',...field.interpretation}}:{}),
   ...(businessKinds.length?{contextBusinessKinds:businessKinds}:{})};
  out.push(fact(scope,field.field,field.observed,located,{group:digest([source.path,contextPath])}));
 }
 return out;
}

function historicalRole(accountSet,captures){
 const role=captures.code?roleFunction(accountSet.accounting_profile_id)(String(captures.code.value)):'unknown';
 if(role!=='unknown'||!captures.accountName)return role;
 const names={'主营业务收入':'main_income','其他业务收入':'other_income','主营业务成本':'main_cost','管理费用':'management_expense','销售费用':'sales_expense','财务费用':'finance_expense','应交税费':'tax_payable'};
 return Object.entries(names).find(([name])=>String(captures.accountName.value).startsWith(name))?.[1]??'unknown';
}

function observedHistory(row,source,scope,accountSet,diagnostics){
 const keys=['period','date','businessReference','code','accountName','debit','credit'];
 const locators=Object.fromEntries(keys.filter(key=>row[key]).map(key=>[key,checkedLocator(row[key].locator)]));
 const position=positionKey(locators.businessReference);
 if(Object.values(locators).some(locator=>positionKey(locator)!==position))fail('finance_baseline_historical_context_conflict');
 const period=normalizeBaselineValue('period_start',row.period.value),date=row.date?normalizeBaselineValue('invoice_date',row.date.value):null;
 const reference=normalizeBaselineValue('business_reference',row.businessReference.value);
 const debit=normalizeBaselineValue('amount_net',row.debit.value),credit=normalizeBaselineValue('amount_net',row.credit.value);
 if(!period||period>=scope.period||row.date&&(!date||date.slice(0,7)!==period)||!reference||debit===undefined||credit===undefined||debit>0&&credit>0)fail('finance_baseline_historical_row_invalid');
 const role=historicalRole(accountSet,row);
 if(role==='unknown')diagnostics.push({code:'historical_account_unmapped',stage:'observation',originalId:source.originalId});
 const located={...source,locator:locators.businessReference,entryLocators:locators,contextPath:'agent-history:'+position,agentHistoryPosition:digest([source.sha256,position])};
 const posting={period,date,dateGranularity:date?'day':'month',status:'observed_history',kind:'agent_observation',entries:[{role,debit,credit}]};
 return [fact(scope,'business_reference',reference,located),fact(scope,'historical_posting',posting,located)];
}

function linkObservedHistory(facts,scope){
 const references=facts.filter(f=>f.field==='business_reference'&&f.source.kind==='file');
 return facts.map(posting=>{
  if(posting.field!=='historical_posting'||posting.value.status!=='observed_history')return posting;
  const own=references.find(r=>r.source.path===posting.source.path&&r.source.contextPath===posting.source.contextPath);
  if(!own)return posting;
  const linked=references.filter(r=>r.value===own.value),source={...posting.source,relations:linked.map(r=>({businessRef:r.factRef,entryIndices:[0]}))};
  return {...posting,source,linkedBusinessRefs:linked.map(r=>r.factRef),factRef:factDigest(scope,posting.field,posting.value,source)};
 });
}
function historyDiagnostics(facts){
 const references=facts.filter(f=>f.field==='business_reference'&&f.source.kind==='file'&&!f.source.agentHistoryPosition&&!f.source.adaptation);
 return facts.filter(posting=>posting.source.agentHistoryPosition&&posting.field==='historical_posting'&&
  !references.some(f=>f.source.sha256!==posting.source.sha256&&posting.linkedBusinessRefs?.includes(f.factRef)))
  .map(posting=>({code:'historical_business_unlinked',stage:'observation',originalId:posting.source.originalId}));
}

const inheritedFields=new Set(['business_kind','service_pattern','tax_type','tax_measure','tax_stage','period_basis','accumulation']);
// 同一业务可以有多条历史分录事件；只有规范标量字段参与单值冲突和计算字段选择。
export const baselineScalarMaterialFacts=facts=>facts.filter(f=>f.field!=='historical_posting');
export function groupBaselineMaterialFacts(facts){
 const files=facts.filter(f=>f.source.kind==='file'),contexts=new Map();for(const f of files)contexts.set(digest([f.source.path,f.source.contextPath]),{path:f.source.path,context:f.source.contextPath});
 const groups=new Map();for(const [key,anchor]of contexts){
  const fs=files.filter(f=>f.source.path===anchor.path&&(f.source.contextPath===anchor.context||inheritedFields.has(f.field)&&(f.source.contextPath===''||anchor.context.startsWith(f.source.contextPath+'/'))));
  const refs=[...new Set(fs.filter(f=>f.field==='business_reference').map(f=>f.value))],identity=refs.length===1?'object:'+digest(refs[0]):key;
  if(!groups.has(identity))groups.set(identity,[]);const existing=groups.get(identity);for(const f of fs)if(!existing.some(x=>x.factRef===f.factRef))existing.push(f);
 }return groups;
}
function reportedTaxGroups(facts){
 const groups=groupBaselineMaterialFacts(facts.filter(f=>!f.source.agentArtifact));
 for(const f of facts){
  if(!f.source.taxRecord)continue;
  const key='agent-tax:'+f.source.taxRecord;
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(f);
 }
 return groups;
}
export function buildBaselineTaxBurden(facts){
 const rows=[],gaps=[];for(const [group,fs]of reportedTaxGroups(facts)){
  if(!group.startsWith('agent-tax:')&&(!fs.some(f=>f.field==='tax_type')||!fs.some(f=>f.field==='tax_amount')))continue;const fields=new Map();let duplicate=false;for(const f of baselineScalarMaterialFacts(fs)){if(fields.has(f.field)&&fields.get(f.field).value!==f.value)duplicate=true;fields.set(f.field,f);}
  const needed=taxBasisFields,missing=needed.filter(k=>!fields.has(k));
  if(duplicate||missing.length){gaps.push('tax_basis_incomplete');continue;}
  const get=k=>fields.get(k)?.value,denominatorField=get('tax_type')==='vat'?'sales_ex_vat':'revenue';
  if(fs.some(f=>Object.entries(f.source.semantics??{}).some(([key,value])=>get(key)!==value))){gaps.push('tax_basis_incomplete');continue;}
  if(!fields.has(denominatorField)||get(denominatorField)<=0||get('period_start')>get('period_end')){gaps.push('tax_basis_incomplete');continue;}
  if((get('tax_measure')==='paid')!==(get('tax_stage')==='paid')){gaps.push('tax_basis_incomplete');continue;}
  if(get('tax_type')==='cit'&&get('accumulation')==='cumulative'&&(!get('period_start').endsWith('-01')||get('period_start').slice(0,4)!==get('period_end').slice(0,4))){gaps.push('tax_basis_incomplete');continue;}
  const row={groupRef:'bg:'+digest(group),taxType:get('tax_type'),measure:get('tax_measure'),stage:get('tax_stage'),periodBasis:get('period_basis'),accumulation:get('accumulation'),from:get('period_start'),through:get('period_end'),taxAmount:get('tax_amount'),denominator:get(denominatorField),denominatorMeaning:denominatorField,evidenceRefs:fs.filter(f=>[...needed,denominatorField].includes(f.field)).map(f=>f.factRef)};
  row.ratio=row.taxAmount/row.denominator;rows.push(row);
 }
 const unique=new Map();for(const row of rows){const key=digest([row.taxType,row.measure,row.stage,row.periodBasis,row.accumulation,row.from,row.through]);if(unique.has(key)){if(unique.get(key).taxAmount!==row.taxAmount||unique.get(key).denominator!==row.denominator)gaps.push('historical_conflict');continue;}unique.set(key,row);}
 const current=[...unique.values()].sort((a,b)=>a.from.localeCompare(b.from)||a.through.localeCompare(b.through)),summaries=[];
 for(const key of new Set(current.filter(r=>r.taxType==='vat'&&r.accumulation==='current').map(r=>r.measure+':'+r.stage+':'+r.periodBasis))){
  const set=current.filter(r=>r.taxType==='vat'&&r.accumulation==='current'&&key===r.measure+':'+r.stage+':'+r.periodBasis);
  if(set.some((r,i)=>set.slice(0,i).some(p=>r.from<=p.through&&r.through>=p.from))){gaps.push('historical_conflict');continue;}
  const taxCents=set.reduce((n,r)=>n+Math.round(r.taxAmount*100),0),salesCents=set.reduce((n,r)=>n+Math.round(r.denominator*100),0);
  summaries.push({taxType:'vat',measure:set[0].measure,stage:set[0].stage,periodBasis:set[0].periodBasis,accumulation:'current',from:set[0].from,through:set.at(-1).through,periodCount:set.length,taxAmount:taxCents/100,denominator:salesCents/100,weightedRatio:taxCents/salesCents,minimumRatio:Math.min(...set.map(r=>r.ratio)),maximumRatio:Math.max(...set.map(r=>r.ratio)),evidenceRefs:[...new Set(set.flatMap(r=>r.evidenceRefs))]});
 }
 // 所得税累计不可按期相加；每个累计时点各自保留，实缴也不冒充应纳。
 for(const row of current.filter(r=>r.taxType==='cit'))summaries.push({...row,weightedRatio:row.ratio,periodCount:1});
 // 累计VAT不能当各月流量相加；当前未单独支持累计VAT参考时，必须留下缺口而非吞掉来源。
 if(current.some(r=>r.taxType==='vat'&&r.accumulation==='cumulative'))gaps.push('tax_basis_incomplete');
 return {rows:current,summaries,gaps:[...new Set(gaps)],missing:summaries.length===0,meaning:'historical_reference_not_target_or_eligibility'};
}
const moneyKey=n=>{const parsed=parseMoney(n??0,{allowNegative:true});return parsed.ok?formatCents(parsed.cents):null;};
function postingContent(v,entries){return {period:v.period,voucher_date:v.voucher_date??'',word:v.word??'记',summary:v.summary??'',kind:v.kind??'normal',entries:entries.map(e=>({code:String(e.code),summary:e.summary||v.summary||'',debit:moneyKey(e.debit),credit:moneyKey(e.credit)}))};}
function linkHistory(db,scope,facts,opts){
 const references=facts.filter(f=>f.field==='business_reference'),historical=facts.filter(f=>f.field==='historical_posting');if(!references.length||!historical.length)return facts;
 const root=join(dirname(opts.dbPath),'posting-attempts');let names;try{const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink())return facts;names=readdirSync(root).filter(n=>/^[a-f0-9-]{36}$/.test(n));if(names.length>5000)fail('finance_baseline_material_limit');}catch(error){if(error.code==='finance_baseline_material_limit')throw error;return facts;}
 const byVoucher=new Map(historical.map(f=>[f.source.voucherId,f])),relations=new Map();
 for(const name of names){try{
  const dir=join(root,name),endBytes=baselineBytes(join(dir,'result.json'),root,{max:20*1024*1024}),end=JSON.parse(endBytes),h=byVoucher.get(end.voucherId);
  if(!h||end.databaseInstanceId!==scope.databaseInstanceId||end.enterpriseKey!==scope.enterpriseKey||end.accountSetId!==scope.accountSetId||!/^validation-\d+\.json$/.test(end.validation?.file??''))continue;
  const beginPath=join(dir,'begin.json'),validationPath=join(dir,end.validation.file),beginBytes=baselineBytes(beginPath,root,{max:20*1024*1024}),validationBytes=baselineBytes(validationPath,root,{max:20*1024*1024});
  if(sha(beginBytes)!==end.beginDigest||sha(validationBytes)!==end.validation.sha256)continue;
  const op=db.prepare('SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(scope.databaseInstanceId,end.operationId,end.operationAttempt??1);if(!['succeeded','no_change'].includes(op?.state))continue;
  const validation=JSON.parse(validationBytes),voucher=db.prepare('SELECT * FROM vouchers WHERE id=? AND account_set_id=?').get(end.voucherId,scope.accountSetId),entries=db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id').all(end.voucherId);
  if(!voucher||digest(postingContent(voucher,entries))!==digest(validation.content)||validation.evidence?.version!=='business-evidence/1'||validation.issues.some(i=>i.severity==='error'))continue;
  for(const reference of references)for(const mapping of validation.evidence.mappings){
   if(!/^\/(?:summary|entries\/\d+\/summary)$/.test(mapping.inputPointer)||mapping.transform!=='identity'||mapping.valueMatched!==true||mapping.actualValue!==reference.value)continue;
   if(!mapping.sources.some(s=>resolve(s.path)===reference.source.path&&s.sha256===reference.source.sha256&&s.selectedValue===reference.value))continue;
   const actual=readEvidencePointer({...voucher,entries},mapping.inputPointer);if(actual!==reference.value)continue;
   // 分录上的来源关系只证明该行；总摘要仅可覆盖实际继承同一业务号的行，不能给合并凭证其他业务背书。
   const entryMatch=/^\/entries\/(\d+)\/summary$/.exec(mapping.inputPointer),entryIndices=entryMatch?[Number(entryMatch[1])]:entries.flatMap((entry,index)=>entry.summary===reference.value?[index]:[]);
   if(!entryIndices.length)continue;
   const relation={businessRef:reference.factRef,entryIndices,recordRoot:root,recordRootIdentity:baselineDirectoryIdentity(root),files:[{path:join(dir,'result.json'),sha256:sha(endBytes)},{path:beginPath,sha256:sha(beginBytes)},{path:validationPath,sha256:sha(validationBytes)}],operationId:end.operationId,attempt:end.operationAttempt??1};
   if(!relations.has(h.factRef))relations.set(h.factRef,[]);relations.get(h.factRef).push(relation);
  }
 }catch{/* 不完整、错主体或未核证据不能建立合同关系。 */}}
 return facts.map(f=>{const linked=relations.get(f.factRef);if(!linked?.length)return f;const source={...f.source,relations:linked};return {...f,source,linkedBusinessRefs:[...new Set(linked.map(r=>r.businessRef))],factRef:'bf:'+digest({owner:ownerTuple(scope),field:f.field,value:f.value,source})};});
}
export function baselineSnapshotDigest(snapshot){
 const {scope,facts,files,pagination,taxBurden,gaps,artifacts}=snapshot;
 return digest({scope,facts,files,pagination,taxBurden,gaps,...(artifacts?.length?{artifacts}:{})});
}
export function captureBaselineMaterials(db,scope,args,opts){
 const read=ledger(db,scope,args),facts=[...read.facts],gaps=[],files=new Map(),diagnostics=[],artifacts=[];
 if(args.inputPath){
  const {data,artifact}=readObservationArtifact(args.inputPath,args,opts);
  const rootIdentity=baselineDirectoryIdentity(opts.sourceRoot),registryDigest=materialRegistryDigest(read.accountSet);
  const owners=new Map(),recordIds=new Set(),histIds=new Set(),originalPaths=new Set(),observedCounts=new Map();
  let totalBytes=0;
  artifacts.push(artifact);
  for(const original of data.originals){
   if(files.has(original.id))fail('finance_baseline_original_duplicate');
   const file=originalDescriptor(original,opts,rootIdentity);
   if(originalPaths.has(file.path))fail('finance_baseline_original_duplicate');
   totalBytes+=file.bytes;
   if(totalBytes>20*1024*1024)fail('finance_baseline_material_limit');
   files.set(file.id,file);originalPaths.add(file.path);owners.set(file.id,registeredOwner(original.owner,read.accountSet,scope));
  }
  function observationSource(item,ids){
   if(ids.has(item.id))fail('finance_baseline_observation_duplicate');
   ids.add(item.id);
   const file=files.get(item.originalId);
   if(!file)fail('finance_baseline_original_missing');
   observedCounts.set(file.id,(observedCounts.get(file.id)??0)+(item.fields?.length??1));
   const owner=sourceOwner(item.owner,owners.get(file.id),read.accountSet,scope);
   if(!owner){
    gaps.push('owner_unverified');diagnostics.push({code:'owner_unverified',stage:'observation',originalId:file.id});
    return null;
   }
   file.owner=true;
   const {id:originalId,path,sha256,bytes,extractor}=file;
   return {kind:'file',path,sha256,bytes,originalId,rootIdentity,registryDigest,...(extractor?{extractor}:{}),
    agentArtifact:artifact,observation:'agent_observation',...owner};
  }
  for(const [index,record] of (data.records??[]).entries()){
   const source=observationSource(record,recordIds);
   if(source)facts.push(...observedRecord(record,index,source,scope,diagnostics,gaps));
  }
  for(const row of data.historicalRows??[]){
   const source=observationSource(row,histIds);
   if(source)facts.push(...observedHistory(row,source,scope,read.accountSet,diagnostics));
  }
  for(const file of files.values())file.declaredCount=observedCounts.get(file.id)??0;
 }
 const linked=linkHistory(db,scope,linkObservedHistory(facts,scope),opts),taxBurden=buildBaselineTaxBurden(linked);
 const snapshot={scope,facts:linked,files:[...files.values()],pagination:read.pagination,taxBurden,gaps:[...new Set([...gaps,...taxBurden.gaps])],artifacts};
 return {...snapshot,snapshotDigest:baselineSnapshotDigest(snapshot),diagnostics};
}
// 同源同位置只计一次。旧有原件核验与宿主观察的性质在合并后仍然可辨。
function sameHistoricalObservationValue(left,right){
 return left.period===right.period&&left.status===right.status&&(!left.date||!right.date||left.date===right.date)&&digest(left.entries)===digest(right.entries);
}
function uniqueFile(map,file){
 const previous=map.get(file.path);
 if(previous&&previous.sha256!==file.sha256)fail('finance_baseline_material_changed');
 if(!previous)map.set(file.path,file);
}
function finalAlias(aliases,ref){
 const seen=new Set();
 while(aliases.has(ref)&&aliases.get(ref)!==ref){
  if(seen.has(ref))fail('finance_baseline_material_record_invalid');
  seen.add(ref);ref=aliases.get(ref);
 }
 return ref;
}
function mergePostingFacts(vouchers,aliases,scope){
 const facts=[];
 for(const values of vouchers.values()){
  const first=values[0],relations=[...new Map(values.flatMap(f=>f.source.relations??[]).map(r=>({...r,businessRef:finalAlias(aliases,r.businessRef)})).map(r=>[digest(r),r])).values()];
  const source={...first.source};
  if(relations.length)source.relations=relations;
  else delete source.relations;
  const factRef=factDigest(scope,first.field,first.value,source);
  facts.push({...first,source,factRef,...(relations.length?{linkedBusinessRefs:[...new Set(relations.map(r=>r.businessRef))]}:{})});
  for(const old of values)aliases.set(old.factRef,factRef);
 }
 return facts;
}
export function mergeBaselineMaterialSnapshots(parts){
 if(!parts.length||parts.length>12)fail('finance_baseline_material_merge_limit');
 const scope=parts[0].scope;
 if(parts.some(part=>digest(part.scope)!==digest(scope)))fail('finance_baseline_scope_conflict');
 const aliases=new Map(),facts=[],physical=new Map(),vouchers=new Map(),files=new Map(),artifacts=new Map();
 const historicPositions=new Set(parts.flatMap(part=>part.facts.flatMap(f=>[f.source.agentHistoryPosition??f.source.adaptation?.physicalKey].filter(Boolean))));
 for(const part of parts){
  for(const file of part.files)uniqueFile(files,file);
  for(const artifact of part.artifacts??[])uniqueFile(artifacts,artifact);
  for(const f of part.facts){
   if(f.source.kind==='ledger_voucher'){
    const key=digest([f.source.voucherId,f.source.sha256]);
    if(!vouchers.has(key))vouchers.set(key,[]);
    vouchers.get(key).push(f);continue;
   }
   const {originalId,...source}=f.source;
   const nativeHistory=source.kind==='file'&&source.observation==='source_history_not_ledger_posting'&&['business_reference','historical_posting'].includes(f.field);
   const nativePosition=nativeHistory?digest([source.sha256,positionKey(source.locator)]):null;
   const observation=source.agentHistoryPosition??source.adaptation?.physicalKey??(historicPositions.has(nativePosition)?nativePosition:null);
   const observedKey=observation??(source.agentArtifact?digest([source.sha256,source.taxRecord??source.contextPath,source.locator]):null);
   const key=observedKey?digest({field:f.field,observation:observedKey}):digest({field:f.field,value:f.value,source});
   let canonical=physical.get(key);
   if(canonical&&observedKey){
    const equal=f.field==='historical_posting'?sameHistoricalObservationValue(canonical.value,f.value):digest(canonical.value)===digest(f.value);
    if(!equal)fail('finance_baseline_observation_conflict');
    if(nativeHistory&&canonical.verification!=='source_value_bound'){
     const previous=canonical;canonical=f;facts[facts.indexOf(previous)]=f;physical.set(key,f);
     aliases.set(previous.factRef,f.factRef);
    }
   }
   if(!canonical){canonical=f;physical.set(key,f);facts.push(f);}
   aliases.set(f.factRef,canonical.factRef);
  }
 }
 facts.push(...mergePostingFacts(vouchers,aliases,scope));
 const linked=linkObservedHistory(facts,scope);
 for(let index=0;index<facts.length;index++)if(facts[index].factRef!==linked[index].factRef)aliases.set(facts[index].factRef,linked[index].factRef);
 for(const part of parts)for(const [alias,ref]of Object.entries(part.factAliases??{}))if(!aliases.has(alias))aliases.set(alias,ref);
 for(const [alias,ref]of aliases)aliases.set(alias,finalAlias(aliases,ref));
 const byteTotal=map=>[...map.values()].reduce((sum,file)=>sum+file.bytes,0);
 if(files.size>128||linked.length>1000||byteTotal(files)>20*1024*1024||byteTotal(artifacts)>20*1024*1024)fail('finance_baseline_material_merge_limit');
 const taxBurden=buildBaselineTaxBurden(linked);
 const snapshot={scope,facts:linked,files:[...files.values()],artifacts:[...artifacts.values()],pagination:parts[0].pagination,taxBurden,
  gaps:[...new Set([...parts.flatMap(part=>part.gaps),...taxBurden.gaps])]};
 const diagnostics=parts.flatMap(part=>part.diagnostics??[]).filter(d=>d.code!=='historical_business_unlinked');
 return {...snapshot,snapshotDigest:baselineSnapshotDigest(snapshot),diagnostics:[...diagnostics,...historyDiagnostics(linked)],factAliases:Object.fromEntries(aliases)};
}
