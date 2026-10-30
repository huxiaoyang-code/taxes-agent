import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, unlink, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {withFinanceCall,currentFinanceCall,annotateFinanceCall,listFinanceCalls,readFinanceCall,verifyFinanceCalls} from '../server/finance-call-chain.mjs';

const temp = () => mkdtemp(join(tmpdir(),'finance-calls-synthetic-'));
test('调用结果原样返回，自动保留输入结果与范围，不要求任务登记', async()=>{
  const auditDir=await temp(), result={amount:'26.01',ruleVersion:'synthetic/1',codeDigest:'synthetic-code'};
  let reference;
  assert.equal(await withFinanceCall({auditDir,tool:'synthetic',args:{scope:{accountSetId:1},amount:'26.01'}},async()=>{reference=currentFinanceCall();return result;}),result);
  const record=await readFinanceCall({auditDir,callId:reference.callId});
  assert.equal(record.status,'returned');assert.equal(record.integrity,'verified');assert.deepEqual(record.output,result);
  assert.equal(record.begin.scope.accountSetId,1);assert.equal(record.end.ruleVersion,'synthetic/1');assert.equal(currentFinanceCall(),null);
  assert.equal((await verifyFinanceCalls({auditDir})).success,true);
});
test('每次并发及嵌套调用都有独立记录，父子关系由程序绑定',async()=>{
  const auditDir=await temp();
  await Promise.all(Array.from({length:12},(_,i)=>withFinanceCall({auditDir,tool:'parent',args:{i}},async()=>{
    const parent=currentFinanceCall().callId;
    return withFinanceCall({auditDir,tool:'child',args:{i}},async()=>({i,parent}));
  })));
  const index=await listFinanceCalls({auditDir});assert.equal(index.total,24);assert.equal(new Set(index.calls.map(c=>c.callId)).size,24);
  for(const row of index.calls.filter(c=>c.tool==='child')){const c=await readFinanceCall({auditDir,callId:row.callId});assert.equal(c.begin.parentCallId,c.output.parent);}
});
test('业务错误保存原始诊断并保持原异常，不把失败当成功',async()=>{
  const auditDir=await temp(), error=Object.assign(Error('specific_field_invalid'),{code:'field_invalid',details:{field:'separatelyStatedVat'}});
  await assert.rejects(withFinanceCall({auditDir,tool:'synthetic',args:{separatelyStatedVat:'13000'}},async()=>{throw error;}),e=>e===error);
  const index=await listFinanceCalls({auditDir}),record=await readFinanceCall({auditDir,callId:index.calls[0].callId});
  assert.equal(record.status,'failed');assert.equal(record.output.code,'field_invalid');assert.equal(record.output.details.field,'separatelyStatedVat');
});
test('输入及结果中的认证字段和Bearer值不落盘，业务原值仍在本机记录',async()=>{
  const auditDir=await temp();await withFinanceCall({auditDir,tool:'synthetic',args:{amount:'26.01',apiKey:'sensitive-synthetic',nested:{authorization:'Bearer synthetic'}}},async()=>({amount:'26.01',password:'hidden',message:'Bearer hidden'}));
  const index=await listFinanceCalls({auditDir}),record=await readFinanceCall({auditDir,callId:index.calls[0].callId});
  assert.equal(record.input.amount,'26.01');assert.equal(JSON.stringify(record).includes('sensitive-synthetic'),false);assert.equal(JSON.stringify(record).includes('Bearer hidden'),false);
});
test('原件变化和结果文件篡改可定位，哈希不等于业务正确',async()=>{
  const auditDir=await temp(),source=join(auditDir,'synthetic-original.txt');await writeFile(source,'synthetic before');
  let reference;await withFinanceCall({auditDir,tool:'synthetic',args:{},sources:[{path:source,locator:'line 1'}]},async()=>{reference=currentFinanceCall();await writeFile(source,'synthetic after');return {amount:'1.00'};});
  let record=await readFinanceCall({auditDir,callId:reference.callId});assert.equal(record.end.sourceChanges.length,1);assert.deepEqual(record.changedSources,[source]);
  await writeFile(join(reference.recordPath,'result.json'),JSON.stringify({amount:'9.00'}));
  record=await readFinanceCall({auditDir,callId:reference.callId});assert.equal(record.integrity,'changed');assert.ok(record.problems.includes('output_digest_mismatch'));
  await unlink(join(reference.recordPath,'result.json'));record=await readFinanceCall({auditDir,callId:reference.callId});assert.ok(record.problems.includes('output_missing'));
});
test('业务执行后日志写失败不暗示可以重复写账',async()=>{
  const auditDir=await temp();let executions=0;
  await assert.rejects(withFinanceCall({auditDir,tool:'synthetic_write',args:{}},async()=>{executions++;await writeFile(join(currentFinanceCall().recordPath,'result.json'),'collision');return {committed:true};}),e=>e.code==='finance_call_recording_failed'&&e.executionCompleted===true&&e.retryable===false&&e.writeOutcome==='unknown');
  assert.equal(executions,1);assert.equal((await listFinanceCalls({auditDir})).calls[0].status,'incomplete');
});
test('进程在执行中退出会留下可核查的incomplete，不伪造完成',async()=>{
  const auditDir=await temp(),moduleUrl=new URL('../server/finance-call-chain.mjs',import.meta.url).href;
  const script=`import {withFinanceCall} from ${JSON.stringify(moduleUrl)}; await withFinanceCall({auditDir:${JSON.stringify(auditDir)},tool:'synthetic_crash',args:{}},async()=>process.exit(17));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true,encoding:'utf8'});assert.equal(child.status,17,child.stderr);
  const index=await listFinanceCalls({auditDir});assert.equal(index.total,1);assert.equal(index.calls[0].status,'incomplete');assert.equal((await verifyFinanceCalls({auditDir})).success,false);
});
test('非法原件字段也进入失败记录，不在开始记录之前发生遍历错误',async()=>{
  const auditDir=await temp();await assert.rejects(withFinanceCall({auditDir,tool:'synthetic',args:{originals:{bad:'not an array'}}},async()=>{throw Error('originals_array_required');}),/originals_array_required/);
  const index=await listFinanceCalls({auditDir});assert.equal(index.total,1);assert.equal(index.calls[0].status,'failed');
});
test('已保存JSON不能把原始输入或输出读取重定向到其他路径',async()=>{
  const auditDir=await temp();await withFinanceCall({auditDir,tool:'synthetic',args:{}},async()=>({amount:'1'}));
  const index=await listFinanceCalls({auditDir}),row=index.calls[0],path=join(row.recordPath,'begin.json'),begin=JSON.parse(await readFile(path,'utf8'));
  begin.input.file='../outside.json';await writeFile(path,JSON.stringify(begin));await assert.rejects(readFinanceCall({auditDir,callId:row.callId}),/finance_call_binding_invalid/);
});
test('记录目录父级链接拒绝，不能经别名目录读取或写入记录',async t=>{
  const root=await temp(),outside=await temp(),alias=join(root,'alias');
  try { await symlink(outside,alias,process.platform==='win32'?'junction':'dir'); }
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('当前环境无目录链接权限');return;}throw error;}
  await assert.rejects(withFinanceCall({auditDir:join(alias,'calls'),tool:'synthetic',args:{}},async()=>({})),/finance_call_path_invalid/);
});
test('传输返回不冒充业务成功，嵌套规则和原生元数据被保留',async()=>{
  const auditDir=await temp();
  await withFinanceCall({auditDir,tool:'synthetic_envelope',args:{}},async()=>({ok:false,version:'synthetic'}));
  await withFinanceCall({auditDir,tool:'synthetic_partial',args:{}},async()=>{annotateFinanceCall({scope:{accountSetId:3},ruleVersion:'native/1',codeDigest:'native-code',artifactRefs:['local:synthetic'],nativeOperationId:'native-id-from-header',configuredTarget:{databasePath:'synthetic.db',apiBase:'http://127.0.0.1:12345',verification:'configured_only_not_runtime_proof'}});return {status:'partial',rules:{ruleVersion:'projected/1',catalogDigest:'catalog'}};});
  const index=await listFinanceCalls({auditDir}),failed=await readFinanceCall({auditDir,callId:index.calls.find(c=>c.tool==='synthetic_envelope').callId});
  assert.equal(failed.status,'failed');assert.equal(failed.end.businessOutcome,'failed');assert.equal(failed.end.codeVersionState,'unknown');
  const partial=await readFinanceCall({auditDir,callId:index.calls.find(c=>c.tool==='synthetic_partial').callId});
  assert.equal(partial.end.businessOutcome,'partial');assert.equal(partial.end.ruleVersion,'native/1');assert.equal(partial.end.codeDigest,'native-code');assert.equal(partial.end.scope.accountSetId,3);assert.equal(partial.end.catalogDigest,'catalog');
  assert.equal(partial.end.nativeOperationId,'native-id-from-header');assert.equal(partial.end.metadata.configuredTarget.databasePath,'synthetic.db');
});
test('年度manifestPaths数组自动进入本机来源观察',async()=>{
  const auditDir=await temp(),manifest=join(auditDir,'synthetic-month.json');await writeFile(manifest,'{"synthetic":true}');
  await withFinanceCall({auditDir,tool:'synthetic_annual',args:{manifestPaths:[manifest]}},async()=>({status:'partial'}));
  const row=(await listFinanceCalls({auditDir})).calls[0],record=await readFinanceCall({auditDir,callId:row.callId});assert.equal(record.begin.sources[0].path,manifest);assert.equal(record.begin.sources[0].locator,'annual_manifest');
});
test('仅声明的scope不升级为已观察范围，原生注入的范围才用于索引',async()=>{
  const auditDir=await temp();
  await assert.rejects(withFinanceCall({auditDir,tool:'synthetic_rejected_scope',args:{scope:{accountSetId:999}}},async()=>{throw Error('scope_rejected');}),/scope_rejected/);
  const row=(await listFinanceCalls({auditDir})).calls[0];assert.equal(row.scopeState,'provided');assert.equal(row.scope.accountSetId,999);
});
async function nativeManifestFixture(auditDir,month){
  const period='2026-'+String(month).padStart(2,'0'),original=join(auditDir,'original-'+month+'.json'),facts=join(auditDir,'facts-'+month+'.json'),manifest=join(auditDir,'manifest-'+month+'.json');
  const scope={enterpriseKey:'SYNTHETIC-CALL-RECORD',accountSetId:1,databaseInstanceId:'synthetic-call-record-instance',period,currency:'CNY'};
  const entity={kind:'company',industry:'trade',profileId:'small-2011-basic-v1',businessStartDate:'2026-01-01',vatStatus:'general',vatPeriod:'monthly',vatReliefWaived:false,incomeLevyMethod:'actual_accounts',bookkeepingMethod:'double_entry'};
  await writeFile(original,JSON.stringify({synthetic:true,entity}));
  await writeFile(facts,JSON.stringify({version:'agency-raw-facts/1',scope,records:[{id:'entity-'+month,type:'entity',date:'2026-01-01',enterpriseKey:scope.enterpriseKey,entity,originalRefs:[{originalId:'original',locator:'/entity',extractionReason:'合成原件主体字段'}]}]}));
  await writeFile(manifest,JSON.stringify({version:'agency-business-materials/1',scope,originals:[{id:'original',path:original}],sources:[{path:facts}]}));
  return {manifest,original,facts};
}
test('真实原生manifest加载记录覆盖原件与整理文件，事后变化不掩盖保存快照',async()=>{
  const {loadAgencyEvidence}=await import('../server/agency-business-evidence.mjs');
  const auditDir=await temp(),fixture=await nativeManifestFixture(auditDir,3);let id;
  await withFinanceCall({auditDir,tool:'synthetic_native_manifest',args:{manifestPath:fixture.manifest}},async()=>{
    id=currentFinanceCall().callId;const session=loadAgencyEvidence(fixture.manifest);
    annotateFinanceCall({scope:session.scope,sources:session.sourceRefs.map(ref=>({path:ref.locator,locator:'native_file',sha256:ref.digest}))});return {status:'partial'};
  });
  await writeFile(fixture.original,'{"synthetic":"changed original"}');await writeFile(fixture.facts,'{"synthetic":"changed facts"}');
  const record=await readFinanceCall({auditDir,callId:id});assert.equal(record.integrity,'verified');assert.equal(record.sourceCurrentness,'changed');
  assert.ok(record.changedSources.includes(fixture.original));assert.ok(record.changedSources.includes(fixture.facts));assert.equal(record.end.loadedSources.length,3);
  const verify=await verifyFinanceCalls({auditDir});assert.equal(verify.recordIntegrityVerified,true);assert.equal(verify.success,false);assert.equal(verify.sourcesChanged,1);
});
test('年度各月实际加载证据累计观察，首月原件变化不会被末月覆盖',async()=>{
  const {loadAgencyEvidence}=await import('../server/agency-business-evidence.mjs');
  const auditDir=await temp(),fixtures=await Promise.all(Array.from({length:12},(_,i)=>nativeManifestFixture(auditDir,i+1)));let id;
  await withFinanceCall({auditDir,tool:'synthetic_native_annual',args:{manifestPaths:fixtures.map(f=>f.manifest)}},async()=>{
    id=currentFinanceCall().callId;
    for(const fixture of fixtures){const session=loadAgencyEvidence(fixture.manifest);annotateFinanceCall({sources:session.sourceRefs.map(ref=>({path:ref.locator,locator:'native_month_file',sha256:ref.digest}))});}
    return {status:'partial'};
  });
  await writeFile(fixtures[0].original,'{"synthetic":"first month changed"}');
  const record=await readFinanceCall({auditDir,callId:id});assert.equal(record.begin.sources.length,12);assert.equal(record.end.loadedSources.length,36);
  assert.deepEqual(record.changedSources,[fixtures[0].original]);assert.equal(record.sourceCurrentness,'changed');assert.ok(record.end.sourcesAfter.every(source=>source.state==='observed'));
});
