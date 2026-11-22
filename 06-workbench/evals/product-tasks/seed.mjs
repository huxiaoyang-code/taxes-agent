import {existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {startBackend} from '../../test/helpers/business-memory-e2e-fixture.mjs';
import {layout,read,save,sha} from './fixture.mjs';
import {operatorStage,seedBank} from './bank.mjs';
import {seedVat} from './vat.mjs';

const [task,dir,option]=process.argv.slice(2);
if(!dir||!['bank','vat-selection','handoff','operator'].includes(task))throw Error('用法：node seed.mjs bank|vat-selection|handoff <全新目录> [--keep-backend]，或 operator <现有目录> preview|import|confirm|readback');
if(task==='operator'){
  console.log(JSON.stringify(await operatorStage(read(join(resolve(dir),'reviewer','fixture.json')),option)));
} else {
  const f=layout(dir,task);
  const {child,apiBase}=await startBackend({...f,sourceB:f.source,auditB:f.audit});
  try{
    f.apiBase=apiBase;
    if(task==='bank')await seedBank(f);else await seedVat(f);
    save(join(f.reviewer,'原件指纹.json'),Object.fromEntries(readdirSync(f.source).map(name=>[name,sha(join(f.source,name))])));
    save(join(f.reviewer,'fixture.json'),f);
    const stop=join(f.reviewer,'stop-backend.flag');
    console.log(JSON.stringify({task,host:f.host,source:f.source,reviewer:f.reviewer,stop,backendKept:option==='--keep-backend'}));
    if(option==='--keep-backend'){
      const timer=setInterval(()=>{if(existsSync(stop))child.kill();},500);
      try{await new Promise(resolve=>child.once('exit',resolve));}finally{clearInterval(timer);}
    }
  }finally{child.kill();}
}
