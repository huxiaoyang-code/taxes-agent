// 同一进程签发底稿的固定分页投影；不提供任意本机文件读取或自动过账。
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {resolveDirectFinanceTarget} from './direct-finance-target.mjs';
import {PROJECTION_NUMBER_LIMIT} from './finance-output-policy.mjs';
import {annotateFinanceCall,currentFinanceCall} from './finance-call-chain.mjs';
const issued=new Map(),sha=b=>createHash('sha256').update(b).digest('hex');
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const money=value=>{const n=Number(value);return /^-?\d+(\.\d{1,2})?$/.test(String(value))&&Number.isFinite(n)&&Math.abs(n)<=PROJECTION_NUMBER_LIMIT?n:null;};
const quantity=value=>/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))?Number(value):null;
function fileBytes(path){
 if(typeof path!=='string'||!isAbsolute(path))fail('finance_details_source_invalid','底稿与来源必须是明确的本机文件。');
 for(let p=resolve(path);;p=dirname(p)){if(lstatSync(p).isSymbolicLink())fail('finance_details_source_invalid','底稿或来源路径不允许链接跳转。');if(dirname(p)===p)break;}
 const s=lstatSync(path);if(!s.isFile()||s.nlink!==1||s.size>32*1024*1024||realpathSync(path).toLowerCase()!==resolve(path).toLowerCase())fail('finance_details_source_invalid','原底稿或来源文件状态异常。');return readFileSync(path);
}
function digestFile(path){return sha(fileBytes(path));}
const sameScope=(a,b)=>a&&b&&['accountSetId','databaseInstanceId','enterpriseKey','period','currency'].every(k=>a[k]===b[k]);
function fixedRecord(dir,name,descriptor){
 const bytes=fileBytes(join(dir,name));
 if(descriptor&&(descriptor.file!==name||descriptor.sha256!==sha(bytes)||descriptor.bytes!==bytes.length))fail('finance_details_record_changed','计算调用记录或摘要已改变。');
 return {bytes,value:JSON.parse(bytes)};
}
// 只为正式凭证金额核验复用已保存调用。根来自服务配置，引用只能选择固定 workpaper.json；不接收调用方路径或快照。
function persistedWorkpaper(reference,{dbPath}={}){
 const match=/^finance-artifact:(\d{8}T\d{9}Z_[a-f0-9-]{36})\/workpaper\.json$/.exec(reference??'');
 if(!match)fail('finance_details_reference_untrusted','底稿引用不是已记录的原生计算产物。');
 const configured=process.env.FINANCE_AUDIT_DIR;
 if(typeof configured!=='string'||!isAbsolute(configured))fail('finance_details_audit_root_required','后端须配置与计算进程一致的本机审计目录。');
 const root=resolve(configured),callId=match[1],dir=join(root,callId),path=join(root,'artifacts',callId,'workpaper.json');
 const {bytes:beginBytes,value:begin}=fixedRecord(dir,'begin.json'),{value:end}=fixedRecord(dir,'end.json');
 if(begin.version!=='finance-call-record/1'||end.version!==begin.version||begin.callId!==callId||end.callId!==callId||end.beginSha256!==sha(beginBytes)||
   !['finance_workpaper','finance_tax_calculate','finance_annual_workpaper'].includes(begin.tool)||end.status!=='returned'||end.executionCompleted!==true||end.scopeState!=='observed'||!begin.input||!end.output||!Number.isFinite(Date.parse(begin.startedAt))||!Number.isFinite(Date.parse(end.finishedAt)))fail('finance_details_reference_untrusted','计算调用尚未成功完成或身份不能核验。');
 const {value:input}=fixedRecord(dir,'input.json',begin.input),{value:output}=fixedRecord(dir,'result.json',end.output),descriptor=output.evidence?.result;
 if(output.resultOrigin!=='native_engine'||output.evidence?.callRef!==callId||descriptor?.artifactRef!==reference||output.vouchers?.detailRef!==reference||end.metadata?.artifactRefs?.filter(r=>r===reference).length!==1)fail('finance_details_reference_untrusted','产物引用未被成功计算调用唯一绑定。');
 const bytes=fileBytes(path);if(bytes.length!==descriptor.bytes||sha(bytes)!==descriptor.sha256)fail('finance_details_artifact_changed','原生底稿已发生改变，不能作为未改变的计算结果使用。');
 const workpaper=JSON.parse(bytes),configuredDb=end.metadata?.configuredTarget?.databasePath??begin.configuredTarget?.databasePath;
 if(typeof configuredDb!=='string'||!isAbsolute(configuredDb)||!sameScope(workpaper.scope,end.scope))fail('finance_details_scope_conflict','记录与原生底稿的账库、企业、期间不能核对。');
 if(end.ruleVersion!==workpaper.ruleVersion||output.rules?.ruleVersion!==workpaper.ruleVersion||end.codeDigest!==output.rules?.codeDigest||workpaper.codeDigest&&end.codeDigest!==workpaper.codeDigest)fail('finance_details_record_changed','计算采用的规则与代码版本记录不一致。');
 const declared=input.target??input.scope??input;
 if(declared.accountSetId!==undefined&&declared.accountSetId!==end.scope.accountSetId||declared.period!==undefined&&declared.period!==end.scope.period)fail('finance_details_scope_conflict','输入声明与实际计算范围冲突。');
 if(!Array.isArray(begin.sources)||!Array.isArray(end.loadedSources)||!Array.isArray(end.sourceChanges)||end.sourceChanges.length)fail('finance_details_source_changed','计算期间的来源版本发生变化或记录不完整。');
 const sources=[...begin.sources,...end.loadedSources];
 if(!sources.length||sources.some(s=>s.state!=='observed'||typeof s.path!=='string'||!/^[a-f0-9]{64}$/.test(s.sha256??'')))fail('finance_details_source_invalid','计算来源记录缺少可核验的文件摘要。');
 for(const s of sources)if(digestFile(s.path)!==s.sha256)fail('finance_details_source_changed','计算时采用的来源已改变，请重新计算。');
 let inputEvidence=null;const evidenceDescriptor=end.metadata?.businessEvidence;
 if(evidenceDescriptor)inputEvidence=fixedRecord(dir,'business-evidence.json',evidenceDescriptor).value;
 const records=Array.isArray(input.records)?input.records:[],a=workpaper.accounting??{},annual=begin.tool==='finance_annual_workpaper';
 const vouchers=(annual?[...(a.historicalVouchers??[]),...(a.vouchers??[])]:a.vouchers??[]).map((v,i)=>({voucherIndex:i,sourceRecordIndex:records.findIndex(r=>r.id===v.factId)<0?null:records.findIndex(r=>r.id===v.factId),period:/^\d{4}-\d{2}$/.test(v.period)?v.period:null,date:/^\d{4}-\d{2}-\d{2}$/.test(v.date)?v.date:null,entries:(v.entries??[]).map(e=>({code:/^\d{4,12}$/.test(e.code??e.accountCode)?(e.code??e.accountCode):null,debit:money(e.debit),credit:money(e.credit)}))}));
 const known={scope:workpaper.scope,dbPath:configuredDb,createdAt:Date.parse(begin.startedAt),path,sha256:descriptor.sha256,sources,sections:{vouchers},inputEvidence,callId,rules:workpaper.ruleSelection??{},ruleSources:a.sources??[]};
 // 实际账库由领域私有上下文传入；MCP 同进程读取仍使用其既有固定环境配置。
 validateKnown(known,{accountSetId:end.scope.accountSetId,period:end.scope.period},dbPath);
 return known;
}
function validateKnown(known,target,dbPath){
 if(Date.now()-known.createdAt>3600000||known.createdAt>Date.now()+60000)fail('finance_details_reference_expired','底稿引用已过期，请重新计算后读取。');
 const binding=resolveDirectFinanceTarget(target,dbPath);
 if(!known.dbPath||resolve(known.dbPath).toLowerCase()!==resolve(binding.dbPath).toLowerCase()||!sameScope(known.scope,binding.scope))fail('finance_details_scope_conflict','底稿与本次目标账套、期间或账库不一致。');
 if(digestFile(known.path)!==known.sha256)fail('finance_details_artifact_changed','原生底稿已发生改变，不能作为未改变的计算结果使用。');
 for(const source of known.sources)if(source.sha256&&digestFile(source.path)!==source.sha256)fail('finance_details_source_changed','计算时采用的来源已改变，请重新计算。');
 return binding;
}
export function registerWorkpaperDetails({workpaper,artifact,descriptor,records,annual=false}){
 const recordIndex=id=>{const index=records.findIndex(r=>r.id===id);return index<0?null:index;},items=[...new Set(records.flatMap(r=>[r.itemId,...(r.lines??[]).map(x=>x.itemId)]).filter(Boolean))],itemIndex=id=>items.indexOf(id),a=workpaper.accounting??{};
 const vouchers=(annual?[...(a.historicalVouchers??[]),...(a.vouchers??[])]:a.vouchers??[]).map((v,i)=>({voucherIndex:i,sourceRecordIndex:recordIndex(v.factId),period:/^\d{4}-\d{2}$/.test(v.period)?v.period:null,date:/^\d{4}-\d{2}-\d{2}$/.test(v.date)?v.date:null,entries:(v.entries??[]).map(e=>({code:/^\d{4,12}$/.test(e.code??e.accountCode)?(e.code??e.accountCode):null,debit:money(e.debit),credit:money(e.credit)}))}));
 const inventory=(a.inventory??[]).map((v,i)=>({inventoryIndex:i,itemIndex:itemIndex(v.itemId),quantityMillionths:quantity(v.quantityUnits),cost:money(v.cost),layers:(v.layers??[]).map(l=>({quantityMillionths:quantity(l.quantityUnits),cost:money(l.cost)}))}));
 const returnCostTrace=(a.returnCostTrace??[]).map((v,i)=>({traceIndex:i,sourceRecordIndex:recordIndex(v.factId),originalSaleRecordIndex:recordIndex(v.originalSaleId),originalLine:Number.isSafeInteger(v.originalLine)?v.originalLine:null,method:v.mode==='identified_purchase_lot'?'原件指定采购批次':'原销售行比例恢复',quantityMillionths:quantity(v.quantityUnits),cost:money(v.cost),allocations:(v.allocations??[]).map(l=>({sourceRecordIndex:recordIndex(l.originalPurchaseId??l.sourceFactId),quantityMillionths:quantity(l.quantityUnits??l.quantity),cost:money(l.cost)}))}));
 const call=currentFinanceCall(),dbPath=call?.metadata?.configuredTarget?.databasePath??process.env.FINANCE_DATABASE_PATH;
 let inputEvidence=null;const evidenceDescriptor=call?.metadata.businessEvidence;
 if(evidenceDescriptor?.file==='business-evidence.json'){const bytes=readFileSync(join(call.recordPath,evidenceDescriptor.file));if(sha(bytes)===evidenceDescriptor.sha256)inputEvidence=JSON.parse(bytes);}
 issued.set(descriptor.artifactRef,{scope:structuredClone(workpaper.scope),dbPath,createdAt:Date.now(),path:join(artifact.dir,'workpaper.json'),sha256:descriptor.sha256,sources:structuredClone(call?.metadata.sources??[]),sections:{vouchers,inventory,return_costs:returnCostTrace},sourceCount:records.length,inputEvidence,callId:call?.callId??null,rules:structuredClone(workpaper.ruleSelection??{}),ruleSources:structuredClone(a.sources??[])});while(issued.size>32)issued.delete(issued.keys().next().value);
}
export function workpaperDetails(args,{annotate=true}={}){
 const known=issued.get(args.artifactRef);if(!known)fail('finance_details_reference_untrusted','底稿引用不是本次服务进程签发的有效引用。');if(Date.now()-known.createdAt>3600000){issued.delete(args.artifactRef);fail('finance_details_reference_expired','底稿引用已过期，请重新计算后读取。');}
 const binding=resolveDirectFinanceTarget(args.target);if(!known.dbPath||resolve(known.dbPath).toLowerCase()!==resolve(binding.dbPath).toLowerCase()||['accountSetId','databaseInstanceId','enterpriseKey','period','currency'].some(k=>known.scope[k]!==binding.scope[k]))fail('finance_details_scope_conflict','底稿与本次目标账套、期间或账库不一致。');
 if(digestFile(known.path)!==known.sha256)fail('finance_details_artifact_changed','原生底稿已发生改变，不能作为未改变的计算结果使用。');
 for(const source of known.sources)if(source.sha256&&digestFile(source.path)!==source.sha256)fail('finance_details_source_changed','计算时采用的来源已改变，请重新计算。');
 const section=known.sections[args.section],offset=args.offset??0,limit=args.limit??20;if(!section||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('finance_details_page_invalid','请选择有效的底稿部分和分页范围。');
 if(annotate)annotateFinanceCall({scope:binding.scope,configuredTarget:{databasePath:binding.dbPath,accountSetId:binding.scope.accountSetId},sources:known.sources,artifactRefs:[args.artifactRef]});
 return {version:'finance-workpaper-details/1',period:binding.scope.period,section:args.section,total:section.length,offset,limit,nextOffset:offset+limit<section.length?offset+limit:null,rows:structuredClone(section.slice(offset,offset+limit)),posted:false,fieldGuide:{sourceRecordIndex:'原计算调用records数组的从零开始索引；年度底稿为合并后顺序，缺少对应原业务记录时为空',itemIndex:'原计算记录按首次出现商品顺序的从零开始索引',voucherIndex:'当前底稿凭证的从零开始索引',quantityMillionths:'数量的百万分之一单位；除以一百万得到业务数量',entries:'固定科目编码、借方金额、贷方金额（元）',cost:'确定性引擎成本金额（元）'},meaning:'这是原生计算草稿，未正式入账。现有写账、审核、过账控制继续独立执行；库存层和退货轨迹不等于完整销售出库轨迹。'};
}

// 凭证金额仅引用已签发底稿的固定分录字段，沿用同一引用校验；不能传 JSON 路径读取其他数据。
export function captureWorkpaperAmount(target,reference,calculationContext={}){
 const known=issued.get(reference.artifactRef)??persistedWorkpaper(reference.artifactRef,calculationContext);
 validateKnown(known,target,calculationContext.dbPath);
 if(!Number.isSafeInteger(reference.voucherIndex)||reference.voucherIndex<0)fail('finance_details_amount_missing','指定的原生凭证计算字段不存在或不在受支持范围。');
 const voucher=known.sections.vouchers[reference.voucherIndex],entry=voucher?.entries?.[reference.entryIndex];
 if(!Number.isSafeInteger(reference.entryIndex)||reference.entryIndex<0||!['debit','credit'].includes(reference.field)||!entry||typeof entry[reference.field]!=='number')fail('finance_details_amount_missing','指定的原生凭证计算字段不存在或不在受支持范围。');
 const prefix=voucher.sourceRecordIndex===null?null:`/records/${voucher.sourceRecordIndex}/`,upstreamMappings=(known.inputEvidence?.mappings??[]).filter(m=>prefix&&m.inputPointer.startsWith(prefix));
 return {kind:'native_calculation',path:known.path,fileName:'原生凭证计算结果（非原件）',sha256:known.sha256,bytes:lstatSync(known.path).size,location:`第${reference.voucherIndex+1}份草稿，第${reference.entryIndex+1}条分录，${reference.field==='debit'?'借方':'贷方'}`,selectedValue:entry[reference.field],headers:[['草稿序号','分录行','实际科目','借方金额','贷方金额']],rows:[{rowLabel:'固定引擎计算结果',values:[reference.voucherIndex+1,reference.entryIndex+1,entry.code,entry.debit,entry.credit]}],calculation:{...reference,callId:known.callId,scope:known.scope,sourceRecordIndex:voucher.sourceRecordIndex,rules:known.rules,ruleSources:known.ruleSources,meaning:'已校验计算结果及版本；不是客户原始凭证，不代表上游业务选择已经人审。'},upstreamMappings,dependencies:structuredClone(known.sources)};
}
