// Independent local check of native evidence. No model, accounting approval or
// heldout answer is supplied to the candidate execution process.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=process.env.FINANCE_HARNESS2_ASSESS_REPO?pathToFileURL(join(process.env.FINANCE_HARNESS2_ASSESS_REPO,'06-workbench/server/')):new URL('../server/',import.meta.url);
const {inspectHarness}=await import(new URL('harness-runtime.mjs',base));
const {discoverHarnessTarget}=await import(new URL('harness-target.mjs',base));
const root=process.argv[2],receipt=JSON.parse(readFileSync(join(root,'receipt.json'),'utf8'));
const synthetic=join(root,'synthetic'),{scope}=JSON.parse(readFileSync(join(synthetic,'synthetic.json'),'utf8'));
const target=await discoverHarnessTarget(join(synthetic,'data/workbench.db'));
const view=await inspectHarness(join(synthetic,'harness-store')),task=view.tasks.find(t=>t.taskId==='inspect-period');
const binding=target.databaseInstanceId===scope.databaseInstanceId&&target.accountSets.length===1&&target.accountSets[0].enterpriseKey===scope.enterpriseKey&&target.accountSets[0].accountSetId===scope.accountSetId;
const executionVerified=binding&&receipt.status==='native_task_executed'&&task?.capabilityId==='period.inspect'&&task.executionState==='executed'&&task.resultCurrent===true&&task.confirmationCurrent===false&&task.reviewState==='pending';
const pass=executionVerified&&receipt.innerErrorCount===0;
console.log(JSON.stringify({pass,synthetic:true,mode:'synthetic-native',executionVerified,innerErrorCount:receipt.innerErrorCount??null,nativeStatus:receipt.nativeStatus??null,reviewAccepted:false,businessComplete:false,modelQualityVerified:false,heldoutVerified:false}));
