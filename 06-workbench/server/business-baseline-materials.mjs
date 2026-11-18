// 基线资料的只读快照与固定业务投影；不复制原账、不建立第二套台账。
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,openSync,fstatSync,closeSync,readdirSync,opendirSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,basename,extname,join} from 'node:path';
import {captureEvidenceSource,parseEvidenceCsv,readEvidencePointer} from './business-evidence.mjs';
import {readMaterialDocument,readMaterialValue,projectMaterialDocument} from './material-document.mjs';
import {registeredMaterialIdentity,materialPartyContext,matchMaterialParty} from './material-identity.mjs';
import {getAccountingRoles,getAccountingProfile} from './accounting-profiles.mjs';
import {parseMoney,formatCents} from './money.mjs';
import {businessMemoryDigest} from './business-memory-storage.mjs';
import {BASELINE_FIELDS,BASELINE_FACT_VALUES,BASELINE_ALIASES,BASELINE_DATE_FIELDS,BASELINE_PERIOD_FIELDS,BASELINE_AMOUNT_FIELDS,BASELINE_QUANTITY_FIELDS} from './business-baseline-contracts.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
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
const scalar=value=>value===null||['string','number','boolean'].includes(typeof value);
const generatedMaterialSnapshot=data=>/^[a-f0-9]{64}$/.test(data?.snapshotDigest??'')&&data.scope&&Array.isArray(data.facts)&&data.facts.every(f=>/^bf:[a-f0-9]{64}$/.test(f?.factRef??'')&&f.source&&typeof f.field==='string')&&Array.isArray(data.files)&&data.taxBurden&&Array.isArray(data.gaps);
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
const ownerKeys=['enterpriseKey','enterprise_key','企业标识'];
const nameKeys=['companyName','company_name','企业名称','公司名称'];
function ownerStatus(contexts,scope,accountSet,explicit){
 const parties=materialPartyContext(contexts,accountSet);if(parties.conflict)fail('finance_baseline_source_scope_conflict');
 let found=parties.matched===true,strong=false;if(parties.invoiceParties&&!found)return false;const registered=accountSet.registeredNames??[],conflicting=accountSet.conflictingNames??[];
 for(const item of contexts){if(!item||typeof item!=='object'||Array.isArray(item))continue;
  for(const key of ownerKeys)if(Object.hasOwn(item,key)){if(item[key]!==scope.enterpriseKey)fail('finance_baseline_source_scope_conflict');found=true;strong=true;}
  for(const key of nameKeys)if(Object.hasOwn(item,key)){if(conflicting.includes(item[key])||!registered.includes(item[key])&&!(strong&&item[key]===accountSet.name))fail('finance_baseline_source_scope_conflict');found=true;}
  if(item.accountSetId!==undefined&&Number(item.accountSetId)!==scope.accountSetId||item.databaseInstanceId!==undefined&&item.databaseInstanceId!==scope.databaseInstanceId)fail('finance_baseline_source_scope_conflict');
 }
 if(explicit!==undefined){if(explicit!==scope.enterpriseKey&&!registered.includes(explicit)&&!(strong&&explicit===accountSet.name)||conflicting.includes(explicit))fail('finance_baseline_source_scope_conflict');found=true;}
 return found;
}
const registeredAccountSet=registeredMaterialIdentity;

function jsonContexts(data,pointer){const out=[data,data?.scope,data?.company];let item=data;for(const raw of pointer===''?[]:pointer.slice(1).split('/')){item=item?.[raw.replaceAll('~1','/').replaceAll('~0','~')];if(item&&typeof item==='object'){out.push(item,item.scope,item.company);}}return out;}
const roleNames={cash:'cash',bank:'bank',receivable:'receivable',payable:'payable',inventory:'inventory',mainRevenue:'main_income',otherRevenue:'other_income',mainCost:'main_cost',otherCost:'main_cost',fixedAsset:'fixed_asset',accumulatedDepreciation:'accumulated_depreciation',intangibleAsset:'intangible_asset',accumulatedAmortization:'accumulated_amortization',salesExpense:'sales_expense',managementExpense:'management_expense',adminExpense:'management_expense',defaultDepreciationExpense:'management_expense',financeExpense:'finance_expense',taxPayable:'tax_payable',currentProfit:'current_profit',currentYearProfit:'current_profit',profitDistribution:'retained_profit'};
function roleFunction(profile){const roles={...getAccountingRoles(profile)},trustedNames={'应交税费':'taxPayable','库存现金':'cash','银行存款':'bank','应收账款':'receivable','应付账款':'payable','库存商品':'inventory','原材料':'inventory'};for(const a of getAccountingProfile(profile).coa)if(trustedNames[a.name])roles[trustedNames[a.name]+a.code]=a.code;
 return code=>Object.entries(roles).filter(([,v])=>typeof v==='string'&&String(code).startsWith(v)).sort((a,b)=>b[1].length-a[1].length).map(([k])=>roleNames[k]??Object.entries(trustedNames).find(([,key])=>k.startsWith(key))?.[1]?.replace('taxPayable','tax_payable')??'other')[0]??'unknown';}
