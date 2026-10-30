import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,cpSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest,inspectSurface,cleanEnvironment,childPath,fail,HOSTS,UPSTREAM_COMMIT} from './surface.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const marker='experiment.json';
function save(path,value){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
function assertPlainTree(root){if(lstatSync(root).isSymbolicLink())fail('harness2_link_forbidden');for(const name of readdirSync(root)){const p=join(root,name),s=lstatSync(p);if(s.isSymbolicLink()||(!s.isDirectory()&&(!s.isFile()||s.nlink!==1)))fail('harness2_link_forbidden');if(s.isDirectory())assertPlainTree(p);}}
export function treeDigest(root,{exclude=[]}={}){assertPlainTree(root);const parts=[];function visit(dir,prefix=''){for(const n of readdirSync(dir).sort()){const p=join(dir,n),key=prefix+n;if(exclude.includes(key))continue;if(lstatSync(p).isDirectory())visit(p,key+'/');else parts.push([key,digest(readFileSync(p))]);}}visit(root);return digest(JSON.stringify(parts));}
function runtimeDigest(){
  const roots=['06-workbench/server','06-workbench/scripts','05-reconstruction/codex/mcp','05-reconstruction/codex/pi','05-reconstruction/codex/hosts','05-reconstruction/codex/skills'];
  const core=join(repo,'05-reconstruction/codex/harness2'),coreFiles=[];
  const visit=(dir,prefix='')=>{for(const name of readdirSync(dir).sort()){if(name==='__pycache__')continue;const p=join(dir,name),rel=prefix+name;if(lstatSync(p).isSymbolicLink())fail('harness2_link_forbidden');if(lstatSync(p).isDirectory())visit(p,rel+'/');else coreFiles.push([rel,digest(readFileSync(p))]);}};visit(core);
  let stage=null;if(existsSync(join(repo,'stage.json'))){stage=JSON.parse(readFileSync(join(repo,'stage.json'),'utf8'));if(stage.version!=='finance-harness2-stage/1'||stage.sourceDigest!==treeDigest(repo,{exclude:['stage.json']}))fail('harness2_stage_changed');}
  const hostStage=process.platform==='linux'&&existsSync('/host')?treeDigest('/host'):null;
  return digest(JSON.stringify([...roots.map(name=>[name,treeDigest(join(repo,name))]),['core',coreFiles],['nodeVersion',process.version],['nodeExecutable',digest(readFileSync(process.execPath))],['hostStage',hostStage],['stage',stage?.sourceDigest??null],['05-reconstruction/catalog.json',digest(readFileSync(join(repo,'05-reconstruction/catalog.json')))]]));
}
export async function nativeSummary(stdout){
  const {inspectEvent}=await import('./hosts/native-runner.mjs');let status=null,count=0,reported=null;
  for(const line of stdout.split('\n')){try{const event=JSON.parse(line);if(event.type==='host_result'){status=typeof event.status==='string'&&/^[a-z_]{1,80}$/.test(event.status)?event.status:'unknown';if(Number.isSafeInteger(event.innerErrorCount)&&event.innerErrorCount>=0)reported=event.innerErrorCount;}else count+=inspectEvent(event).length;}catch{}}
  return {nativeStatus:status??(count?'completed_with_tool_errors':'unreported'),innerErrorCount:reported??count};
}
export async function stopChild(child,{platform=process.platform,taskkill=spawnSync}={}){
  if(!child?.pid)return;
  if(platform==='win32'){
    if(child.exitCode===null&&child.signalCode===null){
      let result;try{result=taskkill(join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/pid',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore',timeout:5000});}catch{}
      // Windows 沙箱可能拒绝 taskkill 终止本进程拥有的子进程，此时直接终止
      // 已确认归属的该进程，不据此声称未观察到的整棵进程树均已退出。
      if(result?.status!==0)try{child.kill('SIGKILL');}catch{}
      if(child.exitCode===null&&child.signalCode===null){
        const ended=await new Promise(ok=>{const timer=setTimeout(()=>{child.removeListener('exit',exit);ok(false);},2000);const exit=()=>{clearTimeout(timer);ok(true);};child.once('exit',exit);});
        if(!ended){child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();child.unref();fail('harness2_direct_child_termination_unverified');}
      }
      child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
    }
  }
  else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
}
export async function boundedSpawn(spec,{timeoutMs=30000,outputLimit,signal}={}){
  if(timeoutMs!==null&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647))fail('harness2_timeout_invalid');
  if(outputLimit!==undefined&&(!Number.isSafeInteger(outputLimit)||outputLimit<1))fail('harness2_output_limit_invalid');
  if(signal?.aborted)return {exitCode:null,signal:null,reason:'cancelled',stdout:'',stderr:''};
  const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:{...spec.env,FINANCE_HARNESS2_SUPERVISED:'1'},windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',bytes=0,reason=null;
  const stop=why=>{if(!reason){reason=why;void stopChild(child);}};
  const timer=timeoutMs===null?null:setTimeout(()=>stop('timeout'),timeoutMs),cancel=()=>stop('cancelled');signal?.addEventListener('abort',cancel,{once:true});
  for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']]){stream.setEncoding('utf8');stream.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(outputLimit!==undefined&&bytes>outputLimit){stop('output_limit');return;}if(name==='stdout')stdout+=chunk;else stderr+=chunk;});}
  if(spec.stdin)child.stdin.end(spec.stdin);else child.stdin.end();
  try{return await new Promise((ok,no)=>{child.once('error',no);child.once('close',(exitCode,exitSignal)=>ok({exitCode,signal:exitSignal,reason,stdout,stderr}));});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);await stopChild(child);}
}
export async function prepare({root,nodePath=process.execPath}){
  if(!root||!isAbsolute(root)||existsSync(root))fail('harness2_new_absolute_root_required');mkdirSync(root);
  const home=join(root,'preparation-home');mkdirSync(home);
  const seed=await boundedSpawn({command:nodePath,args:[join(repo,'06-workbench/scripts/harness2-seed.mjs'),join(root,'snapshot')],cwd:repo,env:cleanEnvironment(home)});
  if(seed.exitCode!==0||seed.reason)fail('harness2_seed_failed');
  const baseline=join(root,'baseline');mkdirSync(baseline);
  writeFileSync(join(baseline,'SKILL.md'),'# Synthetic finance guidance\n\nDiscover the actual explicit synthetic target, inspect Harness status and preserve all three state axes. Unknown writes require query with the original operation ID. Never fabricate accountant approval.\n',{flag:'wx'});
  const manifest={version:'finance-harness2-experiment/1',upstreamCommit:UPSTREAM_COMMIT,synthetic:true,repo,root:realpathSync(root),runtimeDigest:runtimeDigest(),snapshotDigest:treeDigest(join(root,'snapshot')),baseline:inspectSurface(baseline),modelInvoked:false};
  mkdirSync(join(root,'runs'));save(join(root,marker),manifest);return manifest;
}
function loadExperiment(root){
  if(!isAbsolute(root)||lstatSync(root).isSymbolicLink())fail('harness2_root_invalid');
  const m=JSON.parse(readFileSync(join(root,marker),'utf8'));
  if(m.version!=='finance-harness2-experiment/1'||m.synthetic!==true||m.root!==realpathSync(root)||m.repo!==repo||m.upstreamCommit!==UPSTREAM_COMMIT)fail('harness2_manifest_invalid');
  if(m.runtimeDigest!==runtimeDigest())fail('harness2_runtime_changed');
  if(inspectSurface(join(root,'baseline')).digest!==m.baseline.digest)fail('harness2_baseline_changed');
  if(treeDigest(join(root,'snapshot'))!==m.snapshotDigest)fail('harness2_snapshot_changed');return m;
}
export async function dispatch(request,{signal}={}){
  if(!request||request.version!=='finance-harness2-request/1')fail('harness2_request_invalid');
  if(!['probe','execute','query','assess'].includes(request.action)||!HOSTS.includes(request.host))fail('harness2_request_invalid');
  const manifest=loadExperiment(request.root),run=childPath(join(request.root,'runs'),request.runId),receipt=join(run,'receipt.json');
  const binding=digest(JSON.stringify({host:request.host,executionMode:request.executionMode??'model',packageRoot:request.packageRoot??null,packageDigest:request.packageRoot?treeDigest(request.packageRoot):null,cliPath:request.cliPath??null,cliDigest:request.cliPath?digest(readFileSync(request.cliPath)):null,sourceDigest:manifest.snapshotDigest,candidate:request.candidateDir?inspectSurface(request.candidateDir).digest:manifest.baseline.digest}));
  if(request.action==='query'||request.action==='assess'){
    if(!existsSync(run))return {status:'not_started',operationState:null,resultCurrent:null,confirmationCurrent:null,modelInvoked:false};
    const intent=JSON.parse(readFileSync(join(run,'intent.json'),'utf8'));if(intent.binding!==binding)fail('harness2_resume_binding_changed');
    if(request.action==='assess'){
      if(!existsSync(receipt))return {status:'unknown',pass:null};
      const observed=await boundedSpawn({command:process.execPath,args:[join(repo,'06-workbench/scripts/harness2-assess.mjs'),run],cwd:repo,env:cleanEnvironment(join(run,'backend-home'))},{timeoutMs:30000,signal});
      if(observed.exitCode!==0||observed.reason)return {status:'unknown',pass:null};
      return JSON.parse(observed.stdout);
    }
    if(intent.action==='execute'){
      const observed=await boundedSpawn({command:process.execPath,args:[join(repo,'06-workbench/scripts/harness2-query.mjs'),run],cwd:repo,env:cleanEnvironment(join(run,'backend-home'))},{timeoutMs:30000,signal});
      if(observed.exitCode===0&&!observed.reason)return {...JSON.parse(observed.stdout),modelInvoked:intent.modelInvoked??false,priorReceiptStatus:existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')).status:null};
      return {status:'unknown',operationState:'unknown',resultCurrent:null,confirmationCurrent:null,recovery:'query_original_run_id',modelInvoked:intent.modelInvoked??false};
    }
    return existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):{status:'unknown',operationState:'unknown',resultCurrent:null,confirmationCurrent:null,recovery:'query_original_run_id',modelInvoked:false};
  }
  // Linux 候选沙箱之外的模型执行始终按失败关闭处理。
  // 中继仅服务执行者；Codex 优化使用其自身宿主。
  const modelRun=request.action==='execute'&&request.executionMode==='model';
  const timeoutMs=request.timeoutMs??(modelRun?null:30000);
  if(request.action==='execute'&&!['synthetic-native','model'].includes(request.executionMode))fail('harness2_isolated_metered_runner_required');
  if(modelRun){
    if(process.platform!=='linux'||existsSync('/mnt/d')||existsSync('/home')||existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')||!existsSync('/run/finance-gateway.sock')||!lstatSync('/run/finance-gateway.sock').isSocket()||readFileSync('/proc/net/route','utf8').trim().split('\n').length>1||!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(process.env.FINANCE_HARNESS2_RELAY_BASE??''))fail('harness2_isolated_metered_runner_required');
  }
  if(request.action==='execute'&&!modelRun&&request.host!=='pi')fail('harness2_native_synthetic_driver_requires_pi');
  if(existsSync(run)){
    const intent=JSON.parse(readFileSync(join(run,'intent.json'),'utf8'));if(intent.binding!==binding)fail('harness2_resume_binding_changed');
    if(existsSync(receipt))return JSON.parse(readFileSync(receipt,'utf8'));
    return {status:'unknown',operationState:'unknown',resultCurrent:null,confirmationCurrent:null,recovery:'query_original_run_id',modelInvoked:false};
  }
  mkdirSync(run);save(join(run,'intent.json'),{binding,action:request.action,modelInvoked:modelRun});cpSync(join(request.root,'snapshot'),join(run,'synthetic'),{recursive:true,errorOnExist:true,force:false});
  const candidate=join(run,'candidate');cpSync(request.candidateDir??join(request.root,'baseline'),candidate,{recursive:true,errorOnExist:true,force:false});inspectSurface(candidate);
  const workspace=run;const home=join(run,'backend-home');mkdirSync(home);
  let taskFile;
  if(modelRun){
    const synthetic=join(run,'synthetic'),{scope}=JSON.parse(readFileSync(join(synthetic,'synthetic.json'),'utf8'));
    const target={dbPath:join(synthetic,'data/workbench.db'),databaseInstanceId:scope.databaseInstanceId,enterpriseKey:scope.enterpriseKey,accountSetId:scope.accountSetId};
    const source=join(synthetic,'period-request.json');save(source,{target});
    taskFile=join(run,'task.txt');writeFileSync(taskFile,`Synthetic research task. Use only finance MCP and read. The existing Harness Store is ${join(synthetic,'harness-store')}; scope is ${JSON.stringify(scope)}. Discover and verify the actual target. Request source file ${source} contains exactly {target}. Register it as sourceId synthetic-request, parsed:false, classification:synthetic, unrecognized:[] and locator:whole synthetic target request. Register exactly factId request, state:provided, sourceRefs:[synthetic-request], value:{target}. Plan exactly taskId inspect-period, capabilityId period.inspect, factIds:[request], requestFactId:request, dependsOn:[], with that target. Inspect status, then execute using the current dependencyDigest. Keep accountant review pending; do not call feedback or any write capability. This is period inspection only, not completed accounting. Preserve unknown; query original intent before any retry. Candidate guidance: ${join(candidate,'SKILL.md')}.`,{flag:'wx'});
  }
  const env={...cleanEnvironment(home),WORKBENCH_DATA_DIR:join(run,'synthetic/data'),HOST:'127.0.0.1',PORT:'0'};
  const backend=spawn(process.execPath,[join(repo,'06-workbench/server/server.mjs')],{cwd:repo,env,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});backend.stderr.resume();
  try{
    const apiBase=await new Promise((ok,no)=>{let text='';const t=setTimeout(()=>no(Error('harness2_backend_timeout')),15000);backend.once('error',e=>{clearTimeout(t);no(e);});backend.once('exit',()=>{clearTimeout(t);no(Error('harness2_backend_failed'));});backend.stdout.on('data',b=>{text+=b;if(text.length>65536){clearTimeout(t);no(Error('harness2_backend_output_limit'));}const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(t);ok(match[0]);}});});
    const {buildHostSpec}=await import(`./hosts/${request.host}.mjs`);
    const spec=buildHostSpec({workspace,nodePath:process.execPath,packageRoot:request.packageRoot,cliPath:request.cliPath,apiBase,databasePath:join(run,'synthetic/data/workbench.db'),candidateDir:candidate,taskFile,mcpServerPath:join(repo,'05-reconstruction/codex/harness2/restricted-mcp.mjs'),mcpEnv:{FINANCE_HARNESS2_SYNTHETIC_ROOT:join(run,'synthetic')},modelBaseUrl:process.env.FINANCE_HARNESS2_RELAY_BASE,...request.maxOutputTokens===undefined?{}:{maxOutputTokens:request.maxOutputTokens},mode:request.action==='execute'?(modelRun?'run':'synthetic-native'):'check',timeoutMs});
    const result=await boundedSpawn(spec,{timeoutMs,signal});
    const native=await nativeSummary(result.stdout);
    // 原生输出留在本机合成实验目录，绝不放入
    // 公开回执或优化器的经验上下文。
    writeFileSync(join(run,'native.stdout'),result.stdout,{flag:'wx'});writeFileSync(join(run,'native.stderr'),result.stderr,{flag:'wx'});
    if(modelRun&&result.exitCode===0&&!result.reason){await boundedSpawn({command:process.execPath,args:[join(repo,'06-workbench/scripts/harness2-capture.mjs'),run],cwd:repo,env:cleanEnvironment(home)},{timeoutMs:30000,signal});}
    const artifact=request.action==='execute'&&existsSync(join(run,'deliverable.json'))?JSON.parse(readFileSync(join(run,'deliverable.json'),'utf8')):null;
    const executed=artifact?.task?.executionState==='executed';
    const unknown=request.action==='execute'&&!artifact;
    const value={version:'finance-harness2-receipt/1',host:request.host,...native,status:result.exitCode===0&&!result.reason?(executed?'native_task_executed':modelRun?'native_task_incomplete':'probe_passed'):'native_failed',exitCode:result.exitCode,reason:result.reason,operationState:executed?'executed':unknown?'unknown':'not_executed',resultCurrent:executed?artifact.task.resultCurrent??null:null,confirmationCurrent:executed?artifact.task.confirmationCurrent??null:null,executionState:executed?'executed':unknown?'unknown':'not_executed',reviewState:artifact?.task?.reviewState??'pending',ruleState:'enterprise_exception',modelInvoked:modelRun,scope:executed?(modelRun?'native model synthetic period inspection':'deterministic native synthetic period inspection; model quality unverified'):'native host run; no verified business deliverable',businessComplete:false,snapshotDigest:manifest.snapshotDigest,candidateDigest:inspectSurface(candidate).digest};
    save(receipt,value);return value;
  }finally{await stopChild(backend);}
}
