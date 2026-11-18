// 接收既有计算器的本机历史观察产物；执行留痕不等于原件语义、已过账或人审。
import {join,resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {readFinanceCall} from './finance-call-chain.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {BASELINE_ADAPTATION_SCHEMA} from './business-baseline-contracts.mjs';
import {baselineBytes,baselineInside,baselineDirectoryIdentity,resolveBaselineSourceReferences} from './business-baseline-materials.mjs';
import {canonicalBusinessMemory} from './business-memory-storage.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>canonicalBusinessMemory(a)===canonicalBusinessMemory(b);
const pathKey=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&pathKey(a)===pathKey(b);

export async function loadBaselineAdaptation(reference,scope,opts){
 let call;
 try{call=await readFinanceCall({auditDir:opts.auditDir,callId:reference.callId});}
 catch{fail('finance_baseline_adaptation_record_invalid');}
 const observedScope=call.tool==='finance_calculation_run'&&call.status==='returned'&&call.integrity==='verified'&&call.end?.executionCompleted&&call.end.scopeState==='observed'&&same(call.end.scope,scope);
 if(!observedScope)fail('finance_baseline_adaptation_scope_unverified');
 if(call.sourceCurrentness!=='unchanged'||call.end.sourceChanges?.length)fail('finance_baseline_adaptation_source_changed');
 const result=call.output,runId=result?.runId;
 if(result?.status!=='executed'||result.kind!=='derived_calculation'||!/^[a-f0-9-]{36}$/.test(runId??''))fail('finance_baseline_adaptation_execution_unverified');
 const root=resolve(opts.auditDir),runDir=join(root,'calculations',runId),recordPath=join(runDir,'record.json'),artifacts=[];
 const read=(path,expected,{max=8*1024*1024}={})=>{
  let bytes;
  try{bytes=baselineBytes(path,root,{max});}
  catch{fail('finance_baseline_adaptation_artifact_unavailable');}
  const descriptor={path,sha256:sha(bytes),bytes:bytes.length};
  if(expected&&(descriptor.sha256!==expected.sha256||descriptor.bytes!==expected.bytes))fail('finance_baseline_adaptation_artifact_changed');
  artifacts.push(descriptor);return bytes;
 };
 const descriptor=value=>value&&/^[a-f0-9]{64}$/.test(value.sha256??'')&&Number.isSafeInteger(value.bytes)&&value.bytes>=0;
 if(!samePath(result.recordPath,recordPath))fail('finance_baseline_adaptation_record_invalid');
 let record,request,input,output;
 try{record=JSON.parse(read(recordPath));}
 catch(error){if(error.code)throw error;fail('finance_baseline_adaptation_record_invalid');}
 const executionVerified=record.version==='finance-calculation/1'&&record.kind==='derived_calculation'&&record.runId===runId&&record.callId===reference.callId&&record.status==='executed'&&record.execution?.exitCode===0&&!record.execution?.reason;
 const manifestValid=Array.isArray(record.sources)&&record.sources.length>0&&record.sources.length<=64&&Array.isArray(record.outputs);
 if(!executionVerified||!manifestValid)fail('finance_baseline_adaptation_execution_unverified');
 if(![record.request,record.script,record.input].every(descriptor))fail('finance_baseline_adaptation_record_invalid');
 const configuredScope=samePath(record.financeContext?.dbPath,opts.dbPath)&&samePath(record.financeContext?.sourceRoot,opts.sourceRoot)&&samePath(record.financeContext?.auditDir,root)&&samePath(call.end.metadata?.configuredTarget?.databasePath,opts.dbPath);
 if(!configuredScope)fail('finance_baseline_adaptation_scope_unverified');
 try{
  request=JSON.parse(read(join(runDir,'request.json'),record.request));
  const scriptName='script.'+(record.engine==='python'?'py':record.engine==='javascript'?'mjs':'invalid');
  const script=read(join(runDir,scriptName),record.script);
  input=JSON.parse(read(join(runDir,'input.json'),record.input));
  if(!same(request,call.input)||script.toString('utf8')!==request.script||request.engine!==record.engine||!same(input.parameters,request.parameters??{})||!same(input.financeContext,record.financeContext))fail('finance_baseline_adaptation_record_invalid');
 }catch(error){if(error.code)throw error;fail('finance_baseline_adaptation_record_invalid');}
 const sourceCount=record.sources.length;
 const inputsBound=Array.isArray(input.sources)&&input.sources.length===sourceCount&&Array.isArray(request.sources)&&request.sources.length===sourceCount;
 const sourcesUnchanged=Array.isArray(record.sourceChecks)&&record.sourceChecks.length===sourceCount&&record.sourceChecks.every(s=>s.sourceUnchanged===true&&s.snapshotUnchanged===true);
 const executionInputsUnchanged=Array.isArray(record.executionFileChecks)&&record.executionFileChecks.length===2&&record.executionFileChecks.every(s=>s.unchanged===true);
 if(!inputsBound||!sourcesUnchanged||!executionInputsUnchanged)fail('finance_baseline_adaptation_execution_unverified');
 const selected=record.outputs.find(o=>o.path===reference.output),resultOutput=result.outputs?.find(o=>samePath(o.path,join(runDir,'outputs',reference.output)));
 if(!descriptor(selected)||selected.kind!=='derived_calculation'||!resultOutput||selected.sha256!==resultOutput.sha256||selected.bytes!==resultOutput.bytes)fail('finance_baseline_adaptation_output_missing');
 try{output=JSON.parse(read(join(runDir,'outputs',reference.output),selected,{max:512*1024}));}
 catch(error){if(error.code)throw error;fail('finance_baseline_adaptation_output_invalid');}
 if(validateSchemaValue(BASELINE_ADAPTATION_SCHEMA,output).length)fail('finance_baseline_adaptation_output_invalid');
 if(new Set(output.rows.map(row=>row.id)).size!==output.rows.length)fail('finance_baseline_adaptation_output_invalid');
 // 每次重用都核实际原件与计算采用的副本，不能拿同名新文件或任意路径替换获准来源。
 const sourceIndices=new Set(output.rows.map(row=>row.sourceIndex)),sources=[],sourceDependencies=[];
 if([...sourceIndices].some(index=>index>=record.sources.length)||request.sources.some(source=>!source.originalRef||source.path))fail('finance_baseline_adaptation_source_unbound');
 let resolved;
 try{resolved=resolveBaselineSourceReferences(request.sources,opts);}
 catch{fail('finance_baseline_adaptation_source_unbound');}
 for(const [index,source]of record.sources.entries()){
  const adopted=input.sources[index],requestSource=resolved[index];
  const sourceBound=source?.kind==='source_snapshot'&&samePath(source.path,requestSource.path)&&source.originalRef===requestSource.originalRef&&baselineInside(opts.sourceRoot,source.path);
  const snapshotBound=sourceBound&&adopted?.index===index&&adopted.sha256===source.sha256&&samePath(adopted.snapshotPath,source.snapshotPath)&&samePath(source.snapshotPath,join(runDir,'sources',String(index)+extname(source.path).toLowerCase()));
  if(!snapshotBound)fail('finance_baseline_adaptation_source_unbound');
  let bytes;
  try{bytes=baselineBytes(source.path,opts.sourceRoot);}
  catch{fail('finance_baseline_adaptation_source_unavailable');}
  if(sha(bytes)!==source.sha256||bytes.length!==source.bytes)fail('finance_baseline_adaptation_source_changed');
  read(source.snapshotPath,{sha256:source.sha256,bytes:source.bytes});
  sourceDependencies.push({path:source.path,sha256:source.sha256,bytes:source.bytes});
  if(sourceIndices.has(index))sources.push({...source,index,originalRef:requestSource.originalRef});
 }
 for(const name of ['begin.json','input.json','end.json','result.json'])read(join(call.recordPath,name),undefined,{max:20*1024*1024});
 return {rows:output.rows,sources,provenance:{kind:'recorded_local_script_observation',callId:reference.callId,runId,output:reference.output,recordRoot:root,recordRootIdentity:baselineDirectoryIdentity(root),artifacts,sourceDependencies,authority:'not_native_verification_or_ledger_posting_or_operator_decision'}};
}