function fact(scope,field,value,source,{id,group}={}){return {factRef:'bf:'+digest({owner:[scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId],field,value,source}),field,value,source,...(id?{id}:{}),...(group?{group}:{}),verification:source.kind==='file'?'source_value_bound':'ledger_observation',semanticAuthority:'source_observation_not_human_approval'};}
export function baselineLedgerFact(db,scope,source){
 if(source.kind==='ledger_configuration'){if(!['accounting_standard','taxpayer_type'].includes(source.column))fail('finance_baseline_record_invalid');const r=db.prepare(`SELECT ${source.column} value FROM account_sets WHERE id=?`).get(scope.accountSetId);return r?digest(r.value):null;}
 if(source.kind==='ledger_voucher'){const voucher=db.prepare('SELECT * FROM vouchers WHERE account_set_id=? AND id=?').get(scope.accountSetId,source.voucherId);if(!voucher)return null;return digest({voucher,entries:db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id').all(voucher.id)});}
 if(source.kind==='ledger_asset'){const r=db.prepare('SELECT * FROM asset_cards WHERE account_set_id=? AND id=?').get(scope.accountSetId,source.assetId);return r?digest(r):null;}
 return null;
}
function ledger(db,scope,args){
 const accountSet=registeredAccountSet(db,scope),facts=[];
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
// 发现只列有限结构及位置；不把未知文本、身份字段值、文件名或原科目向模型展开。
const fieldHints={
 accountingStandard:'accounting_standard','会计准则':'accounting_standard',enterpriseClass:'enterprise_class','企业类型':'enterprise_class',costMethod:'inventory_cost','存货计价方法':'inventory_cost','既有计价设置':'inventory_cost',method:'inventory_cost',
 businessKind:'business_kind','业务类别':'business_kind','业务类型':'business_kind',pattern:'service_pattern',servicePattern:'service_pattern','提供方式':'service_pattern','服务方式':'service_pattern',createsAsset:'creates_asset','是否形成资产':'creates_asset',
 start:'service_start',serviceStart:'service_start','租期开始':'service_start','服务开始日':'service_start','服务开始':'service_start',end:'service_end',serviceEnd:'service_end','租期结束':'service_end','服务结束日':'service_end','服务结束':'service_end',
 net:'amount_net','净租金':'amount_net','不含税金额':'amount_net',tax:'amount_tax','税额':'amount_tax',gross:'amount_gross','含税金额':'amount_gross',
 invoice:'invoice_date',invoiceDate:'invoice_date','发票日期':'invoice_date','开票日':'invoice_date',receipt:'receipt_date',receiptDate:'receipt_date','收款日':'receipt_date','收款日期':'receipt_date',due:'contract_due_date',dueDate:'contract_due_date','合同应付日':'contract_due_date',confirmationDate:'confirmation_date','用途确认日':'confirmation_date','交付日':'delivery_date','验收日':'delivery_date',
 taxType:'tax_type','税种':'tax_type',measure:'tax_measure','税款口径':'tax_measure',stage:'tax_stage','税额阶段':'tax_stage',basis:'period_basis','期间口径':'period_basis',accumulation:'accumulation','累计口径':'accumulation',periodStart:'period_start','所属期开始':'period_start','所属期起':'period_start',periodEnd:'period_end','所属期结束':'period_end','所属期止':'period_end',taxAmount:'tax_amount','减免后累计应纳税额':'tax_amount','应纳税额':'tax_amount',sales:'sales_ex_vat','不含税销售额':'sales_ex_vat','累计收入':'revenue',
 choice:'tax_choice','租赁税务计税选择':'tax_choice','计税方法':'tax_choice',validFrom:'choice_valid_from','有效开始日':'choice_valid_from',validThrough:'choice_valid_through','有效结束日':'choice_valid_through',
 contractId:'business_reference',contractNumber:'business_reference',businessReference:'business_reference',business_reference:'business_reference','合同编号':'business_reference','合同号':'business_reference','业务编号':'business_reference',
 '采购编号':'business_reference','工单':'business_reference','净价':'amount_net','发票税额':'amount_tax','不含税购置价':'amount_net','付款日':'payment_date','合同约定付款日':'contract_due_date','是否形成或改良资产':'creates_asset','是否形成承租人资产':'creates_asset','验收可用日':'delivery_date','劳务日期':'delivery_date','完工验收日':'delivery_date','客户签收验收日':'delivery_date','有效终止日':'choice_valid_through','所得税租金口径':'income_tax_period','税额口径':'tax_measure','不含税应税销售额':'sales_ex_vat','累计营业收入':'revenue','累计实际已预缴':'tax_amount','实缴税额':'tax_amount','已缴税额':'tax_amount','优惠前应纳税额':'tax_amount','减免后应纳税额':'tax_amount','应补税额':'tax_amount','本期应纳税额':'tax_amount',
 '业务性质':'business_kind','期初数量':'opening_quantity','期初单价':'opening_unit_price','本月购入数量':'receipt_quantity','本月购入单价':'receipt_unit_price','本月领用数量':'issue_quantity',
};
const taxSourceSemantics={
 '累计实际已预缴':{tax_measure:'paid',tax_stage:'paid',accumulation:'cumulative'},'实缴税额':{tax_measure:'paid',tax_stage:'paid'},'已缴税额':{tax_measure:'paid',tax_stage:'paid'},
 '减免后累计应纳税额':{tax_measure:'payable',tax_stage:'payable_after_relief',accumulation:'cumulative'},'优惠前应纳税额':{tax_measure:'payable',tax_stage:'payable_before_relief'},'减免后应纳税额':{tax_measure:'payable',tax_stage:'payable_after_relief'},'应补税额':{tax_measure:'payable',tax_stage:'balance_due'},'本期应纳税额':{tax_measure:'payable',accumulation:'current'},'应纳税额':{tax_measure:'payable'},'累计营业收入':{accumulation:'cumulative'},
};
const suggest=key=>Object.hasOwn(BASELINE_FACT_VALUES,key)||[...BASELINE_DATE_FIELDS,...BASELINE_PERIOD_FIELDS,...BASELINE_AMOUNT_FIELDS,...BASELINE_QUANTITY_FIELDS,'creates_asset','business_reference'].includes(key)?key:fieldHints[key];
function jsonStructure(data,hash,locations){const out=[];let walked=0;const walk=(value,p='',key='',parent='',depth=0)=>{if(++walked>12000||depth>16)fail('finance_baseline_material_limit');if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value))walk(v,p+'/'+k.replaceAll('~','~0').replaceAll('/','~1'),k,p,depth+1);}else{
  const fieldRef='bl:'+digest([hash,p]);locations.set(fieldRef,{jsonPointer:p});const field=suggest(key),owner=[...ownerKeys,...nameKeys].includes(key);
  if(field||owner)out.push({locator:{fieldRef},type:value===null?'null':typeof value,suggestedFields:field?[field]:[],...(owner?{meaning:'enterprise_identity'}:{}),suggestedGroup:'g'+digest(parent).slice(0,24)});
 }};walk(data);return {fields:out};}
function csvRecord(rows,locator){const headers=rows[(locator.headerRows??[1]).at(-1)-1],row=rows[locator.row-1];if(!headers||!row)fail('finance_baseline_locator_missing');return Object.fromEntries(headers.map((h,i)=>[h,row[i]]));}
function loadOriginal(original,scope,accountSet,opts,cache){
 if(cache.has(original.id))fail('finance_baseline_original_duplicate');
 const document=readMaterialDocument({path:original.path,sourceRoot:opts.sourceRoot,expectedSha256:original.sha256,pythonPath:opts.pythonPath??process.env.FINANCE_PYTHON_PATH,pythonUserBase:opts.pythonUserBase,pageOffset:original.pageOffset??0,maxPages:original.maxPages??40});
 const {sha256:hash,bytes}=document.source,format=document.format,data=document.data,locations=new Map(document.locations??[]);
 if(data&&(/^(finance-|business-baseline)/.test(data.version??'')||generatedMaterialSnapshot(data)))fail('finance_baseline_generated_not_original');
 let structure={fields:[]},rows,sheets;
 if(format==='json')structure=jsonStructure(data,hash,locations);
 else if(format==='csv'){
  rows=document.tables[0]?.rows.map(r=>r.cells)??[];
  structure={columns:(rows[0]??[]).map((name,index)=>({column:index+1,suggestedFields:suggest(name)?[suggest(name)]:[],...([...ownerKeys,...nameKeys].includes(name)?{meaning:'enterprise_identity'}:{})})),rowCount:Math.max(0,rows.length-1)};
 }else if(['xls','xlsx'].includes(format)){
  sheets=document.tables;
  structure={sheets:sheets.map(s=>({sheetIndex:s.sheetIndex,rowCount:s.rows.length,headers:s.rows.slice(0,8).flatMap(r=>r.cells.flatMap((value,i)=>suggest(value)||[...ownerKeys,...nameKeys].includes(value)?[{row:r.rowNumber,column:i+1,suggestedFields:suggest(value)?[suggest(value)]:[],...([...ownerKeys,...nameKeys].includes(value)?{meaning:'enterprise_identity'}:{})}]:[]))}))};
 }
 const projected=projectMaterialDocument(document,{offset:original.structureOffset??0,limit:400}),publicOriginal={...original,path:undefined,originalRef:sourceReference(opts.sourceRoot,original.path)};
 structure.documentFields=projected.fields??projected.locations??projected.items??[];
 structure.readState=document.readState;structure.extractor=document.extractor;structure.documentPagination=projected.pagination;
 if(projected.pagination?.nextOffset!==null)structure.structureNext={tool:'finance_baseline_materials',arguments:{target:{accountSetId:scope.accountSetId,period:scope.period},originals:[{...publicOriginal,structureOffset:projected.pagination.nextOffset}],section:'structure'}};
 if(document.nextPageOffset!==undefined)structure.pageNext={tool:'finance_baseline_materials',arguments:{target:{accountSetId:scope.accountSetId,period:scope.period},originals:[{...publicOriginal,pageOffset:document.nextPageOffset,structureOffset:0}],section:'structure'}};
 structure.readDiagnostics=document.diagnostics;
 const partial={...original,path:resolve(original.path),sha256:hash,bytes,format,data,rows,sheets,locations,document,evidenceCache:new Map()};
 let explicit;if(original.owner)explicit=selectRaw(partial,original.owner,opts).value;
 let identityResult;
 if(original.ownerIdentity)identityResult=explicitIdentity(partial,original.ownerIdentity,accountSet,opts);
 const contexts=data?[data,data.scope,data.company]:document.tables.flatMap(s=>{const header=s.rows[0]?.cells??[];return s.rows.slice(1).map(r=>Object.fromEntries(header.map((h,i)=>[h,r.cells[i]])));});
 let owner=false;try{owner=identityResult?.matched??ownerStatus(contexts,scope,accountSet,explicit);}catch(error){if(error.code!=='finance_baseline_source_scope_conflict')throw error;}
 const detected=identityResult??materialPartyContext(contexts,accountSet);
 structure.identity={matched:owner,registeredNameAvailable:accountSet.registeredNames.length>0,...(!owner?{reason:accountSet.registeredNames.length||(accountSet.registeredTaxIds??[]).length?'source_owner_unmatched':'registered_identity_missing'}:{}),role:detected.role??'enterprise',roleAuthority:detected.roleAuthority??'source_labels',basis:detected.basis??'source_identity',taxIdAvailability:(accountSet.registeredTaxIds??[]).length?'registered':'not_registered',...(detected.invoiceDirection?{invoiceDirection:detected.invoiceDirection}:{})};
 const result={...partial,explicit,owner,identityResult,identitySummary:structure.identity,structure};cache.set(original.id,result);return result;
}
// 只排除逐文件核实的自写技术记录；同一call目录中的其他客户文件仍进入普通发现队列。
function generatedRecordFiles(dir,root,budget){
 const names=new Set(),callId=basename(dir);if(!/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/.test(callId))return names;
 if(++budget.records>2000){budget.limited=true;return names;}
 const read=(name,max=2*1024*1024)=>{const path=join(dir,name),stat=lstatSync(path),available=Math.min(max,64*1024*1024-budget.bytes);if(stat.size>available){budget.limited=true;fail('finance_baseline_technical_scan_limit');}const bytes=baselineBytes(path,root,{max:available});budget.bytes+=bytes.length;return bytes;};
 const descriptor=ref=>ref&&typeof ref==='object'&&/^[a-f0-9]{64}$/.test(ref.sha256??'')&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0;
 const matches=(bytes,ref)=>descriptor(ref)&&bytes.length===ref.bytes&&sha(bytes)===ref.sha256;
 try{
  const beginBytes=read('begin.json'),begin=JSON.parse(beginBytes);
  if(begin.version!=='finance-call-record/1'||begin.callId!==callId||typeof begin.tool!=='string'||!begin.tool||typeof begin.startedAt!=='string'||!Number.isFinite(Date.parse(begin.startedAt))||!/^[a-f0-9]{64}$/.test(begin.recorderCodeDigest??'')||!Array.isArray(begin.sources)||!begin.sources.every(s=>s&&typeof s.path==='string'&&typeof s.locator==='string')||begin.input?.file!=='input.json'||!descriptor(begin.input))return names;
  const inputBytes=read('input.json',5*1024*1024);if(!matches(inputBytes,begin.input))return names;JSON.parse(inputBytes);names.add('begin.json');names.add('input.json');
  // 正在运行的本调用只有已完成的begin/input；没有end不猜认result或其他文件。
  const end=JSON.parse(read('end.json'));
  if(end.version!=='finance-call-record/1'||end.callId!==callId||end.beginSha256!==sha(beginBytes)||!['returned','failed','unknown','rejected','tool_error'].includes(end.status)||typeof end.executionCompleted!=='boolean'||!Number.isFinite(end.durationMs)||end.durationMs<0||!['result.json','error.json'].includes(end.output?.file)||!descriptor(end.output))return names;
  const outputBytes=read(end.output.file,20*1024*1024);if(!matches(outputBytes,end.output))return names;JSON.parse(outputBytes);names.add('end.json');names.add(end.output.file);
  for(const [key,file]of [['businessBaselineMaterials','baseline-materials.json'],['businessEvidence','business-evidence.json']]){const ref=end.metadata?.[key];if(ref?.file!==file||!descriptor(ref))continue;
   try{const bytes=read(file,20*1024*1024);if(!matches(bytes,ref))continue;const value=JSON.parse(bytes);if(key==='businessBaselineMaterials'?(value.version==='finance-baseline-materials-snapshot/1'||generatedMaterialSnapshot(value)):value.version==='business-evidence/1')names.add(file);}catch{/* 未核技术文件继续按普通候选计数，不能凭描述符路径排除客户文件。 */}
  }
 }catch{/* 缺失、失效、链接或预算外记录不整体排除；只保留已经逐文件核实的路径。 */}
 return names;
}
function sourceFiles(root){
 if(typeof root!=='string'||!isAbsolute(root))return {paths:[],unsupported:{},truncated:false,generatedFilesExcluded:0,technicalScanLimited:false};const base=resolve(root);
 for(let p=base;;p=dirname(p)){if(lstatSync(p).isSymbolicLink()||realpathSync(p).toLowerCase()!==p.toLowerCase())fail('finance_baseline_source_forbidden');if(p===dirname(p))break;}
 if(!lstatSync(base).isDirectory())fail('finance_baseline_source_forbidden');const paths=[],unsupported={},technical={records:0,bytes:0,limited:false};let visited=0,truncated=false,generatedFilesExcluded=0;
 const walk=(dir,depth)=>{const generated=generatedRecordFiles(dir,base,technical);for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(generated.has(entry.name)&&entry.isFile()&&!entry.isSymbolicLink()){generatedFilesExcluded++;continue;}if(++visited>2000)fail('finance_baseline_material_limit');const path=join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){if(depth<4)walk(path,depth+1);else truncated=true;}else if(entry.isFile()){const format=extname(entry.name).slice(1).toLowerCase();if(['json','csv','xlsx','xls','pdf','docx','txt','md','png','jpg','jpeg','tif','tiff','bmp','webp'].includes(format))paths.push(path);else {const label=['pdf','docx','txt','md','xls'].includes(format)?format:'other';unsupported[label]=(unsupported[label]??0)+1;}}}};walk(base,0);return {paths,unsupported,truncated,generatedFilesExcluded,technicalScanLimited:technical.limited};
}
const sourceReference=(root,path)=>'bs:'+digest([resolve(root),relative(resolve(root),path)]);
function materialReadFailure(error,original,opts){
 const candidate=typeof error.code==='string'?error.code:'';
 const dependency=/^material_document_dependency_missing:(xlrd|openpyxl|fitz|docx|PIL)$/.exec(candidate);
 const code=dependency?'material_document_dependency_missing_'+dependency[1].toLowerCase():/^(?:finance_baseline_|material_document_|ocr_|xlsx_)[a-z0-9_]+$/.test(candidate)?candidate:['ENOENT','EACCES','EPERM'].includes(candidate)?'finance_baseline_source_unavailable':'material_document_read_failed';
 return {code,stage:'read',recoverable:!/(?:source_(?:changed|forbidden|unavailable)|generated_not_original|formula|cell_error|external_link|active_content|macro|encrypted|scope|owner)/.test(code),originalId:original.id,originalRef:original.originalRef??sourceReference(opts.sourceRoot,original.path)};
}
export function resolveBaselineSourceReferences(originals,opts){
 if(!originals.some(o=>o.originalRef))return originals;
 const files=sourceFiles(opts.sourceRoot),map=new Map(files.paths.map(path=>[sourceReference(opts.sourceRoot,path),path]));
 return originals.map(o=>{if(!o.originalRef)return o;const path=map.get(o.originalRef);if(!path)fail('finance_baseline_original_missing');return {...o,path};});
}
function resolveOriginalReferences(args,opts){
 return {...args,originals:resolveBaselineSourceReferences(args.originals??[],opts)};
}
export function discoverBaselineSourceInventory(db,scope,args,opts){
 if(typeof opts.sourceRoot!=='string'||!isAbsolute(opts.sourceRoot))return {projection:{status:'source_root_unconfigured',items:[],pagination:{offset:0,limit:args.limit??20,total:0,nextOffset:null}},sources:[]};
 const files=sourceFiles(opts.sourceRoot),offset=args.offset??0,limit=args.limit??20,accountSet=registeredAccountSet(db,scope),items=[],sources=[];let bytes=0;
 for(const path of files.paths.slice(offset,offset+limit)){
  const base={originalRef:sourceReference(opts.sourceRoot,path),format:extname(path).slice(1).toLowerCase()};
  try{const st=lstatSync(path);if(st.size>5*1024*1024||bytes+st.size>20*1024*1024){items.push({...base,ownerStatus:'unverified',status:'size_limit'});continue;}bytes+=st.size;
   const loaded=loadOriginal({id:'inventory',path},scope,accountSet,opts,new Map()),structure=loaded.structure;
   const fields=[...(structure.fields??[]),...(structure.columns??[]),...(structure.sheets??[]).flatMap(s=>s.headers)];
   const diagnostics=loaded.document.diagnostics?.map(d=>loaded.document.readState==='read'?{code:d.code}:materialReadFailure(d,{id:'source',originalRef:base.originalRef,path},opts));
   const readingFailed=['unsupported','needs_runtime'].includes(loaded.document.readState),next=readingFailed&&diagnostics?.some(d=>d.recoverable)?{tool:'finance_record_contract',arguments:{recordType:'baseline_adaptation'}}:{tool:'finance_baseline_materials',arguments:{target:{accountSetId:scope.accountSetId,period:scope.period},originals:[{id:'source',originalRef:base.originalRef}],section:'structure'}};
   items.push({...base,ownerStatus:loaded.owner?'verified':'unverified',status:loaded.document.status==='read'?'inspectable':loaded.document.status,readState:loaded.document.readState,diagnostics,identity:loaded.identitySummary,next,availableFields:[...new Set(fields.flatMap(f=>f.suggestedFields??[]))].slice(0,16)});sources.push({path:loaded.path,sha256:loaded.sha256,bytes:loaded.bytes});
  }catch(error){const diagnostic=materialReadFailure(error,{id:'source',originalRef:base.originalRef,path},opts);items.push({...base,ownerStatus:error.code==='finance_baseline_source_scope_conflict'?'other_scope':'unverified',status:error.code==='finance_baseline_generated_not_original'?'generated_not_original':'unsupported_or_unverified',diagnostics:[diagnostic],...(diagnostic.recoverable?{next:{tool:'finance_record_contract',arguments:{recordType:'baseline_adaptation'}}}:{})});}
 }
 return {projection:{status:'available',items,pagination:{offset,limit,total:files.paths.length,nextOffset:offset+limit<files.paths.length?offset+limit:null},unsupportedFormats:files.unsupported,depthTruncated:files.truncated,generatedFilesExcluded:files.generatedFilesExcluded,technicalScanLimited:files.technicalScanLimited},sources};
}
// 高层取材只发现当前授权目录中已核主体、有已知字段的来源；把每批转为显式原件后仍走同一逐值核验。
export function discoverBaselineKnownSources(db,scope,opts,previous){
 const root=resolve(opts.sourceRoot??''),batchSize=12;
 let state;
 if(previous){
  if(previous.version!=='finance-baseline-source-discovery/1'||previous.root!==root||digest(previous.scope)!==digest(scope)||!Array.isArray(previous.eligible)||previous.eligible.length>128||!Array.isArray(previous.scannedSources)||previous.scannedSources.length>128||!Number.isSafeInteger(previous.nextIndex)||previous.nextIndex<0||previous.nextIndex>previous.eligible.length)fail('finance_baseline_discovery_cursor_invalid');
  if(previous.nextIndex===previous.eligible.length)fail('finance_baseline_discovery_cursor_exhausted');
  // 游标接续的是已发现业务源快照，不因本工具在同目录新增审计JSON而失效；所有计划业务源仍核当前SHA。
  for(const source of previous.eligible)if(sha(baselineBytes(source.path,root))!==source.sha256)fail('finance_baseline_material_changed');state={...previous};
 }else{
  const files=sourceFiles(opts.sourceRoot),accountSet=registeredAccountSet(db,scope),eligible=[],scannedSources=[],bypassed={other_scope:0,owner_unverified:0,no_known_fields:0,unsupported:0,size_limit:0};let totalBytes=0,scannedCount=0;
  for(const path of files.paths.slice(0,128)){
   scannedCount++;try{
    const stat=lstatSync(path);if(stat.size>5*1024*1024||totalBytes+stat.size>20*1024*1024){bypassed.size_limit++;continue;}const bytes=baselineBytes(path,root);totalBytes+=bytes.length;scannedSources.push({path,sha256:sha(bytes),bytes:bytes.length});
    const id='discovered_'+digest([root,path]).slice(0,24),loaded=loadOriginal({id,path},scope,accountSet,opts,new Map()),known=knownFacts(loaded,scope,accountSet,opts);
    if(['unsupported','needs_runtime'].includes(loaded.document.status)){const reason=loaded.document.status==='needs_runtime'?'runtime_unavailable':'unsupported';bypassed[reason]=(bypassed[reason]??0)+1;continue;}
    if(!known.availableCount){bypassed.no_known_fields++;continue;}
    if(!loaded.owner&&(known.gaps.includes('scope_conflict')||known.gaps.includes('owner_unverified')||!known.facts.length)){bypassed[known.gaps.includes('scope_conflict')?'other_scope':'owner_unverified']++;continue;}
    eligible.push({id,path,sha256:loaded.sha256});
   }catch(error){bypassed[error.code==='finance_baseline_source_scope_conflict'?'other_scope':'unsupported']++;}
  }
  state={version:'finance-baseline-source-discovery/1',scope,root,eligible,scannedSources,nextIndex:0,scannedCount,uninspectedCount:Math.max(0,files.paths.length-scannedCount),bypassed,unsupportedFormats:files.unsupported,depthTruncated:files.truncated,generatedFilesExcluded:files.generatedFilesExcluded,technicalScanLimited:files.technicalScanLimited};
 }
 const originals=state.eligible.slice(state.nextIndex,state.nextIndex+batchSize);state.nextIndex+=originals.length;state.lastBatchCount=originals.length;
 return {state,originals,projection:baselineDiscoveryProjection(state)};
}
export const baselineDiscoveryProjection=state=>({mode:'authorized_scope_known_fields',scannedCount:state.scannedCount,selectedCount:state.lastBatchCount,eligibleCount:state.eligible.length,remainingCount:state.eligible.length-state.nextIndex,uninspectedCount:state.depthTruncated?null:state.uninspectedCount,scanLimited:state.depthTruncated||state.uninspectedCount>0||state.bypassed.size_limit>0||state.technicalScanLimited===true,bypassed:state.bypassed,unsupportedFormats:state.unsupportedFormats,depthTruncated:state.depthTruncated,generatedFilesExcluded:state.generatedFilesExcluded??0,technicalScanLimited:state.technicalScanLimited===true,scanLimits:{files:128,bytes:20*1024*1024,batchFiles:12,technicalRecords:2000,technicalBytes:64*1024*1024}});
function selectRaw(original,requested,opts){
 const locator=requested.fieldRef?.startsWith('bl:')?original.locations.get(requested.fieldRef):requested;
 if(!locator)fail('finance_baseline_locator_missing');
 const {valueSlice,...actualLocator}=locator;const captured=readMaterialValue(original.document,actualLocator);if(captured.valueState==='formula_unverified')fail('xlsx_formula_unsupported');if(captured.valueState==='cell_error')fail('finance_baseline_cell_error');const actual={...captured.locator,...(valueSlice?{valueSlice}:{})};captured.value=slicedValue(captured.value,valueSlice);
 let key=captured.key;
 if(!key&&original.format==='json')key=actual.jsonPointer?.split('/').at(-1).replaceAll('~1','/').replaceAll('~0','~');
 if(!key&&actual.row){const sheet=original.document.tables.find(s=>s.sheetIndex===(actual.sheetIndex??0));const headers=sheet?.rows.find(r=>r.rowNumber===(actual.headerRows??[1]).at(-1));key=headers?.cells[(actual.column??1)-1];}
 return {...captured,contextPath:actual.jsonPointer!==undefined?actual.jsonPointer.slice(0,actual.jsonPointer.lastIndexOf('/')):actual.row?`sheet:${actual.sheetIndex??0}/row:${actual.row}`:`page:${actual.page}/line:${actual.line}`,hint:suggest(key),semantics:taxSourceSemantics[key],key};
}
function explicitIdentity(original,mapping,accountSet,opts){
 const name=selectRaw(original,mapping.name,opts),taxId=mapping.taxId?selectRaw(original,mapping.taxId,opts):null;
 const result=matchMaterialParty({role:mapping.role,name:name.value,taxId:taxId?.value},accountSet);
 return {...result,roleAuthority:'model_interpretation',identityContext:name.contextPath,locators:{name:name.locator,...(taxId?{taxId:taxId.locator}:{})}};
}
function capturedOwner(original,captured,selection,scope,accountSet,opts){
 const row=materialPartyContext(captured.contexts,accountSet);
 if(row.conflict)fail('finance_baseline_source_scope_conflict');
 if(row.matched)return row;
 // 某一行出现明确购销方而双方均不属本账套，文件其他行的归属不能替它背书。
 if(row.invoiceParties)return row;
 if(selection.ownerIdentity)return explicitIdentity(original,selection.ownerIdentity,accountSet,opts);
 if(original.identityResult){
  const owner=original.identityResult;
  const keyValue=original.document.tables.length>0&&original.document.tables.every(t=>t.rows.every(r=>r.cells.length<=2));
  return !keyValue&&owner.identityContext.startsWith('sheet:')&&owner.identityContext!==captured.contextPath?{...owner,matched:false}:owner;
 }
 return {matched:ownerStatus(captured.contexts,scope,accountSet,original.explicit),role:'enterprise',basis:captured.contexts.some(c=>c&&typeof c==='object'&&ownerKeys.some(k=>c[k]===scope.enterpriseKey))?'enterprise_key':'registered_name',taxIdAvailability:(accountSet.registeredTaxIds??[]).length?'registered':'not_registered'};
}
function slicedValue(value,slice){
 if(!slice)return value;if(typeof value!=='string')fail('finance_baseline_text_slice_invalid');
 const start=value.indexOf(slice.after);if(start<0||value.indexOf(slice.after,start+slice.after.length)>=0)fail('finance_baseline_text_slice_invalid');
 let result=value.slice(start+slice.after.length);if(slice.before){const end=result.indexOf(slice.before);if(end<0)fail('finance_baseline_text_slice_invalid');result=result.slice(0,end);}return result.trim().replace(/^[：:=\s]+/u,'').trim();
}

