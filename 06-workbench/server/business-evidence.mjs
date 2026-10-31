// 业务调用前实读原件结构与参数映射；不接受事后填写的执行记录。
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,extname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {readInvoiceXlsx} from './offline-invoice-xlsx.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {captureWorkpaperAmount} from './direct-finance-details.mjs';

const text={type:'string',minLength:1,maxLength:2000};
const sourceSchema={type:'object',additionalProperties:false,required:['path'],properties:{path:text,jsonPointer:{type:'string',pattern:'^(|/.*)$'},row:{type:'integer',minimum:1,maximum:10000},column:{anyOf:[text,{type:'integer',minimum:1,maximum:200}]},headerRows:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'integer',minimum:1,maximum:10000}},sheet:text}};
const mappedSourceSchema={oneOf:[sourceSchema,{type:'object',additionalProperties:false,required:['calculation'],properties:{calculation:{type:'object',additionalProperties:false,required:['artifactRef','voucherIndex','entryIndex','field'],properties:{artifactRef:text,voucherIndex:{type:'integer',minimum:0},entryIndex:{type:'integer',minimum:0},field:{enum:['debit','credit']}}}}}]};
export const BUSINESS_EVIDENCE_SCHEMA={type:'object',additionalProperties:false,required:['businessLabel','method','mappings'],properties:{
 businessLabel:text,method:text,rules:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,required:['title','reason'],properties:{title:text,locator:text,url:text,reason:text}}},
 cashFlowAllocations:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['item','amount','sources','reason'],properties:{item:text,amount:{anyOf:[{type:'number'},{type:'string',pattern:'^\\d+(\\.\\d{1,2})?$'}]},sources:{type:'array',minItems:1,maxItems:100,items:sourceSchema},reason:text}}},
 mappings:{type:'array',minItems:1,maxItems:400,items:{type:'object',additionalProperties:false,required:['inputPointer','parameterLabel','sources','transform'],properties:{
  inputPointer:{type:'string',pattern:'^/.*$'},parameterLabel:text,unit:text,reason:text,transform:{enum:['identity','sum','difference','product','selection']},
  sources:{type:'array',minItems:1,maxItems:100,items:mappedSourceSchema}
 }}}
}};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function readEvidencePointer(value,path){
 if(typeof path!=='string'||path!==''&&!path.startsWith('/')||/~[^01]/.test(path))fail('finance_evidence_pointer_invalid','原件或参数位置格式错误。');
 for(const token of path===''?[]:path.slice(1).split('/')){const key=token.replaceAll('~1','/').replaceAll('~0','~');if(!value||typeof value!=='object'||!Object.hasOwn(value,key))fail('finance_evidence_pointer_missing','指定的原件字段或业务参数不存在。');value=value[key];}
 if(value===undefined)fail('finance_evidence_pointer_missing','指定的业务参数没有值。');return value;
}
function securedFile(path,root,cache){
 if(typeof root!=='string'||!isAbsolute(root))fail('finance_evidence_root_required','需先配置获准的业务原件目录。');
 const base=resolve(root),full=resolve(path),part=relative(base,full);
 if(!isAbsolute(path)||!part||isAbsolute(part)||part==='..'||part.startsWith('../')||part.startsWith('..\\'))fail('finance_evidence_path_forbidden','原件必须位于获准的业务资料目录内。');
 try{for(let p=full;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())fail('finance_evidence_path_forbidden','原件路径不允许链接跳转。');if(dirname(p)===p)break;}
  const st=lstatSync(full);if(!st.isFile()||st.nlink!==1||st.size>8*1024*1024||realpathSync(full).toLowerCase()!==full.toLowerCase())fail('finance_evidence_path_forbidden','原件文件类型或大小不符合读取要求。');
  if(cache?.has(full))return {full,bytes:cache.get(full)};
  const bytes=readFileSync(full);if(cache){if(cache.size>=64||[...cache.values()].reduce((n,b)=>n+b.length,0)+bytes.length>20*1024*1024)fail('finance_evidence_source_limit','本次业务调用的原件数量或总大小超出读取范围。');cache.set(full,bytes);}return {full,bytes};
 }catch(e){if(e.code?.startsWith('finance_evidence_'))throw e;fail('finance_evidence_source_unavailable','无法读取已指定的业务原件。');}
}
export function parseEvidenceCsv(text){
 const rows=[];let row=[],cell='',quoted=false,closed=false; text=text.replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c==='"'&&!cell&&!closed){quoted=true;continue;}if(c===','||c==='\n'||c==='\r'){row.push(cell);cell='';closed=false;if(c!==','){rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}continue;}
  if(closed||c==='"')fail('finance_evidence_csv_invalid','原件表格存在不完整的引号或字段。');cell+=c;
 }
 if(quoted)fail('finance_evidence_csv_invalid','原件表格存在未闭合的引号。');if(cell||row.length||closed){row.push(cell);rows.push(row);}if(rows.length>10000||rows.some(r=>r.length>200))fail('finance_evidence_source_limit','原件表格超出本次读取范围。');return rows;
}
function columnIndex(headers,column){
 if(Number.isSafeInteger(column))return column-1;
 const indices=headers.at(-1).flatMap((v,i)=>v===column?[i]:[]);if(indices.length!==1)fail('finance_evidence_header_ambiguous','原件表头不存在或重名，请用明确列号选择。');return indices[0];
}
export function captureEvidenceSource(source,{sourceRoot=process.env.FINANCE_SOURCE_ROOT,fileCache}={}){
 const {full,bytes}=securedFile(source.path,sourceRoot,fileCache),extension=extname(full).toLowerCase();
 const parsed=fileCache?(fileCache.parsed??=new Map()):new Map();let shared=parsed.get(full);if(!shared){shared={sha256:digest(bytes)};parsed.set(full,shared);}const base={path:full,fileName:basename(full),sha256:shared.sha256,bytes:bytes.length};
 const decode=()=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{fail('finance_evidence_encoding_invalid','原件需使用有效的中文字符编码。');}};
 if(extension==='.json'){
  if(!Object.hasOwn(shared,'json')){try{shared.json=JSON.parse(decode());}catch(error){if(error.code)throw error;fail('finance_evidence_json_invalid','结构化原件内容格式不完整。');}}const value=shared.json,pointer=source.jsonPointer;
  if(pointer===undefined)fail('finance_evidence_pointer_required','读取结构化原件必须指定字段位置。');
  const selected=readEvidencePointer(value,pointer),parentPointer=pointer.includes('/')?pointer.slice(0,pointer.lastIndexOf('/')):'',parent=readEvidencePointer(value,parentPointer);
  const keys=parent&&typeof parent==='object'?Object.keys(parent):['原值'];
  return {...base,format:'json',location:pointer||'根节点',selectedValue:selected,headers:[keys],rows:[{rowLabel:parentPointer||'根节点',values:keys.map(k=>parent&&typeof parent==='object'?parent[k]:parent)}]};
 }
 if(!Number.isSafeInteger(source.row)||source.column===undefined)fail('finance_evidence_table_location_required','读取表格原件必须指定实际行与列。');
 const headerRows=source.headerRows??[1];if(headerRows.some((n,i)=>n>=source.row||i>0&&n<=headerRows[i-1]))fail('finance_evidence_header_order','表头行必须按原顺序排列，并位于选定业务行之前。');let headers,record,index;
 if(extension==='.csv'){
  const all=shared.csv??=parseEvidenceCsv(decode());headers=headerRows.map(n=>all[n-1]);record=all[source.row-1];
  if(headers.some(r=>!r)||!record||headerRows.includes(source.row))fail('finance_evidence_table_location_invalid','指定表头或业务数据行不存在。');index=columnIndex(headers,source.column);
 }else if(extension==='.xlsx'){
  if(headerRows.length!==1||!source.sheet||typeof source.column!=='string')fail('finance_evidence_xlsx_scope','工作簿读取需明确工作表、单行表头及唯一表头名称；复杂合并表头须先人工核对。');
  const table=readInvoiceXlsx(bytes,{sheet:source.sheet,headerRow:headerRows[0],columns:{net:source.column}});headers=[table.headers];record=table.rows.find(r=>r.rowNumber===source.row)?.cells;index=table.index.get('net');
 }else fail('finance_evidence_format_unsupported','目前原件结构读取支持中文表格文件、结构化资料和受支持的工作簿；其他格式不能伪称已提取。');
 if(!record||index<0||index>=record.length)fail('finance_evidence_table_location_invalid','指定的业务字段没有原始值。');
 return {...base,format:extension.slice(1),sheet:source.sheet??null,headerRows,location:`${source.sheet?source.sheet+'，':''}第${source.row}行，第${index+1}列`,column:index+1,selectedValue:record[index],headers,rows:[{rowLabel:`第${source.row}行`,values:record}]};
}
function decimal(value){
 const s=String(value);if(!/^-?\d+(\.\d{1,6})?$/.test(s))return null;const neg=s.startsWith('-'),[a,b='']=s.replace(/^-/,'').split('.');return {n:BigInt(a+b)*(neg?-1n:1n),scale:10n**BigInt(b.length)};
}
function same(a,b){const x=decimal(a),y=decimal(b);return x&&y?x.n*y.scale===y.n*x.scale:JSON.stringify(a)===JSON.stringify(b);}
const PARAMETER_LABELS={amountIncludingVat:'含税合同金额',vatAmount:'单列增值税额',separatelyStatedVat:'合同是否单列增值税',outputVat:'销项税额',certifiedInputVat:'本期可抵扣进项税额',openingCarryCredit:'期初留抵税额',inputVatTransferOut:'进项税额转出',prepaidVat:'已预缴增值税',vatBase:'附加税费的增值税计税基础',salesExcludingVat:'不含税销售额',profitTotalYtd:'年初至今累计利润总额',validPriorYearLossOffset:'有效以前年度亏损弥补额',otherPrepaymentAdjustments:'预缴其他调整额',prepaidThisYear:'本年已预缴所得税',ytdAverageEmployees:'累计平均从业人数',ytdAverageAssetsYuan:'累计平均资产总额（元）',quarterAverageEmployees:'季度平均从业人数',quarterAverageAssetsYuan:'季度平均资产总额（元）',original_cost:'资产原值',useful_life_months:'折旧或摊销月数',residual_rate:'预计净残值率',start_period:'开始计提或建账期间',acquired_period:'取得资产期间',opening_accumulated:'期初累计折旧或摊销',period:'业务所属期间',voucher_date:'凭证日期',quantity:'数量',unitPrice:'单价',priceIncludesVat:'单价是否含税',classification:'纳税地点类别',sixTaxRelief:'六税两费减免资格选择',reliefValidFrom:'资格适用开始日期',reliefValidThrough:'资格适用结束日期',restrictedOrProhibitedIndustry:'是否限制或禁止行业',cumulativeIncome:'累计工资收入',cumulativeSpecialDeductions:'累计专项扣除',cumulativeAdditionalDeductions:'累计专项附加扣除',employmentMonths:'实际任职月数',priorWithholding:'累计已预扣税额',otherRelief:'其他减免税额'};
function trustedParameter(args,pointer){
 const entry=/^\/(entries|items)\/(\d+)\/(debit|credit|code)$/.exec(pointer);
 if(entry){const item=args[entry[1]]?.[Number(entry[2])];return {label:`第${Number(entry[2])+1}条${entry[1]==='entries'?'分录':'期初余额'}${{debit:'借方金额',credit:'贷方金额',code:'科目编码'}[entry[3]]}`,accountCode:item?.code??null,origin:'fixed_tool_contract'};}
 const leaf=pointer.split('/').at(-1).replaceAll('~1','/').replaceAll('~0','~');
 return {label:PARAMETER_LABELS[leaf]??'工具字段含义尚未中文登记，需查看实际字段定义',field:pointer,origin:PARAMETER_LABELS[leaf]?'fixed_tool_contract':'unknown'};
}
export function captureBusinessEvidence(args,evidence,{sourceRoot=process.env.FINANCE_SOURCE_ROOT}={}){
 const errors=validateSchemaValue(BUSINESS_EVIDENCE_SCHEMA,evidence);if(errors.length)fail('finance_evidence_invalid','业务字段映射缺少必要信息或结构不正确。');
 const fileCache=new Map();if(evidence.mappings.reduce((n,m)=>n+m.sources.length,0)+(evidence.cashFlowAllocations??[]).reduce((n,m)=>n+m.sources.length,0)>2000)fail('finance_evidence_source_limit','本次字段映射数量过多，请按实际业务拆分。');
 const mappings=evidence.mappings.map(mapping=>{
  const sources=mapping.sources.map(source=>source.calculation?captureWorkpaperAmount(args.target??{accountSetId:args.accountSetId,period:args.period},source.calculation):captureEvidenceSource(source,{sourceRoot,fileCache})),actual=readEvidencePointer(args,mapping.inputPointer);let valueMatched=null;
  if(mapping.transform==='identity'){if(sources.length!==1)fail('finance_evidence_transform_invalid','直接取值必须唯一定位一个原始值。');valueMatched=same(actual,sources[0].selectedValue);}
  else if(mapping.transform!=='selection'){
   const values=sources.map(s=>decimal(s.selectedValue)),target=decimal(actual);if(values.some(v=>!v)||!target)fail('finance_evidence_numeric_required','计算转换必须使用明确的十进制数值。');
   let result=values[0];for(const v of values.slice(1))result=mapping.transform==='product'?{n:result.n*v.n,scale:result.scale*v.scale}:{n:result.n*v.scale+(mapping.transform==='difference'?-1n:1n)*v.n*result.scale,scale:result.scale*v.scale};valueMatched=result.n*target.scale===target.n*result.scale;
  }else if(!mapping.reason)fail('finance_evidence_selection_reason_required','业务选取参数必须说明与原件事实的关系。');
  return {...mapping,target:trustedParameter(args,mapping.inputPointer),actualValue:actual,sources,valueMatched,semanticStatus:'unreviewed',selectionMeaning:mapping.transform==='selection'?'业务选取，待核对其事实及规则依据':'原值与转换数值核对，不证明业务含义相同'};
 });
 const cashFlowAllocations=(evidence.cashFlowAllocations??[]).map(a=>{const sources=a.sources.map(s=>captureEvidenceSource(s,{sourceRoot,fileCache})),values=sources.map(s=>decimal(s.selectedValue)),target=decimal(a.amount);if(!target||target.n<=0n||values.some(v=>!v))fail('finance_evidence_cash_amount','现金流分配必须绑定正数金额原件。');let n=0n,scale=1n;for(const v of values){n=n*v.scale+v.n*scale;scale*=v.scale;}return {...a,sources,valueMatched:n*target.scale===target.n*scale};});
 const result={version:'business-evidence/1',capturedAt:new Date().toISOString(),captureStage:'before_business_execution',businessLabel:evidence.businessLabel,method:evidence.method,rules:(evidence.rules??[]).map(r=>({...r,origin:'agent_declared_not_engine_approval'})),mappings,cashFlowAllocations,valueMismatches:mappings.filter(m=>m.valueMatched===false).length+cashFlowAllocations.filter(a=>!a.valueMatched).length,semanticStatus:'unreviewed'};
 if(Buffer.byteLength(JSON.stringify(result))>16*1024*1024)fail('finance_evidence_source_limit','本次原件结构快照过大，请按业务拆分。');return result;
}

