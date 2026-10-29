// Capture native task evidence only. Independent assessment is not in the
// candidate source stage and runs in a separate trusted namespace.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {inspectHarness} from '../server/harness-runtime.mjs';
const run=process.argv[2],root=join(run,'synthetic'),{scope}=JSON.parse(readFileSync(join(root,'synthetic.json'),'utf8'));
const view=await inspectHarness(join(root,'harness-store'));
const task=view.tasks.find(t=>t.taskId==='inspect-period')??null;
writeFileSync(join(run,'deliverable.json'),JSON.stringify({version:'finance-harness2-deliverable/1',synthetic:true,mode:'model',scope,task,modelInvoked:true,businessComplete:false}),{flag:'wx'});
console.log(JSON.stringify({status:'native_evidence_captured'}));