function interpretationFailure(selection,selectionIndex,reason){
 const code='finance_baseline_interpretation_invalid',error=Object.assign(Error(code),{code});
 // 只披露实际请求序号和当前字段的固定候选；原值、调用者解释及输入值都不回显。
 if(Number.isSafeInteger(selectionIndex)&&selectionIndex>=0&&BASELINE_FIELDS.includes(selection.field)){
  const allowedValues=Object.hasOwn(BASELINE_FACT_VALUES,selection.field)?[...BASELINE_FACT_VALUES[selection.field]]:selection.field==='creates_asset'?[true,false]:[];
  error.details={interpretation:{selectionIndex,field:selection.field,reason,allowedValues}};
 }
 throw error;
}
function select(original,selection,scope,accountSet,opts,selectionIndex){
 const captured=selectRaw(original,selection.locator,opts);captured.value=slicedValue(captured.value,selection.valueSlice);if(!scalar(captured.value))fail('finance_baseline_scalar_required');
 if(captured.hint&&captured.hint!==selection.field&&!selection.interpretation)return {gap:'unsupported_material'};
 if(BASELINE_AMOUNT_FIELDS.includes(selection.field))for(const context of captured.contexts){if(!context||typeof context!=='object'||Array.isArray(context))continue;
  for(const key of ['currency','币种','记账币种'])if(Object.hasOwn(context,key)&&!['CNY','RMB','人民币','人民币元'].includes(context[key]))return {gap:'unsupported_material'};
  for(const key of ['amountUnit','unit','金额单位'])if(Object.hasOwn(context,key)&&!['yuan','元','人民币元','CNY','RMB'].includes(context[key]))return {gap:'unsupported_material'};
  if(['sales_ex_vat','revenue'].includes(selection.field))for(const key of ['amountBasis','priceBasis','金额口径','销售额口径'])if(Object.hasOwn(context,key)&&!['tax_exclusive','不含税','不含税金额','不含税销售额'].includes(context[key]))return {gap:'unsupported_material'};
 }
 const identity=capturedOwner(original,captured,selection,scope,accountSet,opts);if(!identity.matched)return {gap:'owner_unverified'};
 // 可定位行的主体/期间上下文与文件总范围一起保留；后续不会把一行绑定成别的公司。
 let value=normalizeBaselineValue(selection.field,captured.value);
 if(selection.interpretation){
  if(!(Object.hasOwn(BASELINE_FACT_VALUES,selection.field)||selection.field==='creates_asset'))interpretationFailure(selection,selectionIndex,'field_not_interpretable');
  const interpreted=normalizeBaselineValue(selection.field,selection.interpretation.value);
  if(interpreted===undefined)interpretationFailure(selection,selectionIndex,'invalid_enum');
  if(value!==undefined&&value!==interpreted)interpretationFailure(selection,selectionIndex,'source_value_conflict');
  value=interpreted;
 }
 if(value===undefined)return {gap:'unsupported_material'};
 const contextBusinessKinds=[...new Set([...captured.contexts.flatMap(c=>c&&typeof c==='object'&&!Array.isArray(c)?Object.entries(c).filter(([k])=>suggest(k)==='business_kind').map(([,v])=>normalizeBaselineValue('business_kind',v)).filter(Boolean):[]),...(/租金|租赁/.test(captured.key)?['lease']:[])])];
 const source={kind:'file',path:original.path,sha256:original.sha256,bytes:original.bytes,originalId:original.id,locator:captured.locator,contextPath:captured.contextPath,rootIdentity:baselineDirectoryIdentity(opts.sourceRoot),extractor:original.document.extractor,identity:{role:identity.role,roleAuthority:identity.roleAuthority??'source_labels',basis:identity.basis,taxIdAvailability:identity.taxIdAvailability,...(identity.invoiceDirection?{invoiceDirection:identity.invoiceDirection}:{})},...(selection.valueSlice?{valueSlice:selection.valueSlice}:{}),...(selection.interpretation?{interpretation:{kind:'model_interpretation',...selection.interpretation}}:{}),...(captured.semantics?{semantics:captured.semantics}:{}),...(contextBusinessKinds.length?{contextBusinessKinds}:{})};
 return {value:fact(scope,selection.field,value,source,{id:selection.id,group:digest([original.path,captured.contextPath])})};
}
function historicalRole(accountSet,captures){
 const role=captures.code?roleFunction(accountSet.accounting_profile_id)(String(captures.code.value)):'unknown';
 if(role!=='unknown'||!captures.accountName)return role;
 const names={'主营业务收入':'main_income','其他业务收入':'other_income','主营业务成本':'main_cost','管理费用':'management_expense','销售费用':'sales_expense','财务费用':'finance_expense','应交税费':'tax_payable'};
 return Object.entries(names).find(([name])=>String(captures.accountName.value).startsWith(name))?.[1]??'unknown';
}
function historicalObservations(originals,mappings,scope,accountSet,opts,diagnostics){
 const out=[];
 for(const mapping of mappings??[]){
  const original=originals.get(mapping.originalId);if(!original)fail('finance_baseline_original_missing');
  if(['unsupported','needs_runtime'].includes(original.document.readState))continue;
  const captures=Object.fromEntries(['period','date','businessReference','code','accountName','debit','credit'].filter(key=>mapping[key]).map(key=>[key,selectRaw(original,mapping[key],opts)]));
  const anchor=captures.businessReference;
  const recordContext=Object.values(captures).every(c=>anchor.locator.row!==undefined?c.locator.row===anchor.locator.row&&(c.locator.sheetIndex??0)===(anchor.locator.sheetIndex??0):anchor.locator.jsonPointer!==undefined?c.contextPath===anchor.contextPath:c.locator.page===anchor.locator.page);
  if(!recordContext)fail('finance_baseline_historical_context_conflict');
  if(anchor.locator.page!==undefined&&Object.values(captures).some(c=>c.locator.line!==anchor.locator.line)){const refs=new Set(original.document.blocks.filter(b=>b.page===anchor.locator.page).flatMap(b=>{const pair=/^\s*([^:：]+)[:：]\s*(.+?)\s*$/.exec(b.text);return pair&&suggest(pair[1].trim())==='business_reference'?[normalizeBaselineValue('business_reference',pair[2])]:[];}).filter(Boolean));if(refs.size!==1||!refs.has(anchor.value))fail('finance_baseline_historical_context_conflict');}
  const identity=capturedOwner(original,anchor,mapping,scope,accountSet,opts);if(!identity.matched)fail('finance_baseline_historical_owner_unverified');
  const period=normalizeBaselineValue('period_start',captures.period.value),date=captures.date?normalizeBaselineValue('invoice_date',captures.date.value):null,reference=normalizeBaselineValue('business_reference',anchor.value);
  const debit=normalizeBaselineValue('amount_net',captures.debit.value),credit=normalizeBaselineValue('amount_net',captures.credit.value);
  if(!period||period>=scope.period||captures.date&&(!date||date.slice(0,7)!==period)||!reference||debit===undefined||credit===undefined||debit>0&&credit>0)fail('finance_baseline_historical_row_invalid');
  const role=historicalRole(accountSet,captures);
  if(role==='unknown')diagnostics.push({code:'historical_account_unmapped',originalId:original.id});
  const source={kind:'file',path:original.path,sha256:original.sha256,bytes:original.bytes,originalId:original.id,locator:anchor.locator,contextPath:anchor.contextPath,rootIdentity:baselineDirectoryIdentity(opts.sourceRoot),extractor:original.document.extractor,observation:'source_history_not_ledger_posting',entryLocators:Object.fromEntries(Object.entries(captures).map(([key,c])=>[key,c.locator]))};
  out.push(fact(scope,'business_reference',reference,source,{id:mapping.id+'_reference'}));
  out.push(fact(scope,'historical_posting',{period,date,dateGranularity:date?'day':'month',status:'observed_history',kind:'source_observation',entries:[{role,debit,credit}]},source,{id:mapping.id}));
 }
 return out;
}
const adaptationFields=['period','date','businessReference','code','accountName','debit','credit'];
function adaptationContext(locator){
 if(locator.row!==undefined)return digest(['row',locator.sheet??null,locator.sheetIndex??0,locator.row]);
 if(locator.jsonPointer!==undefined)return digest(['json',locator.jsonPointer.slice(0,locator.jsonPointer.lastIndexOf('/'))]);
 return digest(['line',locator.page,locator.line]);
}
function normalizedAdaptationValue(key,value){
 const field={period:'period_start',date:'invoice_date',businessReference:'business_reference',debit:'amount_net',credit:'amount_net'}[key];
 return field?normalizeBaselineValue(field,value):typeof value==='string'||typeof value==='number'?String(value).normalize('NFKC').replace(/\s/g,''):undefined;
}
function adaptedHistoricalObservations(adaptation,files,scope,accountSet,opts,diagnostics){
 const out=[],observations=new Map();
 for(const row of adaptation?.rows??[]){
  const original=files.find(f=>f.path===adaptation.sources.find(s=>s.index===row.sourceIndex)?.path),originalId=original?.id,originalRef=adaptation.sources.find(s=>s.index===row.sourceIndex)?.originalRef;
  const observationRef='ao:'+digest([original?.sha256,row.businessReference.locator]);
  const reject=(code,recoverable=true)=>diagnostics.push({code,stage:'adaptation',recoverable,originalId,originalRef,observationRef});
  if(!original){reject('adaptation_source_unavailable');continue;}
  if((original.document.diagnostics??[]).some(d=>/(?:external_link|active_content|macro|encrypted|source_forbidden|scope_conflict)/.test(d.code??''))){reject('adaptation_reading_restricted',false);continue;}
  const captures=Object.fromEntries(adaptationFields.filter(k=>row[k]).map(k=>[k,row[k]]));
  captures.ownerName=row.owner.name;if(row.owner.taxId)captures.ownerTaxId=row.owner.taxId;
  const context=adaptationContext(row.businessReference.locator);
  if(Object.values(captures).some(c=>adaptationContext(c.locator)!==context)){reject('adaptation_context_conflict');continue;}
  const identity=matchMaterialParty({role:'enterprise',name:row.owner.name.value,taxId:row.owner.taxId?.value},accountSet);
  if(!identity.matched||identity.conflict){reject('adaptation_owner_unverified');continue;}
  const period=normalizedAdaptationValue('period',row.period.value),date=row.date?normalizedAdaptationValue('date',row.date.value):null,reference=normalizedAdaptationValue('businessReference',row.businessReference.value),debit=normalizedAdaptationValue('debit',row.debit.value),credit=normalizedAdaptationValue('credit',row.credit.value);
  if(!period||period>=scope.period||row.date&&(!date||date.slice(0,7)!==period)||!reference||debit===undefined||credit===undefined||debit>0&&credit>0){reject('adaptation_row_invalid');continue;}
  let verified=0,mismatch=false,formula=false,identityConflict=false,locatorUnverified=false;
  // 能由原读取器实读的位置必须相符；不支持的位置仍是脚本观察，绝不标成原件直接核验。
  for(const [key,captured]of Object.entries(captures))try{
   const actual=readMaterialValue(original.document,captured.locator);
   if(['formula_unverified','cell_error'].includes(actual.valueState)){formula=true;break;}
   const parties=materialPartyContext(actual.contexts,accountSet);
   if(parties.conflict||parties.hasIdentity&&!parties.matched){identityConflict=true;break;}
   try{ownerStatus(actual.contexts,scope,accountSet);}catch(error){if(error.code==='finance_baseline_source_scope_conflict'){identityConflict=true;break;}throw error;}
   const observed=normalizedAdaptationValue(key,actual.value),claimed=normalizedAdaptationValue(key,captured.value);
   if(observed!==undefined){if(observed!==claimed){mismatch=true;break;}verified++;}
   else if(actual.value!==captured.value){mismatch=true;break;}
  }catch{if(original.document.readState==='read'){locatorUnverified=true;break;}/* 真正读取障碍仍保留脚本观察。 */}
  if(locatorUnverified){reject('adaptation_locator_unverified');continue;}
  if(formula){reject('adaptation_formula_unverified');continue;}
  if(identityConflict){reject('adaptation_owner_unverified',false);continue;}
  if(mismatch){reject('adaptation_value_mismatch');continue;}
  const role=historicalRole(accountSet,captures);
  if(role==='unknown')reject('historical_account_unmapped');
  const physicalKey=digest([original.sha256,context]),value={period,date,dateGranularity:date?'day':'month',status:'observed_history',kind:'script_observation',entries:[{role,debit,credit}]};
  if(observations.has(physicalKey)){if(digest(observations.get(physicalKey))!==digest({reference,value}))fail('finance_baseline_adaptation_observation_conflict');reject('adaptation_duplicate_observation');continue;}
  observations.set(physicalKey,{reference,value});
  const source={kind:'file',path:original.path,sha256:original.sha256,bytes:original.bytes,originalId:original.id,originalRef,locator:row.businessReference.locator,contextPath:'adapted:'+context,rootIdentity:baselineDirectoryIdentity(opts.sourceRoot),observation:'recorded_script_history_not_native_or_ledger_posting',entryLocators:Object.fromEntries(Object.entries(captures).map(([key,c])=>[key,c.locator])),adaptation:{...adaptation.provenance,rowId:row.id,physicalKey,sourceIndex:row.sourceIndex,nativeValueChecks:{matched:verified,total:Object.keys(captures).length}},identity:{role:'enterprise',basis:identity.basis,taxIdAvailability:identity.taxIdAvailability,authority:'script_observation_not_native_verification'}};
  const observed=(field,value,id)=>({...fact(scope,field,value,source,{id}),verification:'local_execution_observation',semanticAuthority:'script_history_observation_not_human_approval'});
  out.push(observed('business_reference',reference,row.id+'_reference'));
  out.push(observed('historical_posting',value,row.id));
 }
 return out;
}
function documentBusinessContexts(facts,originals,diagnostics,scope){
 const contexts=new Map();
 for(const original of originals){
  const keyValue=original.document.tables.length>0&&original.document.tables.every(t=>t.rows.every(r=>r.cells.length<=2));
  if(!original.document.blocks.length&&!keyValue)continue;
  const references=facts.filter(f=>f.source.path===original.path&&f.field==='business_reference'),values=new Set(references.map(f=>f.value));
  // 原件中可识别的其他业务号也参与歧义判断，不能只选一个锚点来隐藏同页第二份业务。
  for(const table of original.document.tables)for(const row of table.rows)if(row.cells.length===2&&suggest(row.cells[0])==='business_reference'){const value=normalizeBaselineValue('business_reference',row.cells[1]);if(value)values.add(value);}
  for(const block of original.document.blocks){const pair=/^\s*([^:：]+)[:：]\s*(.+?)\s*$/.exec(block.text);if(pair&&suggest(pair[1].trim())==='business_reference'){const value=normalizeBaselineValue('business_reference',pair[2]);if(value)values.add(value);}}
  if(values.size!==1){if(values.size>1)diagnostics.push({code:'ambiguous_business_context',originalId:original.id});continue;}
  contexts.set(original.path,{contextPath:'document:'+digest([...values][0]),relation:{kind:'single_source_business_reference',anchorLocators:references.map(f=>f.source.locator)}});
 }
 return facts.map(f=>{
  const context=contexts.get(f.source.path);if(!context||f.source.kind!=='file')return f;
  const source={...f.source,contextPath:context.contextPath,businessContext:context.relation};
  return {...f,source,group:digest([f.source.path,context.contextPath]),factRef:'bf:'+digest({owner:ownerTuple(scope),field:f.field,value:f.value,source})};
 });
}
function linkObservedHistory(facts,scope){
 const references=facts.filter(f=>f.field==='business_reference'&&f.source.kind==='file');
 return facts.map(posting=>{
  if(posting.field!=='historical_posting'||posting.value.status!=='observed_history')return posting;
  const own=references.find(r=>r.source.path===posting.source.path&&r.source.contextPath===posting.source.contextPath);if(!own)return posting;
  const linked=references.filter(r=>r.value===own.value),source={...posting.source,relations:linked.map(r=>({businessRef:r.factRef,entryIndices:[0]}))};
  return {...posting,source,linkedBusinessRefs:linked.map(r=>r.factRef),factRef:'bf:'+digest({owner:ownerTuple(scope),field:posting.field,value:posting.value,source})};
 });
}
function adaptationBusinessDiagnostics(facts){
 return facts.filter(posting=>posting.field==='historical_posting'&&posting.source.adaptation&&!facts.some(f=>f.field==='business_reference'&&f.source.kind==='file'&&!f.source.adaptation&&f.source.sha256!==posting.source.sha256&&posting.linkedBusinessRefs?.includes(f.factRef))).map(posting=>({code:'adaptation_business_unverified',stage:'adaptation',recoverable:true,originalId:posting.source.originalId,originalRef:posting.source.originalRef,observationRef:'ao:'+posting.source.adaptation.physicalKey}));
}
function knownSelectors(original){
 const out=[],diagnostics=[];let truncated=false;const add=(field,locator)=>{if(out.length>=400){truncated=true;return;}out.push({id:'auto_'+digest([original.id,field,locator]).slice(0,24),field,originalId:original.id,locator});};
 if(original.format==='json')for(const f of original.structure.fields)for(const field of f.suggestedFields??[])add(field,f.locator);
 if(original.format==='csv')for(let row=2;row<=original.rows.length;row++)for(const c of original.structure.columns)for(const field of c.suggestedFields??[])add(field,{row,column:c.column});
 if(['xls','xlsx'].includes(original.format))for(const sheet of original.structure.sheets){const headers=[...new Set(sheet.headers.map(h=>h.row))];if(headers.length!==1){diagnostics.push({code:'ambiguous_header',originalId:original.id});continue;}for(const row of original.sheets[sheet.sheetIndex].rows.filter(r=>r.rowNumber>headers[0]))for(const header of sheet.headers)for(const field of header.suggestedFields??[])add(field,{sheetIndex:sheet.sheetIndex,row:row.rowNumber,column:header.column,headerRows:[headers[0]]});}
 if(truncated)diagnostics.push({code:'known_field_limit',originalId:original.id});return {selectors:out,diagnostics,truncated};
}
function knownFacts(original,scope,accountSet,opts){
 const generated=knownSelectors(original),groups=new Map(),diagnostics=[...generated.diagnostics],gaps=[];
 for(const s of generated.selectors){
  let raw,captured;
  try{raw=selectRaw(original,s.locator,opts);captured=select(original,s,scope,accountSet,opts);}
  catch(error){
   if(['xlsx_formula_unsupported','finance_baseline_cell_error'].includes(error.code)){diagnostics.push({code:error.code==='xlsx_formula_unsupported'?'formula_unverified':'cell_error',originalId:original.id,field:s.field});continue;}
   if(error.code==='finance_baseline_source_scope_conflict'){raw??={value:null,contextPath:'scope_conflict',contexts:[]};captured={gap:'scope_conflict'};}else throw error;
  }
  const key=raw.contextPath+'\0'+s.field;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({s,raw,...captured});}

 const chosen=[];
 for(const candidates of groups.values()){
  const field=candidates[0].s.field,usable=candidates.filter(c=>c.value),eligible=usable.filter(c=>{
   if(field!=='tax_amount'&&field!=='revenue')return true;
   const dimensions=new Map();for(const context of c.raw.contexts){if(!context||typeof context!=='object'||Array.isArray(context))continue;for(const [key,value]of Object.entries(context)){const semantic=suggest(key);if(!['tax_measure','tax_stage','accumulation'].includes(semantic))continue;const normalized=normalizeBaselineValue(semantic,value);if(normalized!==undefined){if(!dimensions.has(semantic))dimensions.set(semantic,new Set());dimensions.get(semantic).add(normalized);}}}
   return Object.entries(c.value.source.semantics??{}).every(([key,value])=>dimensions.get(key)?.size===1&&dimensions.get(key).has(value));
  });
  const values=new Set(eligible.map(c=>digest(c.value.value))),originalId=original.id;
  const notProvided=c=>c.raw.value===null||typeof c.raw.value==='string'&&c.raw.value.trim()==='';
  if(values.size===1){chosen.push(...eligible.map(c=>c.value));for(const c of candidates.filter(c=>!eligible.includes(c)))diagnostics.push({code:notProvided(c)?'value_not_provided':c.gap?'unsupported_alternative':'outside_selected_tax_basis',originalId,field});}
  else if(values.size>1){diagnostics.push({code:'ambiguous_field',originalId,field});gaps.push(field==='tax_amount'?'tax_basis_incomplete':'historical_conflict');}
  else if(candidates.every(notProvided)){diagnostics.push({code:'value_not_provided',originalId,field});if(['tax_type','tax_measure','tax_stage','period_basis','accumulation','period_start','period_end','tax_amount','sales_ex_vat','revenue'].includes(field))gaps.push('tax_basis_incomplete');}
  else {diagnostics.push({code:usable.length?'outside_selected_tax_basis':'unsupported_field',originalId,field});if(!usable.length)gaps.push(candidates.some(c=>c.gap==='scope_conflict')?'scope_conflict':candidates[0].gap??'unsupported_material');}
 }
 if(generated.truncated)gaps.push('unsupported_material');return {facts:chosen,diagnostics,gaps:[...new Set(gaps)],availableCount:generated.selectors.length};
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
export function buildBaselineTaxBurden(facts){
 const rows=[],gaps=[];for(const [group,fs]of groupBaselineMaterialFacts(facts)){
  if(!fs.some(f=>f.field==='tax_type')||!fs.some(f=>f.field==='tax_amount'))continue;const fields=new Map();let duplicate=false;for(const f of baselineScalarMaterialFacts(fs)){if(fields.has(f.field)&&fields.get(f.field).value!==f.value)duplicate=true;fields.set(f.field,f);}
  const needed=['tax_type','tax_measure','tax_stage','period_basis','accumulation','period_start','period_end','tax_amount'],missing=needed.filter(k=>!fields.has(k));
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
const ownerTuple=scope=>[scope.databaseInstanceId,scope.enterpriseKey,scope.accountSetId];
export function captureBaselineMaterials(db,scope,args,opts){
 args=resolveOriginalReferences(args,opts);
 if(args.extractKnownFields&&(args.selections??[]).length)fail('finance_baseline_input_invalid');
 const read=ledger(db,scope,args),cache=new Map(),files=[],facts=[...read.facts],gaps=[],coverage=[],diagnostics=[];let totalBytes=0;
 const originals=[...(args.originals??[])];
 for(const source of opts.adaptation?.sources??[])if(!originals.some(o=>resolve(o.path)===resolve(source.path)))originals.push({id:'adapted_'+source.index,path:source.path,originalRef:source.originalRef,sha256:source.sha256});
 for(const original of originals){
  let loaded;
  try{loaded=loadOriginal(original,scope,read.accountSet,opts,cache);}
  catch(error){
   // 只恢复读取器故障；路径越界、原件变化、身份和输入错误仍沿原边界拒绝。
   if(!/^(?:material_document_|xlsx_|ocr_)/.test(error.code??'')||/(?:source_(?:changed|forbidden)|formula)/.test(error.code))throw error;
   const bytes=baselineBytes(original.path,opts.sourceRoot),diagnostic=materialReadFailure(error,original,opts),document={readState:'unsupported',status:'unsupported',tables:[],blocks:[],diagnostics:[diagnostic]};
   loaded={...original,path:resolve(original.path),sha256:sha(bytes),bytes:bytes.length,format:extname(original.path).slice(1).toLowerCase(),owner:false,rows:[],sheets:[],locations:new Map(),document,structure:{readState:'unsupported',fields:[],columns:[],sheets:[],readDiagnostics:[diagnostic]}};cache.set(original.id,loaded);
  }
  totalBytes+=loaded.bytes;if(totalBytes>20*1024*1024)fail('finance_baseline_material_limit');files.push(loaded);
  if(loaded.document.readState!=='read')for(const error of loaded.document.diagnostics??[])diagnostics.push(materialReadFailure(error,original,opts));
 }
 facts.push(...historicalObservations(cache,args.historicalRows,scope,read.accountSet,opts,diagnostics));
 facts.push(...adaptedHistoricalObservations(opts.adaptation,files,scope,read.accountSet,opts,diagnostics));
 const ids=new Set();for(const [selectionIndex,s]of (args.selections??[]).entries()){if(ids.has(s.id))fail('finance_baseline_selection_duplicate');ids.add(s.id);const original=cache.get(s.originalId);if(!original)fail('finance_baseline_original_missing');if(['unsupported','needs_runtime'].includes(original.document.readState))continue;const captured=select(original,s,scope,read.accountSet,opts,selectionIndex);if(captured.gap)gaps.push(captured.gap);else facts.push(captured.value);}
 for(const original of files){const known=knownFacts(original,scope,read.accountSet,opts);diagnostics.push(...known.diagnostics);if(args.extractKnownFields){facts.push(...known.facts);gaps.push(...known.gaps);}
  const readLocations=new Set(facts.filter(f=>f.source.kind==='file'&&f.source.path===original.path).map(f=>digest([f.field,f.source.locator]))),unselected=known.facts.filter(f=>!readLocations.has(digest([f.field,f.source.locator])));
  coverage.push({path:original.path,originalId:original.id,availableCount:known.availableCount,readCount:facts.filter(f=>f.source.kind==='file'&&f.source.path===original.path).length,knownLocations:known.facts.map(f=>({field:f.field,locationDigest:digest([f.field,f.source.locator])})),unselectedLocationCount:unselected.length,knownFieldsNotSelected:[...new Set(unselected.map(f=>f.field))]});}
 for(const original of files)if(sha(baselineBytes(original.path,opts.sourceRoot))!==original.sha256)fail('finance_baseline_source_changed');
 const linkedFacts=linkHistory(db,scope,linkObservedHistory(documentBusinessContexts(facts,files,diagnostics,scope),scope),opts),taxBurden=buildBaselineTaxBurden(linkedFacts);gaps.push(...taxBurden.gaps);
 diagnostics.push(...adaptationBusinessDiagnostics(linkedFacts));
 const snapshot={scope,facts:linkedFacts,files:files.map(f=>({id:f.id,path:f.path,sha256:f.sha256,bytes:f.bytes,format:f.format,owner:f.owner,readState:f.document.readState,extractor:f.document.extractor})),pagination:read.pagination,taxBurden,gaps:[...new Set(gaps)]};
 return {...snapshot,snapshotDigest:digest(snapshot),coverage,diagnostics,structures:files.map(f=>({path:f.path,originalId:f.id,sha256:f.sha256,bytes:f.bytes,format:f.format,ownerStatus:f.owner?'verified':'unverified',...f.structure}))};
}
// 只合并显式读取的快照；caller别名不作业务身份，凭证关系仍保留真实分行和原生记录版本。
function sameHistoricalObservationValue(left,right){
 return left.period===right.period&&left.status===right.status&&(!left.date||!right.date||left.date===right.date)&&digest(left.entries)===digest(right.entries);
}
export function mergeBaselineMaterialSnapshots(parts){
 if(!parts.length||parts.length>12)fail('finance_baseline_material_merge_limit');const scope=parts[0].scope;
 if(parts.some(p=>digest(p.scope)!==digest(scope)))fail('finance_baseline_scope_conflict');
 const aliases=new Map(),facts=[],physical=new Map(),vouchers=new Map(),files=new Map();
 const adaptedPositions=new Set(parts.flatMap(p=>p.facts.filter(f=>f.source.adaptation).map(f=>f.source.adaptation.physicalKey)));
 for(const p of parts){for(const file of p.files){if(files.has(file.path)&&files.get(file.path).sha256!==file.sha256)fail('finance_baseline_material_changed');files.set(file.path,files.get(file.path)??file);}
  for(const f of p.facts){if(f.source.kind==='ledger_voucher'){const key=digest([f.source.voucherId,f.source.sha256]);if(!vouchers.has(key))vouchers.set(key,[]);vouchers.get(key).push(f);continue;}
   const {originalId,...source}=f.source,nativeHistory=source.kind==='file'&&source.observation==='source_history_not_ledger_posting'&&['business_reference','historical_posting'].includes(f.field);
   const nativePosition=nativeHistory?digest([source.sha256,adaptationContext(source.locator)]):null,observation=source.adaptation?.physicalKey??(adaptedPositions.has(nativePosition)?nativePosition:null),key=observation?digest({field:f.field,physicalObservation:observation}):digest({field:f.field,value:f.value,source});let canonical=physical.get(key);
   // 同物理行的业务号须一致；历史分录比较实际已知值，不把来源性质或缺日当成业务冲突。
   if(canonical&&observation&&!(f.field==='historical_posting'?sameHistoricalObservationValue(canonical.value,f.value):digest(canonical.value)===digest(f.value)))fail('finance_baseline_adaptation_observation_conflict');
   // 原生事实优先；先前脚本引用保留别名，后续仍由既有历史关联重连。
   if(canonical?.source.adaptation&&nativeHistory){const previous=canonical;canonical=f;physical.set(key,f);facts[facts.indexOf(previous)]=f;aliases.set(previous.factRef,f.factRef);}
   if(!canonical){canonical=f;physical.set(key,f);facts.push(f);}aliases.set(f.factRef,canonical.factRef);
  }
 }
 for(const values of vouchers.values()){const first=values[0],relations=[...new Map(values.flatMap(f=>f.source.relations??[]).map(r=>({...r,businessRef:aliases.get(r.businessRef)??r.businessRef})).map(r=>[digest(r),r])).values()],source={...first.source};if(relations.length)source.relations=relations;else delete source.relations;
  const merged={...first,source,...(relations.length?{linkedBusinessRefs:[...new Set(relations.map(r=>r.businessRef))]}:{})};merged.factRef='bf:'+digest({owner:ownerTuple(scope),field:merged.field,value:merged.value,source});for(const f of values)aliases.set(f.factRef,merged.factRef);facts.push(merged);
 }
 // 原件历史和独立业务原件可以分别适配后显式合并；按真实业务号重连，旧事实引用沿别名接续。
 const linked=linkObservedHistory(facts,scope);
 for(let i=0;i<facts.length;i++)if(facts[i].factRef!==linked[i].factRef)aliases.set(facts[i].factRef,linked[i].factRef);
 facts.splice(0,facts.length,...linked);
 for(const [alias,ref]of aliases)if(aliases.has(ref))aliases.set(alias,aliases.get(ref));
 for(const part of parts)for(const [alias,ref]of Object.entries(part.factAliases??{}))if(!aliases.has(alias))aliases.set(alias,aliases.get(ref)??ref);
 if(files.size>128||facts.length>1000||[...files.values()].reduce((n,f)=>n+f.bytes,0)>20*1024*1024)fail('finance_baseline_material_merge_limit');
 const structures=[...new Map(parts.flatMap(p=>p.structures).map(s=>[s.path,s])).values()],coverage=structures.map(s=>{const records=parts.flatMap(p=>p.coverage??[]).filter(c=>c.path===s.path),knownLocations=[...new Map(records.flatMap(c=>c.knownLocations??[]).map(v=>[v.locationDigest,v])).values()],readFacts=facts.filter(f=>f.source.kind==='file'&&f.source.path===s.path),read=new Set(readFacts.map(f=>digest([f.field,f.source.locator]))),unselected=knownLocations.filter(f=>!read.has(f.locationDigest));return {path:s.path,originalId:s.originalId,availableCount:knownLocations.length,readCount:readFacts.length,knownLocations,unselectedLocationCount:unselected.length,knownFieldsNotSelected:[...new Set(unselected.map(f=>f.field))]};});
 const taxBurden=buildBaselineTaxBurden(facts),snapshot={scope,facts,files:[...files.values()],pagination:parts[0].pagination,taxBurden,gaps:[...new Set([...parts.flatMap(p=>p.gaps),...taxBurden.gaps])]};
 return {...snapshot,snapshotDigest:digest(snapshot),structures,coverage,diagnostics:[...parts.flatMap(p=>p.diagnostics??[]).filter(d=>d.code!=='adaptation_business_unverified'),...adaptationBusinessDiagnostics(facts)],factAliases:Object.fromEntries(aliases)};
}
