// 全套程序校准。空白态须失败，产品真实操作后须通过，完整逐项结果写在各自 reviewer。
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {read} from './fixture.mjs';

const scripts=fileURLToPath(new URL('.',import.meta.url));
if(!process.argv[2])throw Error('用法：node calibrate.mjs <全新合成目录> [Python可执行文件]');
const output=resolve(process.argv[2]),python=process.argv[3]??'python';
mkdirSync(output);
for(const task of ['bank','vat-selection','handoff']){
  const root=join(output,task),reviewer=join(root,'reviewer');
  const service=spawn(process.execPath,[join(scripts,'seed.mjs'),task,root,'--keep-backend'],{stdio:['ignore','pipe','inherit'],windowsHide:true});
  const stopped=once(service,'exit');
  try{
    let ready=false;
    for await(const line of createInterface({input:service.stdout})){
      if(JSON.parse(line).backendKept){ready=true;break;}
    }
    assert(ready,'合成后端未就绪');
    const score=(name,expected)=>{
      const path=join(reviewer,name+'.json');
      const run=spawnSync(python,[join(scripts,'score.py'),root,'--output',path],{windowsHide:true,encoding:'utf8',timeout:60000});
      if(run.error)throw run.error;
      const result=read(path);
      assert.equal(run.status,expected?0:1,JSON.stringify(result.checks.filter(r=>!r.passed))+' '+run.stderr);
      assert.equal(result.passed,expected);
      return result.checks.length;
    };
    const empty=score('办理前评分',false);
    const run=spawnSync(process.execPath,[join(scripts,'replay.mjs'),root],{windowsHide:true,encoding:'utf8',timeout:120000});
    assert.equal(run.status,0,run.stderr);
    const completed=score('办理后评分',true);
    console.log(JSON.stringify({task,emptyChecks:empty,completedChecks:completed,modelInvoked:false,reviewer}));
  }finally{
    if(service.exitCode===null){
      try{writeFileSync(join(reviewer,'stop-backend.flag'),'');}catch{service.kill();}
    }
    await stopped;
  }
}
