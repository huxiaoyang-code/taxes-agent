// 验收者从另一个工作区和进程读回交接。仅使用受测 Agent 已交出的操作号。
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {bind,read,save,sha,stdio} from './fixture.mjs';
import {next,targetPeriod} from './vat.mjs';

const [dir,callId]=process.argv.slice(2);
if(!dir||!callId)throw Error('用法：node verify-handoff.mjs <合成目录> <交接操作号>');
const f=read(join(resolve(dir),'reviewer','fixture.json'));
assert.equal(f.task,'handoff');
const successor=bind(f,'交接验证-'+randomUUID(),next);
const out=await stdio(f,call=>call('finance_period_review',{target:{accountSetId:f.accountSetId,period:next},precedingPlanPeriod:targetPeriod,callIds:[callId]}),successor);
const record=out.records.find(r=>r.callId===callId);
assert.equal(record?.artifactIntegrity,'verified');
assert.equal(record?.planning?.reportPath,join(f.audit,callId,'vat-handoff.html'));
const receipt={callId,successor,reportPath:record.planning.reportPath,reportSha:sha(record.planning.reportPath),artifactIntegrity:record.artifactIntegrity};
save(join(f.reviewer,'交接验证-'+callId+'.json'),receipt);
console.log(JSON.stringify(receipt));
