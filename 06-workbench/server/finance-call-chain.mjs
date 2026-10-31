// 本机自动调用记录；只记录执行，不为 Agent 建立任务、事实或业务依赖图。
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {captureBusinessEvidence,summaryBusinessEvidence} from './business-evidence.mjs';

const context = new AsyncLocalStorage();
const sha = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const secretKey = /(?:password|authorization|api[_-]?key|token|credential|secret|cookie)/i;
const scrubText = text => text.replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{10,}|\bgh[opusr]_[A-Za-z0-9_]{10,}/gi, '[credential redacted]').replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,'$1[credential redacted]@');
function snapshot(value, seen = new Set()) {
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) return '[non-JSON value]';
  seen.add(value);
  const out = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === 'length' && Array.isArray(value)) continue;
    if (!descriptor.enumerable) continue;
    Object.defineProperty(out, key, { enumerable: true, configurable: true, writable: true,
      value: secretKey.test(key) ? '[credential redacted]' : 'value' in descriptor ? snapshot(descriptor.value, seen) : '[accessor omitted]' });
  }
  seen.delete(value);
  return out;
}
const errorInfo = error => ({name: String(error?.name ?? 'Error'), code: String(error?.code ?? 'tool_error'),
  message: scrubText(String(error?.message ?? error)), ...(error?.details !== undefined ? {details: snapshot(error.details)} : {})});
