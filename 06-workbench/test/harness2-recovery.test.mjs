import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {prepare,dispatch} from '../../05-reconstruction/codex/harness2/bridge.mjs';
import {registerHarnessSource,registerHarnessFacts,planHarness,inspectHarness,runHarnessTask} from '../server/harness-runtime.mjs';
mkdirSync(resolve('.agent-runs'),{recursive:true});const root=mkdtempSync(resolve('.agent-runs/harness2-recovery-'));
const experiment=join(root,'experiment');await prepare({root:experiment});
const packageRoot=join(root,'incomplete-pi');mkdirSync(join(packageRoot,'dist/bundle'),{recursive:true});writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0'}));writeFileSync(join(packageRoot,'dist/bundle/cli.js'),'');
const request={version:'finance-harness2-request/1',root:experiment,host:'pi',runId:'original',action:'execute',executionMode:'synthetic-native',packageRoot};
const failed=await dispatch(request);assert.equal(failed.status,'native_failed');assert.equal(failed.operationState,'unknown');assert.equal(failed.resultCurrent,null);assert.equal(failed.confirmationCurrent,null);
// Reconstruct a committed native result whose host response/capture was lost.
// Query must inspect this Store, rather than replaying the failed static receipt.
const run=join(experiment,'runs/original'),synthetic=join(run,'synthetic'),{scope}=JSON.parse(readFileSync(join(synthetic,'synthetic.json'),'utf8')),store=join(synthetic,'harness-store');
const target={dbPath:join(synthetic,'data/workbench.db'),databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey,accountSetId:scope.accountSetId};
const source=join(synthetic,'period-request.json');writeFileSync(source,JSON.stringify({target}));
await registerHarnessSource(store,{sourceId:'synthetic-request',path:source,locator:'Synthetic persisted request',classification:'synthetic',parsed:false,unrecognized:[]});
await registerHarnessFacts(store,[{factId:'request',state:'provided',sourceRefs:['synthetic-request'],reason:'Synthetic persisted request',value:{target}}]);
await planHarness(store,[{taskId:'inspect-period',capabilityId:'period.inspect',factIds:['request'],requestFactId:'request',dependsOn:[],goal:'Synthetic native query recovery'}]);
const view=await inspectHarness(store);await runHarnessTask(store,{taskId:'inspect-period',phase:'execute',dependencyDigest:view.tasks[0].dependencyDigest});
const queried=await dispatch({...request,action:'query'});assert.equal(queried.status,'queried');assert.equal(queried.operationState,'executed');assert.equal(queried.resultCurrent,true);assert.equal(queried.confirmationCurrent,false);assert.equal(queried.priorReceiptStatus,'native_failed');
const baseline=join(experiment,'baseline/SKILL.md');writeFileSync(baseline,'Changed baseline');await assert.rejects(dispatch({...request,action:'query'}),{code:'harness2_baseline_changed'});
console.log('harness2-recovery: crashed native host is unknown; original run query reads actual committed Store and preserves pending review; modified baseline refuses reuse');
