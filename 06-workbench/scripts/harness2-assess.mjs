// 独立证据检查。流程完成与模型质量分别判断。
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function evaluateNativeEvidence({receipt,scope,target,view}){
  const task=view.tasks?.find(t=>t.taskId==='inspect-period');
  const scopeCurrent=view.scope&&['enterpriseKey','accountSetId','databaseInstanceId','period','currency'].every(key=>view.scope[key]===scope[key]);
  const binding=scopeCurrent&&target.databaseInstanceId===scope.databaseInstanceId&&target.accountSets.length===1&&target.accountSets[0].enterpriseKey===scope.enterpriseKey&&target.accountSets[0].accountSetId===scope.accountSetId;
  const nativeTerminated=receipt.exitCode===0&&receipt.reason===null;
  const executionVerified=Boolean(binding&&nativeTerminated&&receipt.status==='native_task_executed'&&task?.capabilityId==='period.inspect'&&task.executionState==='executed'&&task.resultCurrent===true&&task.confirmationCurrent===false&&task.reviewState==='pending');
  return {pass:executionVerified,synthetic:true,mode:receipt.modelInvoked===true?'model':receipt.modelInvoked===false?'synthetic-native':'unknown',executionVerified,nativeTerminated,innerErrorCount:receipt.innerErrorCount??null,nativeStatus:receipt.nativeStatus??null,zeroObservedErrors:receipt.innerErrorCount===0,reviewAccepted:task?task.reviewState==='accepted':null,businessComplete:false,qualityVerified:false,modelQualityVerified:false,heldoutVerified:false};
}
export async function assessNativeRun(root){
  const base=process.env.FINANCE_HARNESS2_ASSESS_REPO?pathToFileURL(join(process.env.FINANCE_HARNESS2_ASSESS_REPO,'06-workbench/server/')):new URL('../server/',import.meta.url);
  const {inspectHarness}=await import(new URL('harness-runtime.mjs',base));
  const {discoverHarnessTarget}=await import(new URL('harness-target.mjs',base));
  const receipt=JSON.parse(readFileSync(join(root,'receipt.json'),'utf8'));
  const synthetic=join(root,'synthetic'),{scope}=JSON.parse(readFileSync(join(synthetic,'synthetic.json'),'utf8'));
  const target=await discoverHarnessTarget(join(synthetic,'data/workbench.db'));
  const view=await inspectHarness(join(synthetic,'harness-store'));
  return evaluateNativeEvidence({receipt,scope,target,view});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await assessNativeRun(process.argv[2])));
