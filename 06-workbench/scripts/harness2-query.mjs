import {inspectHarness} from '../server/harness-runtime.mjs';
import {join} from 'node:path';
const view=await inspectHarness(join(process.argv[2],'synthetic/harness-store'));
const task=view.tasks.find(t=>t.taskId==='inspect-period');
console.log(JSON.stringify({status:'queried',operationState:task?.operationState??task?.executionState??'not_executed',resultCurrent:task?.resultCurrent??null,confirmationCurrent:task?.confirmationCurrent??null,executionState:task?.executionState??'pending',reviewState:task?.reviewState??'pending',businessComplete:false}));