// 汇总工具已有字段绑定时自动使用同一映射；可信引擎派生引用仍由原生工具核验，不冒称原件。
export function summaryBusinessEvidence(args){
 if(!process.env.FINANCE_SOURCE_ROOT||!Array.isArray(args?.bindings)||!Array.isArray(args.originals))return undefined;
 const leaves=(value,path='')=>value!==null&&typeof value==='object'?Object.entries(value).flatMap(([k,v])=>leaves(v,path+'/'+k.replaceAll('~','~0').replaceAll('/','~1'))):[{path,value}];
 const all=leaves(args.inputs),mappings=[];
 for(const binding of args.bindings){if(!binding.originalId)continue;const original=args.originals.find(o=>o.id===binding.originalId);if(!original||!binding.locator)continue;
  for(const leaf of all.filter(l=>binding.inputPointer===''||l.path===binding.inputPointer||l.path.startsWith(binding.inputPointer+'/'))){const selected=['period_type','boolean_eligibility'].includes(binding.transform);
   mappings.push({inputPointer:'/inputs'+leaf.path,parameterLabel:'汇总工具已有原件字段绑定',transform:selected?'selection':'identity',reason:selected?'按工具合同执行期间或资格值规范化；仍须核对适用事实。':'直接采用已有字段绑定，原生工具继续校验类型、数值及来源。',sources:[{path:original.path,jsonPointer:binding.locator.jsonPointer+leaf.path.slice(binding.inputPointer.length)}]});
  }
 }
 return mappings.length?{businessLabel:'税费汇总条件试算',method:'原生确定性税法计算；自动沿用既有字段绑定，未核条件继续保留。',mappings}:undefined;
}
