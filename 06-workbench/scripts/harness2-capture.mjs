// 仅采集原生任务证据。独立评估不在
// 候选源码阶段内运行，而在另一个可信命名空间中运行。
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {inspectHarness} from '../server/harness-runtime.mjs';
const run=process.argv[2],root=join(run,'synthetic'),{scope}=JSON.parse(readFileSync(join(root,'synthetic.json'),'utf8'));
const view=await inspectHarness(join(root,'harness-store'));
const task=view.tasks.find(t=>t.taskId==='inspect-period')??null;
writeFileSync(join(run,'deliverable.json'),JSON.stringify({version:'finance-harness2-deliverable/1',synthetic:true,mode:'model',scope,task,modelInvoked:true,businessComplete:false}),{flag:'wx'});
console.log(JSON.stringify({status:'native_evidence_captured'}));