export function financeAuditDirectory(auditDir) {
  const value = auditDir ?? process.env.FINANCE_AUDIT_DIR ?? (process.env.FINANCE_DATABASE_PATH
    ? join(dirname(process.env.FINANCE_DATABASE_PATH), 'finance-call-records') : join(process.cwd(), '.finance-call-records'));
  if (typeof value !== 'string' || !isAbsolute(value)) throw Object.assign(Error('finance_audit_directory_absolute_required'), {code:'finance_audit_directory_absolute_required'});
  return resolve(value);
}
export const resolveFinanceAuditDir = financeAuditDirectory;
async function rootDirectory(value) {
  const root = financeAuditDirectory(value);
  await checkParents(root, true);
  await mkdir(root, {recursive:true, mode:0o700});
  await checkParents(root);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)).toLowerCase() !== root.toLowerCase())
    throw Object.assign(Error('finance_audit_directory_invalid'), {code:'finance_audit_directory_invalid'});
  return root;
}
async function checkParents(path, allowMissing = false) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Error('finance_call_path_invalid'); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
async function save(path, value) {
  const bytes = encode(value);
  await writeFile(path, bytes, {flag:'wx', mode:0o600});
  return {file:path.split(/[\\/]/).at(-1), sha256:sha(bytes), bytes:Buffer.byteLength(bytes)};
}
async function load(path) {
  await checkParents(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('finance_call_file_invalid');
  return readFile(path);
}
function sourceDescriptors(options) {
  const found = [...(Array.isArray(options.sources) ? options.sources : [])];
  for (const key of ['manifestPath','inputPath','sourcePath']) if (typeof options.args?.[key] === 'string') found.push({path:options.args[key], locator:key});
  for (const path of Array.isArray(options.args?.manifestPaths)?options.args.manifestPaths:[]) if(typeof path==='string')found.push({path,locator:'annual_manifest'});
  for (const row of Array.isArray(options.args?.originals) ? options.args.originals : []) if (typeof row?.path === 'string') found.push({path:row.path, locator:row.locator ?? row.id ?? 'original'});
  return [...new Map(found.map(row => typeof row === 'string' ? {path:row, locator:''} : row).filter(row => row && typeof row.path === 'string').map(row => [row.path+'#'+(row.locator??''),row])).values()];
}
async function sourceState(descriptors) {
  return Promise.all(descriptors.map(async source => {
    const base = {path:source.path, locator:source.locator ?? ''};
    try {
      if (!isAbsolute(source.path)) return {...base, state:'unverified', reason:'source_path_not_absolute'};
      const bytes = await load(source.path);
      return {...base, state:'observed', sha256:sha(bytes), bytes:bytes.length};
    } catch (error) { return {...base, state:'unverified', reason:error.code ?? error.message}; }
  }));
}
const scopeOf = options => snapshot(options.scope ?? options.args?.scope ?? options.args?.target ?? Object.fromEntries(
  ['enterpriseKey','accountSetId','databaseInstanceId','period','currency'].filter(key => options.args?.[key] !== undefined).map(key => [key, options.args[key]])));
let recorderDigest;
async function recorderVersion() { return recorderDigest ??= sha(await readFile(fileURLToPath(import.meta.url))); }
export function currentFinanceCall() { return context.getStore() ?? null; }
export function annotateFinanceCall(values) {
  const active=context.getStore();if(!active)return false;
  for(const key of ['scope','ruleVersion','codeDigest','catalogDigest','artifactRefs','nativeOperationId','configuredTarget'])if(values?.[key]!==undefined)active.metadata[key]=snapshot(values[key]);
  if(Array.isArray(values?.sources)){
    const rows=[...(active.metadata.sources??[]),...values.sources.map(source=>({...snapshot(source),observedAt:new Date().toISOString(),observationStage:'native_loaded'}))];
    const unique=new Map();
    for(const source of rows.filter(row=>typeof row?.path==='string')){const key=source.path+'#'+(source.locator??'')+'#'+(source.sha256??source.digest??'');if(!unique.has(key))unique.set(key,source);}
    active.metadata.sources=[...unique.values()];
  }
  return true;
}

export async function withFinanceCall(options, fn) {
  if (!options || typeof options.tool !== 'string' || typeof fn !== 'function') throw Error('finance_call_arguments_invalid');
  const root = await rootDirectory(options.auditDir), callId = `${new Date().toISOString().replace(/[-:.]/g,'')}_${randomUUID()}`;
  const directory = join(root, callId);
  await mkdir(directory, {mode:0o700});
  const descriptors = sourceDescriptors(options), sources = await sourceState(descriptors), startedAt = new Date().toISOString(), start = performance.now();
  const input = await save(join(directory,'input.json'), snapshot(options.args ?? {}));
  const initialScope=scopeOf(options);
  const begin = {version:'finance-call-record/1', callId, tool:options.tool, startedAt, scope:initialScope, scopeState:Object.keys(initialScope??{}).length?'provided':'unknown', input, sources,
    configuredTarget:snapshot({databasePath:process.env.FINANCE_DATABASE_PATH??null,apiBase:process.env.FINANCE_API_BASE??null,verification:'configured_only_not_runtime_proof'}),
    recorderCodeDigest:await recorderVersion(), parentCallId:context.getStore()?.callId ?? null,
    evidenceMeaning:'本机文件与调用记录可核验；不证明原件真实、业务判断正确或已获人审。'};
  const beginRef = await save(join(directory,'begin.json'), begin);
  const reference = Object.freeze({callId, auditDir:root, recordPath:directory, metadata:{}});
  let value, error, completed = false;
  try { value = await context.run(reference, async()=>{
    if(typeof options.validate==='function')await options.validate();
    const businessEvidence=options.args?.businessEvidence??(options.tool==='finance_tax_summary_calculate'?summaryBusinessEvidence(options.args):undefined);
    if(businessEvidence!==undefined){
      const evidence=captureBusinessEvidence(options.args,businessEvidence);
      reference.metadata.businessEvidence=await save(join(directory,'business-evidence.json'),snapshot(evidence));
      annotateFinanceCall({sources:[...evidence.mappings,...evidence.cashFlowAllocations].flatMap(m=>m.sources).flatMap(s=>[s,...(s.dependencies??[])]).map(s=>({path:s.path,locator:s.location??s.locator,sha256:s.sha256,bytes:s.bytes}))});
      if(evidence.valueMismatches)throw Object.assign(Error('原件值与实际业务参数不一致，请核对字段或转换方式。'),{code:'finance_evidence_value_mismatch'});
    }
    return fn();
  }); completed = true; }
  catch (caught) { error = caught; }
  try {
    const output = await save(join(directory, error ? 'error.json' : 'result.json'), error ? errorInfo(error) : snapshot(value));
    const loadedSources=(reference.metadata.sources??[]).map(source=>({path:source.path,locator:source.locator??'',
      state:/^[a-f0-9]{64}$/.test(source.sha256??source.digest??'')?'observed':'unverified',sha256:source.sha256??source.digest??null,
      ...(source.bytes!==undefined?{bytes:source.bytes}:{}),observedAt:source.observedAt,observationStage:'native_loaded'}));
    const baselines=[...sources,...loadedSources],after=await sourceState(baselines);
    const status = error ? 'failed' : ['failed','unknown','rejected'].includes(value?.status) ? value.status : value?.isError===true||value?.ok===false||value?.success===false ? 'failed' : 'returned';
    const businessOutcome=error?'failed':value?.ok===false||value?.success===false||value?.isError===true?'failed':value?.status??'not_asserted';
    const metadata=reference.metadata,ruleVersion=metadata.ruleVersion??value?.ruleVersion??value?.rules?.ruleVersion??value?.actualImpact?.domain?.ruleVersion??null;
    const codeDigest=metadata.codeDigest??value?.codeDigest??value?.actualImpact?.domain?.codeDigest??null;
    await save(join(directory,'end.json'), {version:'finance-call-record/1', callId, beginSha256:beginRef.sha256,
      finishedAt:new Date().toISOString(), durationMs:Math.round((performance.now()-start)*1000)/1000,
      status,businessOutcome,executionCompleted:completed,output,loadedSources,sourcesAfter:after,metadata,
      sourceChanges:baselines.filter((row,index)=>row.sha256!==after[index].sha256 || row.state!==after[index].state).map(row=>({path:row.path,locator:row.locator,fromStage:row.observationStage??'call_start',toStage:'call_end'})),
      scope:metadata.scope??initialScope,scopeState:Object.hasOwn(metadata,'scope')&&Object.keys(metadata.scope??{}).length?'observed':Object.keys(initialScope??{}).length?'provided':'unknown',
      ruleVersion:snapshot(ruleVersion),ruleVersionState:ruleVersion===null?'unknown':'observed',codeDigest:snapshot(codeDigest),codeVersionState:codeDigest===null?'unknown':'observed',
      catalogDigest:metadata.catalogDigest??value?.rules?.catalogDigest??null,
      nativeOperationId:metadata.nativeOperationId??value?.operationId??value?.receipt?.operationId??null,
      nativeOperationMeaning:'操作身份只用于关联原生审计；存在ID不证明业务已经执行或成功。'});
  } catch (recordError) {
    const failure = Object.assign(Error('finance_call_recording_failed'), {code:'finance_call_recording_failed', callId, recordPath:directory,
      executionCompleted:completed, retryable:false, writeOutcome:'unknown', cause:recordError, originalError:error});
    throw failure;
  }
  if (error) throw error;
  return value;
}

function checkedId(callId) {
  if (typeof callId !== 'string' || !/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/.test(callId)) throw Error('finance_call_id_invalid');
  return callId;
}
export async function readFinanceCall({auditDir, callId}) {
  const directory = join(await rootDirectory(auditDir), checkedId(callId));
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error('finance_call_path_invalid');
  const beginBytes = await load(join(directory,'begin.json')), begin = JSON.parse(beginBytes);
  const problems = [];
  const digestValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (begin.version !== 'finance-call-record/1' || begin.callId !== callId || typeof begin.tool !== 'string' || !begin.tool ||
    typeof begin.startedAt !== 'string' || !Number.isFinite(Date.parse(begin.startedAt)) || begin.input?.file !== 'input.json' ||
    !digestValid(begin.input.sha256) || !Number.isSafeInteger(begin.input.bytes) || begin.input.bytes<0 || !digestValid(begin.recorderCodeDigest) ||
    !Array.isArray(begin.sources) || !begin.sources.every(source=>source && typeof source.path==='string' && typeof source.locator==='string'))
    throw Error('finance_call_binding_invalid');
  const inputBytes = await load(join(directory,begin.input.file));
  if (sha(inputBytes) !== begin.input.sha256) problems.push('input_digest_mismatch');
  let end = null, output = null;
  let endBytes;
  try { endBytes = await load(join(directory,'end.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (endBytes) {
    end = JSON.parse(endBytes);
    if (end.version !== 'finance-call-record/1' || typeof end.callId !== 'string' || !digestValid(end.beginSha256) ||
      !['returned','failed','unknown','rejected','tool_error'].includes(end.status) || typeof end.executionCompleted !== 'boolean' ||
      !Number.isFinite(end.durationMs) || end.durationMs<0 || !digestValid(end.output?.sha256) ||
      !Number.isSafeInteger(end.output?.bytes) || end.output.bytes<0) throw Error('finance_call_binding_invalid');
    if (end.callId !== callId || end.beginSha256 !== sha(beginBytes)) problems.push('begin_link_mismatch');
    if (!['result.json','error.json'].includes(end.output?.file)) throw Error('finance_call_binding_invalid');
    try {
      const outputBytes = await load(join(directory,end.output.file));
      if (sha(outputBytes) !== end.output.sha256) problems.push('output_digest_mismatch');
      output = JSON.parse(outputBytes);
    } catch (error) { if (error.code !== 'ENOENT') throw error; problems.push('output_missing'); }
  }
  const baselines=[...begin.sources,...(Array.isArray(end?.loadedSources)?end.loadedSources:[])];
  if(!baselines.every(source=>source&&typeof source.path==='string'&&typeof source.locator==='string'))throw Error('finance_call_binding_invalid');
  const currentSources = await sourceState(baselines);
  const changedSources = [...new Set(baselines.filter((source,index)=>source.sha256&&currentSources[index].sha256&&source.sha256!==currentSources[index].sha256).map(source=>source.path))];
  const unverifiedSources=[...new Set(currentSources.filter(source=>source.state!=='observed').map(source=>source.path))];
  return {callId, tool:begin.tool, status:end?.status ?? 'incomplete', integrity:problems.length ? 'changed' : !end ? 'incomplete' : 'verified', problems,
    begin,end,input:JSON.parse(inputBytes),output,currentSources,changedSources,unverifiedSources,
    sourceCurrentness:changedSources.length?'changed':unverifiedSources.length?'unverified':'unchanged',
    recordPath:directory, verificationMeaning:'核验保存记录与文件摘要，不是原件真实性或财税正确性背书。'};
}
export async function listFinanceCalls({auditDir, limit=100}={}) {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>10000) throw Error('finance_call_limit_invalid');
  const root = await rootDirectory(auditDir), names = (await readdir(root,{withFileTypes:true})).filter(row=>row.isDirectory()&&/^\d{8}T\d{9}Z_[a-f0-9-]{36}$/.test(row.name)).map(row=>row.name).sort().reverse();
  const calls = [];
  for (const callId of names.slice(0,limit)) {
    try { const record = await readFinanceCall({auditDir:root,callId}); calls.push({callId,tool:record.tool,status:record.status,integrity:record.integrity,
      scope:record.end?.scope??record.begin.scope,scopeState:record.end?.scopeState??record.begin.scopeState??'unknown',startedAt:record.begin.startedAt,finishedAt:record.end?.finishedAt??null,durationMs:record.end?.durationMs??null,
      nativeOperationId:record.end?.nativeOperationId??null,configuredTarget:record.end?.metadata?.configuredTarget??record.begin.configuredTarget,
      businessOutcome:record.end?.businessOutcome??'unknown',
      sourceChanges:record.end?.sourceChanges??[],changedSources:record.changedSources,sourceCurrentness:record.sourceCurrentness,recordPath:record.recordPath}); }
    catch (error) { calls.push({callId,status:'unreadable',integrity:'unverified',code:error.code??error.message,recordPath:join(root,callId)}); }
  }
  return {version:'finance-call-index/1',auditDir:root,total:names.length,calls,omitted:Math.max(0,names.length-calls.length)};
}
export async function verifyFinanceCalls(options={}) {
  const index = await listFinanceCalls({...options,limit:10000});
  return {...index, success:index.omitted===0&&index.calls.every(call=>call.integrity==='verified'&&call.status!=='incomplete'&&call.sourceCurrentness==='unchanged'),
    recordIntegrityVerified:index.omitted===0&&index.calls.every(call=>call.integrity==='verified'&&call.status!=='incomplete'),
    sourcesChanged:index.calls.filter(call=>call.sourceCurrentness==='changed').length,
    incomplete:index.calls.filter(call=>call.status==='incomplete').length,
    changed:index.calls.filter(call=>call.integrity!=='verified').length};
}
