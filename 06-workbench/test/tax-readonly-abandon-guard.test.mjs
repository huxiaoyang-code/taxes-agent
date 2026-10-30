// 仅对 Windows 操作系统互斥量做冒烟测试：随机合成身份，无注册表、配置目录、
// 端点或税务数据。被终止进程是本测试自己的 Node 工作进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireReadonlyAdminGuard} from '../server/tax-readonly-abandon.mjs';

if(process.argv[2]==='--synthetic-hold-guard'){
  const guard=await acquireReadonlyAdminGuard(process.argv[3]);
  process.stdout.write(JSON.stringify({held:true,helperPid:guard.helperPid})+'\n');
  // 父进程刻意终止此工作进程。不设清理
  // 处理器：辅助进程必须自行观测死亡工作进程的 stdin 管道 EOF。
  setInterval(()=>{},1000);
}else{
  test('Windows restricted global admin mutex excludes competition and releases on host death via pipe EOF',
    {skip:process.platform!=='win32',timeout:20000},async()=>{
      const identity=join(tmpdir(),'youshu-abandon-synthetic-'+randomBytes(24).toString('hex'));
      let worker,first,third,helperPid;
      const alive=pid=>{try{process.kill(pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}};
      try{
        first=await acquireReadonlyAdminGuard(identity);first.verify();
        await assert.rejects(acquireReadonlyAdminGuard(identity));await first.close();first=null;
        worker=spawn(process.execPath,[fileURLToPath(import.meta.url),'--synthetic-hold-guard',identity],
          {shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let text='';const held=await new Promise((yes,no)=>{
          const timer=setTimeout(()=>no(Error('synthetic_worker_timeout')),7000);
          worker.once('error',()=>{clearTimeout(timer);no(Error('synthetic_worker_failed'))});
          worker.once('exit',()=>{clearTimeout(timer);no(Error('synthetic_worker_exited'))});
          worker.stdout.on('data',b=>{text+=String(b);if(text.includes('\n')){clearTimeout(timer);yes(JSON.parse(text.trim()))}});
        });
        assert.equal(held.held,true);helperPid=held.helperPid;assert.equal(alive(helperPid),true);
        await assert.rejects(acquireReadonlyAdminGuard(identity));
        const exited=new Promise(done=>worker.once('exit',done));worker.kill();await exited;worker=null;
        // 宿主死亡后获取锁，以验证实际生产辅助进程的 EOF
        // 行为。通过路径不直接终止辅助进程。
        const deadline=Date.now()+6000;
        while(Date.now()<deadline){try{third=await acquireReadonlyAdminGuard(identity);break}catch{await new Promise(done=>setTimeout(done,50))}}
        assert.ok(third,'dead host must release its OS mutex');third.verify();
        while(alive(helperPid)&&Date.now()<deadline)await new Promise(done=>setTimeout(done,50));
        assert.equal(alive(helperPid),false,'EOF must end the orphaned helper');
        await third.close();third=null;
        const final=await acquireReadonlyAdminGuard(identity);await final.close();
      }finally{
        worker?.kill();await first?.close();await third?.close();
        // 工作进程死亡会关闭辅助进程管道。所有者消失后绝不
        // 以数字 PID 为目标，因为该 PID 可能已被复用。
      }
    });
}
