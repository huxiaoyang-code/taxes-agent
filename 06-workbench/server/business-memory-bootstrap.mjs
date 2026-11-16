// 从实际账库与已经存在的本机证据生成历史目录；观察路径只读，准备路径显式写入组件。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDirectFinanceTarget } from './direct-finance-target.mjs';
import { assertRestoreOpenPath, assertRestoreWritable } from './local-restore-control.mjs';
import { persistedVoucherFingerprint, listSourceBindingsForAccountSet } from './import-storage.mjs';
import { parseMoney, formatCents } from './money.mjs';
import { getAccountingRoles } from './accounting-profiles.mjs';
import { assertBusinessMemoryScope, businessMemoryDigest, canonicalBusinessMemory, ensureBusinessMemorySchema, getBusinessMemoryMethod, inspectBusinessMemorySchema, replaceBusinessMemoryIndex, readBusinessMemoryState } from './business-memory-storage.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const period = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value ?? '');
const inside = (root,path) => { const p = relative(root,path); return p === '' || !isAbsolute(p) && p !== '..' && !p.startsWith('..\\') && !p.startsWith('../'); };
function plain(path, {directory=false} = {}) {
 if (typeof path !== 'string' || !isAbsolute(path)) fail('finance_memory_path_invalid');
 for (let p=resolve(path);;p=dirname(p)) { if (lstatSync(p).isSymbolicLink() || realpathSync(p).toLowerCase() !== resolve(p).toLowerCase()) fail('finance_memory_path_invalid'); if (dirname(p) === p) break; }
 const s=lstatSync(path); if (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) fail('finance_memory_path_invalid'); return s;
}
function bytes(path, limit=20*1024*1024) { const s=plain(path); if (s.size > limit) fail('finance_memory_record_limit'); return readFileSync(path); }
function jsonFile(path) { const b=bytes(path); return {value:JSON.parse(b),sha256:sha(b),bytes:b.length}; }
function directories(root, pattern, diagnostics) {
 try {
  plain(root,{directory:true}); const names=readdirSync(root).filter(n => pattern.test(n)).sort();
  if (names.length > 5000) fail('finance_memory_record_limit'); return names.filter(n => { try { plain(join(root,n),{directory:true}); return true; } catch { diagnostics.push('record_directory_unavailable'); return false; } });
 } catch (error) { if (error.code === 'ENOENT') return []; if (error.code === 'finance_memory_record_limit') throw error; diagnostics.push('record_directory_unavailable'); return []; }
}
function sameOwner(owner,scope) { return owner?.databaseInstanceId === scope.databaseInstanceId && owner?.enterpriseKey === scope.enterpriseKey && owner?.accountSetId === scope.accountSetId; }
function safeFileState(source, options) {
 const path=source?.path, expected=source?.sha256;
 if (typeof path !== 'string' || !isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected ?? '')) return {state:'unknown',reason:'source_reference_incomplete'};
 const roots = source.kind === 'native_calculation' ? [options.auditDir] : [options.sourceRoot];
 if (!roots.some(root => typeof root === 'string' && isAbsolute(root) && inside(resolve(root),resolve(path)))) return {state:'unknown',reason:'source_not_authorized'};
 try { const b=bytes(path); return {state:sha(b) === expected ? 'unchanged' : 'changed',currentSha256:sha(b)}; }
 catch (error) { return {state:error.code === 'ENOENT' ? 'missing' : 'unknown',reason:error.code === 'ENOENT' ? 'source_missing' : 'source_unavailable'}; }
}
// 授权根变化只改变可核状态；确证内容修订或删除才改变业务依据指纹。
function accessIndependent(value) {
 if (Array.isArray(value)) return value.map(accessIndependent);
 if (!value || typeof value !== 'object') return value;
 const source=Object.hasOwn(value,'path') && Object.hasOwn(value,'state');
 const out={}; for (const [key,v] of Object.entries(value)) if (key !== 'observationStatus' && !(source && ['state','reason','currentSha256'].includes(key))) out[key]=accessIndependent(v);
 if (source && value.state === 'changed') out.observedSha256=value.currentSha256;
 if (source && value.state === 'missing') out.sourceMissing=true;
 return out;
}
function preserveKnownRevisions(current,previous=[]) {
 return current.map(s => {
  const old=previous.find(o => o.path === s.path && (o.sha256 ?? o.expectedSha256) === (s.sha256 ?? s.expectedSha256) && o.location === s.location);
  return s.state === 'unknown' && old && ['changed','missing'].includes(old.state) ? {...old,observationStatus:'unavailable'} : s;
 });
}
function flattenSources(evidence) {
 const out=[], seen=new Set();
 const visit=(source,depth) => { if (!source || typeof source !== 'object' || seen.has(source) || depth > 16) fail('finance_memory_source_invalid'); seen.add(source); out.push(source); for (const s of source.dependencies ?? []) visit(s,depth+1); seen.delete(source); };
 for (const mapping of [...(evidence?.mappings ?? []),...(evidence?.cashFlowAllocations ?? [])]) for (const source of mapping.sources ?? []) visit(source,0);
 if (out.length > 4000) fail('finance_memory_record_limit'); return out;
}
function postingRecords(db,dbPath,scope,options,diagnostics) {
 const root=join(dirname(dbPath),'posting-attempts'), found=new Map();
 for (const id of directories(root,/^[a-f0-9-]{36}$/,diagnostics)) {
  try {
   const dir=join(root,id), end=jsonFile(join(dir,'result.json')).value;
   if (!sameOwner(end,scope) || !end.operationId || !Number.isSafeInteger(end.voucherId) || !/^validation-\d+\.json$/.test(end.validation?.file ?? '')) continue;
   const begin=jsonFile(join(dir,'begin.json')), validation=jsonFile(join(dir,end.validation.file));
   if (begin.sha256 !== end.beginDigest || validation.sha256 !== end.validation.sha256 || !sameOwner(begin.value,scope)) continue;
   const operation=db.prepare('SELECT state FROM audit_operations WHERE database_instance_id=? AND operation_id=? AND attempt=?').get(scope.databaseInstanceId,end.operationId,end.operationAttempt ?? 1);
   if (!['succeeded','no_change'].includes(operation?.state)) continue;
   const sources=flattenSources(validation.value.evidence).map(s => ({kind:s.kind ?? 'original',path:s.path ?? null,sha256:s.sha256 ?? null,location:s.location ?? null,calculation:s.calculation ?? null,...safeFileState(s,options)}));
   const record={attemptId:id,ref:'posting:'+id,recordRoot:root,baseSha256:businessMemoryDigest({begin:begin.sha256,validation:validation.sha256,end}),content:validation.value.content,evidence:validation.value.evidence,issues:validation.value.issues ?? [],sources,startedAt:begin.value.startedAt ?? ''};
   const previous=found.get(end.voucherId); if (!previous || previous.startedAt < record.startedAt) found.set(end.voucherId,record);
  } catch { diagnostics.push('posting_record_incomplete'); }
 }
 return found;
}
function callRecords(scope, options, diagnostics) {
 const found=[], root=options.auditDir;
 const businessTools=new Set(['finance_workpaper','finance_annual_workpaper','finance_tax_calculate','finance_tax_summary_calculate','finance_prebook_review','finance_calculation_run','finance_method_run']);
 if (!root) return found;
 for (const id of directories(root,/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/,diagnostics)) {
  try {
   const dir=join(root,id), end=jsonFile(join(dir,'end.json')).value;
   if (end.scopeState !== 'observed' || !sameOwner(end.scope,scope) || !period(end.scope.period)) continue;
   const begin=jsonFile(join(dir,'begin.json')); if (begin.sha256 !== end.beginSha256 || begin.value.callId !== id || end.callId !== id || !businessTools.has(begin.value.tool)) continue;
   if (!['result.json','error.json'].includes(end.output?.file)) continue;
   const output=jsonFile(join(dir,end.output.file)); if (output.sha256 !== end.output.sha256) continue;
   const input=jsonFile(join(dir,'input.json')); if (input.sha256 !== begin.value.input?.sha256) continue;
   if (begin.value.tool === 'finance_method_run' && output.value?.execution?.kind !== 'script') continue;
   const sources=[...(begin.value.sources ?? []),...(end.loadedSources ?? [])].map(s => ({path:s.path ?? null,expectedSha256:s.sha256 ?? null,...safeFileState(s,options)}));
   const baseSha256=businessMemoryDigest({begin:begin.sha256,end,output:output.sha256,input:input.sha256});
   found.push({callId:id,recordRoot:root,tool:begin.value.tool,scope:end.scope,period:end.scope.period,status:end.status,businessOutcome:end.businessOutcome,executionCompleted:end.executionCompleted === true,sources,artifactRefs:end.metadata?.artifactRefs ?? [],input:input.value,output:output.value,ref:'call:'+id,baseSha256,sha256:businessMemoryDigest({record:baseSha256,sources:accessIndependent(sources)})});
  } catch { diagnostics.push('call_record_incomplete'); }
 }
 return found;
}
const equal = (a,b) => canonicalBusinessMemory(a) === canonicalBusinessMemory(b);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function calculationIdentity(call) {
 if (call.tool === 'finance_calculation_run' && /^[a-f0-9-]{36}$/.test(call.output?.runId ?? '')) return {runId:call.output.runId,result:call.output};
 if (call.tool === 'finance_method_run' && call.output?.version === 'finance-method-execution/1' && call.output.execution?.kind === 'script' && call.output.result?.kind === 'derived_calculation' && /^[a-f0-9-]{36}$/.test(call.output.result.runId ?? '') && /^mr:[a-f0-9-]{36}$/.test(call.output.runRef ?? '')) return {runId:call.output.result.runId,result:call.output.result,methodRunId:call.output.runRef.slice(3),methodRef:call.output.methodRef,methodVersion:call.output.methodVersion};
 return null;
}
function checkedFile(dir,name,descriptor,{json=false}={}) {
 // finance-calculation/1的save仅保存摘要和字节数；文件名由本读取器固定，不从记录取路径。
 if (!descriptor || Object.keys(descriptor).sort().join(',') !== 'bytes,sha256' || !digest(descriptor.sha256)) fail('finance_memory_calculation_record_invalid');
 const file=json ? jsonFile(join(dir,name)) : (() => {const b=bytes(join(dir,name));return {value:b,sha256:sha(b),bytes:b.length};})();
 if (file.sha256 !== descriptor.sha256 || file.bytes !== descriptor.bytes) fail('finance_memory_calculation_record_changed');
 return file;
}
function methodParameters(method,input,targetPeriod) {
 const allDefinitions=method.definition?.inputs ?? [];
 if (allDefinitions.some(d=>d.source === 'source_snapshot' && d.required && Number.isInteger(d.sourceIndex) && !input.sources?.[d.sourceIndex])) fail('finance_memory_calculation_parameters_invalid');
 const supplied=input.parameters ?? {}, definitions=allDefinitions.map((definition,index)=>({definition,index})).filter(({definition:d})=>d.source !== 'ledger' && d.type !== 'ledger_asset_cards' && !(d.source === 'source_snapshot' && Number.isInteger(d.sourceIndex))), out={};
 const allowed=new Set(definitions.flatMap(({definition:d,index})=>[d.key,'p'+index]));
 if (Object.keys(supplied).some(key=>!allowed.has(key))) fail('finance_memory_calculation_parameters_invalid');
 for (const {definition:d,index} of definitions) {
  const slot='p'+index;
  if (Object.hasOwn(supplied,slot) && Object.hasOwn(supplied,d.key) && slot !== d.key) fail('finance_memory_calculation_parameters_invalid');
  let value=Object.hasOwn(supplied,slot) ? supplied[slot] : supplied[d.key];
  if (d.source === 'constant') {
   if (!Object.hasOwn(d,'default') || value !== undefined && value !== d.default) fail('finance_memory_calculation_parameters_invalid');
   value=d.default;
  } else if (value === undefined && Object.hasOwn(d,'default') && d.meaning !== 'period') fail('finance_memory_calculation_parameters_invalid');
  if (d.meaning === 'period') { if (value !== undefined && value !== targetPeriod) fail('finance_memory_calculation_parameters_invalid'); value=targetPeriod; }
  if (value === undefined) { if (d.required) fail('finance_memory_calculation_parameters_invalid'); continue; }
  const type=value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (d.type === 'integer' ? !Number.isSafeInteger(value) : type !== d.type) fail('finance_memory_calculation_parameters_invalid');
  out[d.key]=value;
 }
 return out;
}
function recordedMethodRequest(call,identity,options,db,scope) {
 const method=getBusinessMemoryMethod(db,scope,identity.methodRef), execution=method?.definition?.execution;
 if (!method || method.version !== identity.methodVersion || call.input?.methodRef !== method.methodRef || execution?.kind !== 'script' || !equal(call.input.target,{accountSetId:scope.accountSetId,period:call.period}) || !equal(call.output.target,call.input.target)) fail('finance_memory_calculation_method_invalid');
 const dir=join(options.auditDir,'methods',identity.methodRunId), begin=jsonFile(join(dir,'begin.json')), end=jsonFile(join(dir,'result.json'));
 const definitionSha256=sha(JSON.stringify(method.definition)), parameters=methodParameters(method,call.input,call.period), scriptSha256=sha(execution.script);
 for (const r of [begin.value,end.value]) if (r.version !== 'finance-method-run/1' || r.runId !== identity.methodRunId || !sameOwner(r.scope,scope) || r.scope.period !== call.period || r.methodRef !== method.methodRef || r.methodVersion !== method.version || r.methodRevision !== method.revision || r.definitionSha256 !== definitionSha256 || r.execution?.kind !== 'script' || r.execution.engine !== execution.engine || r.execution.scriptSha256 !== scriptSha256 || !equal(r.parameters,parameters) || !equal(r.sources,call.input.sources ?? [])) fail('finance_memory_calculation_method_invalid');
 if (end.value.status !== call.output.status || end.value.result?.runId !== identity.runId || end.value.result?.status !== identity.result.status || call.output.execution.scriptSha256 !== scriptSha256) fail('finance_memory_calculation_method_invalid');
 const runs=db.prepare('SELECT content_json FROM business_memory_runs WHERE account_set_id=? AND enterprise_key=? AND version_id=?').all(scope.accountSetId,scope.enterpriseKey,method.methodRef).map(r=>JSON.parse(r.content_json));
 if (!runs.some(r=>r.executionRunId === identity.methodRunId && r.status === 'running' && r.definitionSha256 === definitionSha256 && r.period === call.period) || !runs.some(r=>r.executionRunId === identity.methodRunId && r.status === end.value.status && r.definitionSha256 === definitionSha256 && r.period === call.period)) fail('finance_memory_calculation_method_invalid');
 if (!equal(begin.value.matchedSources ?? [],end.value.matchedSources ?? [])) fail('finance_memory_calculation_method_invalid');
 return {methodRef:method.methodRef,methodVersion:method.version,methodDigest:businessMemoryDigest(method),applicability:method.definition.applicability ?? {},matchedSources:begin.value.matchedSources ?? [],beginSha256:begin.sha256,resultSha256:end.sha256,request:{title:method.definition.title ?? '企业已选方法',engine:execution.engine,script:execution.script,sources:call.input.sources ?? [],parameters:{...parameters,period:call.period},notes:method.definition.notes ?? [],...(execution.timeoutMs ? {timeoutMs:execution.timeoutMs} : {})}};
}
function assertRecordedObjectSources(method,record){
 const applicability=method.applicability,conditions=applicability.matchConditions ?? [];
 if (applicability.scope?.trim() || (applicability.conditions ?? []).some(value=>typeof value === 'string' && value.trim())) fail('finance_memory_calculation_applicability_unresolved');
 if (applicability.objectScope === 'account_set' && !conditions.length) return;
 if (applicability.objectScope !== 'business_object' || !conditions.length) fail('finance_memory_calculation_applicability_unresolved');
 for (const condition of conditions) {
  const source=record.sources[condition.sourceIndex],matched=method.matchedSources.find(value=>value.sourceIndex === condition.sourceIndex),check=record.methodSourceVersionChecks?.find(value=>value.sourceIndex === condition.sourceIndex);
  if (!source || !matched || matched.path !== source.path || matched.sha256 !== source.sha256 || !check || check.matched !== true || check.expectedSha256 !== source.sha256 || check.adoptedSha256 !== source.sha256 || condition.operator !== 'equals' || typeof condition.jsonPointer !== 'string' || !condition.jsonPointer.startsWith('/') || /~[^01]/.test(condition.jsonPointer)) fail('finance_memory_calculation_object_version_invalid');
  let value=JSON.parse(bytes(source.snapshotPath));
  for (const part of condition.jsonPointer.slice(1).split('/')) { const key=part.replaceAll('~1','/').replaceAll('~0','~'); if (!value || typeof value !== 'object' || !Object.hasOwn(value,key)) fail('finance_memory_calculation_object_version_invalid'); value=value[key]; }
  if (value !== condition.expected) fail('finance_memory_calculation_object_version_invalid');
 }
}
function calculationRecord(call, options, db, scope) {
 const identity=calculationIdentity(call); if (!identity) return null;
 try {
  const dir=join(options.auditDir,'calculations',identity.runId), record=jsonFile(join(dir,'record.json')), r=record.value;
  if (r.version !== 'finance-calculation/1' || r.kind !== 'derived_calculation' || r.callId !== call.callId || r.runId !== identity.runId || !['python','javascript'].includes(r.engine) || r.status !== identity.result.status || typeof identity.result.recordPath !== 'string' || resolve(identity.result.recordPath) !== resolve(join(dir,'record.json'))) return null;
  const scriptName=r.engine === 'python' ? 'script.py' : 'script.mjs', script=checkedFile(dir,scriptName,r.script), request=checkedFile(dir,'request.json',r.request,{json:true});
  const method=identity.methodRunId ? recordedMethodRequest(call,identity,options,db,scope) : null;
  if (!equal(request.value,method?.request ?? call.input) || request.value.engine !== r.engine || request.value.script !== script.value.toString('utf8') || request.value.title !== r.title || !equal(request.value.parameters ?? {},r.parameters)) return null;
  if (!Array.isArray(r.sources) || !Array.isArray(request.value.sources) || r.sources.length !== request.value.sources.length && r.status === 'executed') return null;
  for (const [index,s] of r.sources.entries()) {
   const requested=request.value.sources[index], snapshotPath=join(dir,'sources',String(index)+extname(s.path).toLowerCase());
   if (!requested || s.path !== resolve(requested.path) || !equal(s.locator,requested.locator ?? null) || resolve(s.snapshotPath) !== resolve(snapshotPath) || !digest(s.sha256)) return null;
   const snapshot=bytes(snapshotPath); if (sha(snapshot) !== s.sha256 || snapshot.length !== s.bytes) return null;
  }
  if (r.input) {
   const input=checkedFile(dir,'input.json',r.input,{json:true});
   if (!equal(input.value,{parameters:request.value.parameters ?? {},sources:r.sources.map((s,index)=>({index,snapshotPath:s.snapshotPath,sha256:s.sha256,locator:s.locator})),outputDir:join(dir,'outputs')})) return null;
  } else if (r.status === 'executed') return null;
  if (r.status === 'executed' && (r.execution?.exitCode !== 0 || r.execution.reason || !Array.isArray(r.executionFileChecks) || ![scriptName,'input.json'].every(name=>r.executionFileChecks.some(c=>c.file === name && c.unchanged === true)) || !Array.isArray(r.sourceChecks) || !r.sources.every(s=>r.sourceChecks.some(c=>c.path === s.path && c.sourceUnchanged === true && c.snapshotUnchanged === true)))) return null;
  if (method && r.status === 'executed') assertRecordedObjectSources(method,r);
  const sourceStates=r.sources.map(s => ({path:s.path,expectedSha256:s.sha256,...safeFileState(s,options)}));
  const provenance=method ? {methodRef:method.methodRef,methodVersion:method.methodVersion,methodDigest:method.methodDigest,methodRunId:identity.methodRunId,beginSha256:method.beginSha256,resultSha256:method.resultSha256} : null;
  const baseSha256=businessMemoryDigest({record:record.sha256,script:r.script.sha256,request:request.sha256,input:r.input?.sha256 ?? null,provenance});
  return {runId:r.runId,status:r.status,engine:r.engine,script:script.value.toString('utf8'),parameters:request.value.parameters ?? {},sources:sourceStates,provenance,ref:'calculation:'+r.runId,baseSha256,sha256:businessMemoryDigest({record:baseSha256,sources:accessIndependent(sourceStates)})};
 } catch { return null; }
}
const entryPath = entries => entries.map(e => ({code:e.code,side:e.debit !== 0 ? 'debit' : e.credit !== 0 ? 'credit' : 'zero',sign:e.debit < 0 || e.credit < 0 ? -1 : 1}));
function makeObservation(db,binding,options) {
 const scope=binding.scope, id=scope.accountSetId, diagnostics=[], references={}, referenceStates={};
 assertBusinessMemoryScope(db,scope);
 const installed=inspectBusinessMemorySchema(db); if (installed.state !== 'not_installed' && !installed.ok) fail('finance_memory_schema_inconsistent');
 const cached=installed.ok ? db.prepare('SELECT content_json FROM business_memory_cases WHERE account_set_id=? AND enterprise_key=? ORDER BY case_ref').all(id,scope.enterpriseKey).map(r => JSON.parse(r.content_json)) : [];
 const cachedBySource=new Map(cached.map(c => [c.sourceKey,c]));
 const accountSet=db.prepare('SELECT * FROM account_sets WHERE id=?').get(id);
 const accounts=db.prepare('SELECT * FROM accounts WHERE account_set_id=? ORDER BY code,id').all(id);
 const openings=db.prepare('SELECT * FROM opening_balances WHERE account_set_id=? ORDER BY code').all(id);
 const periods=db.prepare('SELECT * FROM periods WHERE account_set_id=? ORDER BY period').all(id);
 const vouchers=db.prepare('SELECT * FROM vouchers WHERE account_set_id=? ORDER BY period,word,number,id').all(id);
 const entries=db.prepare('SELECT e.* FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_set_id=? ORDER BY v.id,e.line_no,e.id').all(id);
 const assets=db.prepare('SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id').all(id);
 const runs=db.prepare('SELECT * FROM asset_depreciation_runs WHERE account_set_id=? ORDER BY asset_id,period,id').all(id);
 const bindings=listSourceBindingsForAccountSet(db,id);
 const imports=db.prepare('SELECT * FROM import_voucher_sources WHERE account_set_id=? AND enterprise_key=? ORDER BY id').all(id,scope.enterpriseKey);
 const batches=db.prepare('SELECT batch_id,source_system,enterprise_key,account_set_id,content_fingerprint,status,attempts,error_code,updated_at FROM import_batches WHERE account_set_id=? AND enterprise_key=? ORDER BY batch_id').all(id,scope.enterpriseKey);
 const byVoucher=new Map(); for (const e of entries) { if (!byVoucher.has(e.voucher_id)) byVoucher.set(e.voucher_id,[]); byVoucher.get(e.voucher_id).push(e); }
 const accountByCode=new Map(accounts.map(a => [a.code,a]));
 const profileRoles=getAccountingRoles(accountSet.accounting_profile_id), roles={cash:'cash',bank:'bank',receivable:'receivable',payable:'payable',inventory:'inventory',mainRevenue:'main_income',otherRevenue:'main_income',mainCost:'main_cost',otherCost:'main_cost',fixedAsset:'fixed_asset',accumulatedDepreciation:'accumulated_depreciation',intangibleAsset:'intangible_asset',accumulatedAmortization:'accumulated_amortization',salesExpense:'sales_expense',managementExpense:'management_expense',adminExpense:'management_expense',defaultDepreciationExpense:'management_expense',financeExpense:'finance_expense',taxPayable:'tax_payable',currentProfit:'current_profit',currentYearProfit:'current_profit',profitDistribution:'retained_profit'};
 const accountRole=code => Object.entries(profileRoles).filter(([,v]) => typeof v === 'string' && String(code).startsWith(v)).sort((a,b) => b[1].length-a[1].length).map(([key]) => roles[key] ?? 'other')[0] ?? 'unknown';
 const hasAux=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aux_allocations'").get();
 const auxiliary=hasAux ? db.prepare('SELECT a.entry_id,a.project_id,a.department_id,a.party_id,a.debit_cents,a.credit_cents FROM aux_allocations a WHERE a.account_set_id=? ORDER BY a.entry_id,a.id').all(id) : [];
 const periodStatus=new Map(periods.map(p => [p.period,p.status]));
 const posting=postingRecords(db,binding.dbPath,scope,options,diagnostics), calls=callRecords(scope,options,diagnostics), cases=[],methods=[];
 references['ledger:account-set']=businessMemoryDigest(accountSet);
 references['ledger:accounts']=businessMemoryDigest(accounts);
 const engineEvidenceRefs=['accounting','period-end-controls','money','accounting-profiles','posting-evidence-guard'].map(name => {
  const ref='code:'+name, sha256=sha(bytes(fileURLToPath(new URL('./'+name+'.mjs',import.meta.url)))); references[ref]=sha256; return {ref,sha256};
 });
 const makeCase=(sourceKey,value,raw) => {
  const caseRef='bc:'+businessMemoryDigest([scope.enterpriseKey,id,sourceKey]);
  const fingerprint=businessMemoryDigest(accessIndependent(raw)), c={caseRef,sourceKey,...value,fingerprint,contentDigest:fingerprint};
  references[caseRef]=fingerprint; referenceStates[caseRef]='current'; cases.push(c); return c;
 };
 for (const voucher of vouchers) {
  const es=byVoucher.get(voucher.id) ?? [], path=entryPath(es), source=imports.filter(r => r.voucher_id === voucher.id), evidence=posting.get(voucher.id), previous=cachedBySource.get('voucher:'+voucher.id);
  const voucherFingerprint=persistedVoucherFingerprint(voucher,es);
  const imported=source.map(s => ({kind:'import',ref:'import:'+s.id,system:s.source_system,sourceVoucherId:s.source_voucher_id,batchId:s.batch_id,contentFingerprint:s.content_fingerprint,unchanged:s.voucher_fingerprint === voucherFingerprint}));
  const sourceRefs=[{kind:'ledger',ref:'ledger:voucher:'+voucher.id,sha256:businessMemoryDigest({voucher,entries:es})},...imported];
  const gaps=['historical_algorithm_unknown'];
  if (!evidence) {
   const prior=previous?.sourceRefs.find(s => s.kind === 'posting_evidence');
   if (prior && previous.sourceRefs.find(s => s.kind === 'ledger')?.sha256 === sourceRefs[0].sha256 && prior.recordRoot !== join(dirname(binding.dbPath),'posting-attempts')) {
    const sources=preserveKnownRevisions(prior.sources.map(s => ({...s,...safeFileState(s,options)})),prior.sources);
    const currentSha256=prior.recordSha256 ? businessMemoryDigest({record:prior.recordSha256,sources:accessIndependent(sources)}) : prior.sha256;
    sourceRefs.push({...prior,sources,sha256:currentSha256,observationStatus:'unavailable'}); references[prior.ref]=currentSha256;
    referenceStates[prior.ref]=sources.some(s => ['changed','missing'].includes(s.state)) ? 'changed' : 'unavailable'; gaps.push('source_access_unavailable');
    if (referenceStates[prior.ref] === 'changed') gaps.push('source_version_unverified');
   } else gaps.push('posting_source_evidence_unknown');
  }
  else {
   const prior=previous?.sourceRefs.find(s => s.kind === 'posting_evidence' && s.ref === evidence.ref);
   evidence.sources=preserveKnownRevisions(evidence.sources,prior?.sources);
   evidence.sha256=businessMemoryDigest({record:evidence.baseSha256,sources:accessIndependent(evidence.sources)});
   const amount=value => { const parsed=parseMoney(value ?? 0,{allowNegative:true}); return parsed.ok ? formatCents(parsed.cents) : null; };
   const actualContent={period:voucher.period,voucher_date:voucher.voucher_date,word:voucher.word,summary:voucher.summary ?? '',kind:voucher.kind ?? 'normal',entries:es.map(e => ({code:String(e.code),summary:e.summary || voucher.summary || '',debit:amount(e.debit),credit:amount(e.credit)}))};
   // 原生证据以分为单位留存；这里关联并保留内容版本，不用金额相等代替来源语义正确。
   sourceRefs.push({kind:'posting_evidence',ref:evidence.ref,sha256:evidence.sha256,recordSha256:evidence.baseSha256,recordRoot:evidence.recordRoot,sources:evidence.sources,method:evidence.evidence?.method ?? null,rules:evidence.evidence?.rules ?? [],mappings:(evidence.evidence?.mappings ?? []).map(m => ({inputPointer:m.inputPointer,transform:m.transform,target:m.target,sources:m.sources.map(s => ({path:s.path,sha256:s.sha256,location:s.location ?? null,calculation:s.calculation ?? null})),valueMatched:m.valueMatched}))});
   references[evidence.ref]=evidence.sha256;
   referenceStates[evidence.ref]=evidence.sources.some(s => ['changed','missing'].includes(s.state)) ? 'changed' : evidence.sources.some(s => s.state === 'unknown') ? 'unavailable' : 'current';
   if (evidence.sources.some(s => ['changed','missing'].includes(s.state))) gaps.push('source_version_unverified');
   else if (evidence.sources.some(s => s.state === 'unknown')) gaps.push('source_access_unavailable');
   if (evidence.issues.length) gaps.push('historical_review_issues');
   if (canonicalBusinessMemory(actualContent) !== canonicalBusinessMemory(evidence.content)) gaps.push('posting_content_changed');
  }
  if (imported.some(s => !s.unchanged)) gaps.push('import_voucher_changed');
  const names=es.map(e => accountByCode.get(e.code)?.name ?? '').join(' '), label=evidence?.evidence?.businessLabel ?? '';
  const hasIncome=es.some(e => { const a=accountByCode.get(e.code); return a?.category === '损益' && a.direction === 'credit' && /收入/.test(a.name); });
  const topic=voucher.kind === 'depreciation' ? 'depreciation' : voucher.kind === 'carryforward' ? 'carry_forward'
   : hasIncome && /租金|租赁|房租/.test(names+' '+label) ? 'rental_income'
   : /增值税/.test(names) ? 'vat_treatment' : /所得税/.test(names) ? 'income_tax_treatment'
   : hasIncome ? 'revenue_recognition' : 'voucher_mapping';
  const dimensions=auxiliary.filter(a => es.some(e => e.id === a.entry_id));
  if (dimensions.length) sourceRefs.push({kind:'auxiliary_allocation',ref:'auxiliary:voucher:'+voucher.id,sha256:businessMemoryDigest(dimensions),dimensions:dimensions.map(a => ({projectId:a.project_id,departmentId:a.department_id,partyId:a.party_id}))});
  const objectKey=['depreciation','carry_forward'].includes(topic) ? 'account-set' : businessMemoryDigest([path,dimensions.map(a => [a.project_id,a.department_id,a.party_id])]).slice(0,24);
  const pStatus=periodStatus.get(voucher.period) ?? 'unknown', status=voucher.status === 'posted' ? pStatus === 'closed' ? 'closed_posted' : 'posted' : 'draft';
  const observedDefinition={applicability:{dateField:'posting_date',amountBasis:'unknown',businessView:topic === 'vat_treatment' ? 'vat' : topic === 'income_tax_treatment' ? 'income_tax' : 'accounting'},inputs:[],transformation:{kind:'direct_mapping',missingValues:'preserve_unknown',rounding:'unknown'},accounts:path.map(e => ({role:accountRole(e.code),code:e.code,side:e.side === 'zero' ? 'unknown' : e.side})),gaps:['historical_only','algorithm_unknown','execution_missing','policy_unverified']};
  const c=makeCase('voucher:'+voucher.id,{topic,objectKey,period:voucher.period,status,authority:'ledger_fact',priority:status === 'closed_posted' ? 30 : status === 'posted' ? 20 : 0,summary:{voucher:{word:voucher.word,number:voucher.number,date:voucher.voucher_date,kind:voucher.kind},periodStatus:pStatus,accounts:path,sourceCount:sourceRefs.length,classificationOrigin:'existing_account_name_or_recorded_business_label'},definition:observedDefinition,sourceRefs,gaps}, {voucher,entries:es,periodStatus:pStatus,sourceRefs});
  references['ledger:voucher:'+voucher.id]=sourceRefs[0].sha256;
  const sourceStates=sourceRefs.filter(s => s.kind === 'posting_evidence').map(s => referenceStates[s.ref]);
  referenceStates[c.caseRef]=gaps.includes('posting_content_changed') || gaps.includes('import_voucher_changed') || sourceStates.includes('changed') ? 'changed' : sourceStates.includes('unavailable') ? 'unavailable' : 'current';
  if (voucher.status === 'posted' && voucher.period < scope.period && topic === 'carry_forward') {
   methods.push({topic,objectKey,effectiveFrom:voucher.period,authority:'observed_history',definition:{title:'历史原生损益结转',applicability:{objectScope:'account_set',dateField:'current_period',amountBasis:'balance',businessView:'accounting'},inputs:[],transformation:{kind:'carry_forward',rounding:'native'},accounts:observedDefinition.accounts,execution:{kind:'native',tool:'carry_forward_profit',argsTemplate:{}},gaps:['historical_only','policy_unverified']},evidenceRefs:[{caseRef:c.caseRef,sha256:c.fingerprint},{ref:'ledger:account-set',sha256:references['ledger:account-set']},...engineEvidenceRefs],reason:'实际已过账凭证kind为carryforward；可执行范围仅为现有原生受控工具'});
  }
 }
 const groups=new Map();
 for (const c of cases.filter(c => ['voucher_mapping','rental_income','revenue_recognition','vat_treatment','income_tax_treatment'].includes(c.topic) && ['posted','closed_posted'].includes(c.status) && c.period < scope.period)) { const key=c.topic+'\0'+c.objectKey; if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(c); }
 for (const [objectKey,cs] of groups) {
  const preferred=cs.sort((a,b) => b.priority-a.priority || b.period.localeCompare(a.period) || a.caseRef.localeCompare(b.caseRef)).slice(0,20);
  methods.push({topic:preferred[0].topic,objectKey:preferred[0].objectKey,effectiveFrom:cs.map(c => c.period).sort()[0],authority:'observed_history',definition:{title:'历史凭证科目路径',...preferred[0].definition},evidenceRefs:preferred.map(c => ({caseRef:c.caseRef,sha256:c.fingerprint})),reason:'仅观察已过账历史科目及方向，不从金额推断算法'});
 }
 for (const asset of assets) references['ledger:asset:'+asset.id]=businessMemoryDigest(asset);
 references['ledger:assets']=businessMemoryDigest(assets);
 if (assets.length) {
  const config=assets.map(c => ({assetId:c.id,kind:c.kind,originalCost:c.original_cost,residualRate:c.residual_rate,usefulLifeMonths:c.useful_life_months,startPeriod:c.start_period,acquiredPeriod:c.acquired_period,openingAccumulated:c.opening_accumulated,ledgerStatus:c.ledger_status,assetAccount:c.asset_account,accumAccount:c.accum_account,expenseAccount:c.expense_account}));
  methods.push({topic:'depreciation',objectKey:'account-set',effectiveFrom:assets.map(c => c.start_period).sort()[0],authority:'ledger_fact',configuration:config,definition:{title:'账套资产卡片折旧与摊销',notes:['所有符合原生计提条件的本账套卡片'],applicability:{objectScope:'account_set',dateField:'depreciation_start_period',amountBasis:'original_cost',businessView:'accounting'},inputs:[{key:'assetCards',meaning:'asset_configuration',sourceRole:'asset_cards',type:'array',source:'ledger',required:false}],transformation:{kind:'straight_line',rounding:'native',missingValues:'native'},accounts:config.flatMap(c => [{role:accountRole(c.assetAccount),code:c.assetAccount},{role:accountRole(c.accumAccount),code:c.accumAccount},{role:accountRole(c.expenseAccount),code:c.expenseAccount}]),execution:{kind:'native',tool:'depreciation_run',argsTemplate:{}},gaps:assets.some(c => c.ledger_status !== 'booked') ? ['mapping_unverified'] : []},evidenceRefs:[...assets.map(c => ({ref:'ledger:asset:'+c.id,sha256:references['ledger:asset:'+c.id]})),{ref:'ledger:assets',sha256:references['ledger:assets']},...engineEvidenceRefs],reason:'方法来自实际资产卡片确定性参数和现有原生引擎；执行继续经过期间、人审、幂等和资产入账保护'});
 }
 for (const batch of batches.filter(b => b.status !== 'completed')) makeCase('import-batch:'+batch.batch_id,{topic:'import_history',objectKey:batch.source_system,period:accountSet.start_period,status:'failed',authority:'observed_history',priority:-10,summary:{batchId:batch.batch_id,status:batch.status,errorCode:batch.error_code},sourceRefs:[{kind:'import_batch',ref:'import-batch:'+batch.batch_id}],gaps:['not_successful_history']},batch);
 for (const call of calls) {
  const previous=cachedBySource.get('call:'+call.callId);
  call.sources=preserveKnownRevisions(call.sources,previous?.sourceRefs.find(s => s.kind === 'call_record')?.sources);
  call.sha256=businessMemoryDigest({record:call.baseSha256,sources:accessIndependent(call.sources)});
  references[call.ref]=call.sha256; referenceStates[call.ref]=call.sources.some(s => ['changed','missing'].includes(s.state)) ? 'changed' : call.sources.some(s => s.state === 'unknown') ? 'unavailable' : 'current';
  const identity=calculationIdentity(call), calculation=calculationRecord(call,options,db,scope), success=call.executionCompleted && call.status === 'returned' && !['failed','unknown','rejected'].includes(call.businessOutcome);
  if (calculation) {
   calculation.sources=preserveKnownRevisions(calculation.sources,previous?.sourceRefs.find(s => s.kind === 'calculation_record')?.sources);
   calculation.sha256=businessMemoryDigest({record:calculation.baseSha256,sources:accessIndependent(calculation.sources)});
  }
  if (calculation) { references[calculation.ref]=calculation.sha256; referenceStates[calculation.ref]=calculation.sources.some(s => ['changed','missing'].includes(s.state)) ? 'changed' : calculation.sources.some(s => s.state === 'unknown') ? 'unavailable' : 'current'; }
  if (identity && !calculation) { diagnostics.push('calculation_record_unverified'); referenceStates['calculation:'+identity.runId]='changed'; }
  if (calculation?.provenance) { const ref='method:'+calculation.provenance.methodRef; references[ref]=calculation.provenance.methodDigest; referenceStates[ref]='current'; }
  const c=makeCase('call:'+call.callId,{topic:identity ? 'calculation' : 'business_call',objectKey:identity?.runId ?? call.tool,period:call.period,status:identity && !calculation ? 'unknown' : success && (!calculation || calculation.status === 'executed') ? 'executed_unreviewed' : 'failed',authority:'observed_history',priority:success ? 5 : -10,...(calculation?.provenance ? {methodRef:calculation.provenance.methodRef,methodVersion:calculation.provenance.methodVersion} : {}),summary:{tool:call.tool,businessOutcome:call.businessOutcome,artifactRefs:call.artifactRefs,runId:identity?.runId ?? null},sourceRefs:[{kind:'call_record',ref:call.ref,recordRoot:call.recordRoot,sha256:call.sha256,sources:call.sources},...(calculation ? [{kind:'calculation_record',ref:calculation.ref,sha256:calculation.sha256,sources:calculation.sources,...(calculation.provenance ? {provenance:calculation.provenance} : {})}] : [])],gaps:['business_result_unreviewed',...(!calculation ? ['execution_version_unknown'] : calculation.sources.some(s => ['changed','missing'].includes(s.state)) ? ['source_version_unverified'] : [])]}, {callRef:call.sha256,calculation:calculation?.sha256 ?? null});
  referenceStates[c.caseRef]=identity && !calculation || [referenceStates[call.ref],referenceStates[calculation?.ref]].includes('changed') ? 'changed' : [referenceStates[call.ref],referenceStates[calculation?.ref]].includes('unavailable') ? 'unavailable' : 'current';
  if (calculation && c.status === 'executed_unreviewed' && c.period < scope.period) methods.push({topic:'calculation',objectKey:calculation.runId,effectiveFrom:c.period,authority:'observed_history',definition:{title:'历史留存计算脚本',applicability:{amountBasis:'unknown'},inputs:Object.keys(calculation.parameters).map(key => ({key,meaning:'current_period_parameters',type:Array.isArray(calculation.parameters[key]) ? 'array' : calculation.parameters[key] === null ? 'null' : typeof calculation.parameters[key],source:'current_parameters',required:true})),transformation:{kind:'script',missingValues:'unknown',rounding:'script_defined'},accounts:[],execution:{kind:'script',engine:calculation.engine,script:calculation.script},gaps:['historical_only','policy_unverified','parameters_missing']},evidenceRefs:[{caseRef:c.caseRef,sha256:c.fingerprint},{ref:calculation.ref,sha256:calculation.sha256}],reason:'仅复用已留存的实际脚本版本，执行成功未升级为操作者方法决定'});
 }
 // 新工作区未获旧资料根授权时，保留数据库中已冻结的案例与执行依据；绝不越权跟随旧路径读取。
 for (const old of cached.filter(c => c.sourceKey.startsWith('call:') && !cases.some(current => current.caseRef === c.caseRef))) {
  const origin=old.sourceRefs.find(s => s.kind === 'call_record')?.recordRoot;
  const unavailable=origin !== options.auditDir && old.observationStatus !== 'missing', state=unavailable ? 'unavailable' : 'missing';
  const originalFingerprint=old.originalFingerprint ?? old.fingerprint;
  const retained={...old,originalFingerprint,observationStatus:state,...(!unavailable ? {fingerprint:businessMemoryDigest({prior:originalFingerprint,missing:true}),contentDigest:businessMemoryDigest({prior:originalFingerprint,missing:true})} : {})};
  cases.push(retained); references[old.caseRef]=retained.fingerprint; referenceStates[old.caseRef]=state;
  for (const source of old.sourceRefs) if (source.ref && source.sha256) {
   references[source.ref]=source.sha256; referenceStates[source.ref]=state;
   if (source.kind === 'calculation_record' && source.provenance) {
    const p=source.provenance, method=/^bm:[a-f0-9-]{36}$/.test(p.methodRef ?? '') ? getBusinessMemoryMethod(db,scope,p.methodRef) : null;
    const actual=method ? businessMemoryDigest(method) : null, ref='method:'+p.methodRef;
    // 缓存只给历史预期；当前引用必须由同企业实际账库的不可变版本重新确认。
    if (method && method.version === p.methodVersion && actual === p.methodDigest) { references[ref]=actual; referenceStates[ref]='current'; }
    else {
     referenceStates[ref]=method ? 'changed' : 'missing'; referenceStates[source.ref]='changed'; referenceStates[old.caseRef]='changed';
     retained.fingerprint=businessMemoryDigest({prior:originalFingerprint,methodVersionDigest:actual}); retained.contentDigest=retained.fingerprint; retained.status='unknown'; references[old.caseRef]=retained.fingerprint;
    }
   }
  }
 }
 const historical=cases.filter(c => c.period < scope.period), summary={accountingProfile:accountSet.accounting_profile_id,taxpayerType:accountSet.taxpayer_type,accountingStandard:accountSet.accounting_standard,startPeriod:accountSet.start_period,accountCount:accounts.length,openingBalanceCount:openings.length,periodCount:periods.length,closedPeriodCount:periods.filter(p => p.status === 'closed').length,voucherCount:vouchers.length,historicalPostedCount:historical.filter(c => ['posted','closed_posted'].includes(c.status)).length,draftVoucherCount:vouchers.filter(v => v.status !== 'posted').length,assetCount:assets.length,depreciationRunCount:runs.length,importSourceCount:imports.length,sourceBindingCount:bindings.length,callCount:cases.filter(c => c.sourceKey.startsWith('call:')).length,availableCallCount:calls.length,unknownSourceCaseCount:cases.filter(c => c.gaps.includes('posting_source_evidence_unknown')).length,diagnostics:[...new Set(diagnostics)],meaning:'账库事实、历史观察与操作者决定分别保留；本期和未来记录不自动形成既定方法'};
 const sourceState={version:'business-memory-sources/1',references,referenceStates,diagnostics:[...new Set(diagnostics)],recordDirectories:{auditConfigured:!!options.auditDir,sourceRootConfigured:!!options.sourceRoot}};
 const fingerprint=businessMemoryDigest({accountSet,accounts,openings,periods,vouchers,entries,assets,runs,bindings,imports,batches,auxiliary,references});
 // 同一主题的多个原生历史案例合并，避免一次初始化产生多个等价版本。
 const unique=new Map(); for (const m of methods) { const key=[m.topic,m.objectKey,m.authority].join('\0'); const old=unique.get(key); if (old && m.topic === 'carry_forward') old.evidenceRefs.push(...m.evidenceRefs.filter(r => !old.evidenceRefs.some(o => (o.caseRef ?? o.ref) === (r.caseRef ?? r.ref)))); else unique.set(key,m); }
 return {scope,fingerprint,summary,cases,methods:[...unique.values()],sourceState};
}
function configured(options,binding) {
 const auditDir=options.auditDir ?? process.env.FINANCE_AUDIT_DIR ?? join(dirname(binding.dbPath),'finance-call-records');
 const sourceRoot=options.sourceRoot ?? process.env.FINANCE_SOURCE_ROOT;
 if (!isAbsolute(auditDir) || sourceRoot !== undefined && !isAbsolute(sourceRoot)) fail('finance_memory_path_invalid');
 return {...options,auditDir,...(sourceRoot ? {sourceRoot} : {})};
}
export function observeBusinessMemory({target},options={}) {
 const binding=resolveDirectFinanceTarget(target,options.dbPath ?? process.env.FINANCE_DATABASE_PATH);
 assertRestoreOpenPath(binding.dbPath);
 const db=new DatabaseSync(binding.dbPath,{readOnly:true});
 try { db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; BEGIN'); const result=makeObservation(db,binding,configured(options,binding)); db.exec('COMMIT'); return result; }
 finally { if (db.isTransaction) try {db.exec('ROLLBACK');} catch {} db.close(); }
}
export async function prepareBusinessMemory({target},options={}) {
 if (options.readOnly || process.env.WORKBENCH_DATABASE_MODE === 'readonly') fail('finance_memory_readonly');
 const binding=resolveDirectFinanceTarget(target,options.dbPath ?? process.env.FINANCE_DATABASE_PATH);
 assertRestoreOpenPath(binding.dbPath);
 const db=new DatabaseSync(binding.dbPath), configuration=configured(options,binding);
 try {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000'); assertBusinessMemoryScope(db,binding.scope); assertRestoreWritable(db);
  await ensureBusinessMemorySchema(db,{dbPath:binding.dbPath,outDir:options.backupDir ?? join(dirname(binding.dbPath),'business-memory-install-'+randomUUID())});
  db.exec('BEGIN'); const observed=makeObservation(db,binding,configuration); db.exec('COMMIT');
  const previous=readBusinessMemoryState(db,binding.scope);
  // 即使未新增账务，显式prepare也可重建丢失的派生索引；不可变方法按内容去重。
  const verify=() => { if (makeObservation(db,binding,configuration).fingerprint !== observed.fingerprint) fail('finance_memory_sources_changed'); };
  const result=replaceBusinessMemoryIndex(db,binding.scope,observed,{verify});
  return {...result,scope:binding.scope,prepared:true,previousFingerprint:previous?.fingerprint ?? null};
 } finally { if (db.isTransaction) try {db.exec('ROLLBACK');} catch {} db.close(); }
}
