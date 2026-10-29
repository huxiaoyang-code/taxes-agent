import {spawn,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const OUTPUT_LIMIT=2*1024*1024;
export function killTree(child){
  if(!child?.pid)return;
  if(process.platform==='win32'){
    if(child.exitCode!==null||child.signalCode!==null)return;
    const killed=spawnSync(join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore',timeout:5000});
    if(killed.status!==0)try{child.kill('SIGKILL');}catch{}
  }
  else if(child.harness2OwnGroup)try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}
  else try{child.kill('SIGKILL');}catch{}
}
export async function capture(command,args,{cwd,env,timeoutMs,signal,onLine}={}){
  if(signal?.aborted)return {exitCode:null,reason:'cancelled',stdout:'',stderr:''};
  const ownGroup=process.platform!=='win32'&&env?.FINANCE_HARNESS2_SUPERVISED!=='1';
  const child=spawn(command,args,{cwd,env,windowsHide:true,shell:false,detached:ownGroup,stdio:['ignore','pipe','pipe']});child.harness2OwnGroup=ownGroup;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let stdout='',stderr='',bytes=0,reason=null,partial='';
  const stop=why=>{reason??=why;killTree(child);child.stdout.destroy();child.stderr.destroy();};
  const cancel=()=>stop('cancelled'),timer=setTimeout(()=>stop('timeout'),timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});
  const term=()=>stop('cancelled');process.once('SIGTERM',term);process.once('SIGINT',term);
  const exit=()=>killTree(child);process.once('exit',exit);
  for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',chunk=>{
    bytes+=Buffer.byteLength(chunk);if(bytes>OUTPUT_LIMIT){stop('output_limit');return;}
    if(name==='stdout'){stdout+=chunk;partial+=chunk;let i;while((i=partial.indexOf('\n'))>=0){onLine?.(partial.slice(0,i));partial=partial.slice(i+1);}}else stderr+=chunk;
  });
  try{return await new Promise((ok,no)=>{child.once('error',no);child.once('close',(exitCode,signal)=>{if(partial)onLine?.(partial);ok({exitCode,signal,reason,stdout,stderr});});});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);process.removeListener('SIGTERM',term);process.removeListener('SIGINT',term);process.removeListener('exit',exit);killTree(child);}
}
export function inspectEvent(value){
  const failures=[];
  function visit(v){
    if(!v||typeof v!=='object')return;
    if(v.isError===true||v.is_error===true||v.success===false||(v.id!==undefined&&v.error)||['error','failed','failure','blocked','rejected','cancelled'].includes(v.status))failures.push({status:v.status??'error',code:typeof v.error==='string'?v.error:typeof v.code==='string'?v.code:'native_tool_error'});
    // MCP text content frequently holds the actual business envelope beneath success:true.
    if(v.type==='text'&&typeof v.text==='string'){try{visit(JSON.parse(v.text));}catch{}}
    for(const [k,x] of Object.entries(v))if(k!=='text'&&x&&typeof x==='object'){if(Array.isArray(x))x.forEach(visit);else visit(x);}
  }
  visit(value);return failures;
}
export function versionMatches(text,version){return new RegExp('(?:^|[^0-9.])'+version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^0-9A-Za-z.-])').test(text.trim());}
export async function runPlan(plan,{env=process.env,emit=value=>process.stdout.write(JSON.stringify(value)+'\n')}={}){
  if(plan?.schema!=='harness2-native-plan/1'||!['check','run'].includes(plan.mode)||!Array.isArray(plan.native?.prefix)||!Number.isSafeInteger(plan.timeoutMs))throw Error('harness2_native_plan_invalid');
  const started=Date.now(),remaining=()=>Math.max(1,plan.timeoutMs-(Date.now()-started));
  const version=await capture(plan.native.command,[...plan.native.prefix,'--version'],{cwd:plan.cwd,env,timeoutMs:remaining()});
  if(version.exitCode!==0||version.reason||!versionMatches(version.stdout+'\n'+version.stderr,plan.expectedVersion))throw Error('harness2_native_version_mismatch');
  emit({type:'host_version',host:plan.host,version:plan.expectedVersion,modelInvoked:false});
  if(plan.mode==='check'&&plan.mcp){
    const {McpStdioClient}=await import('../../mcp/finance-mcp/mcp-stdio-client.mjs');
    const client=new McpStdioClient(plan.mcp.serverPath,{cwd:plan.cwd,env:plan.mcp.env,timeoutMs:Math.min(15000,remaining())}).start();
    try{await client.initialize('harness2-contract-probe');const listed=(await client.rpc('tools/list')).result?.tools?.map(tool=>tool.name).sort();if(JSON.stringify(listed)!==JSON.stringify(plan.expectedMcpTools))throw Error('harness2_mcp_tool_contract_mismatch');emit({type:'mcp_contract_probe',host:plan.host,toolNames:listed,modelInvoked:false});}finally{await client.close();}
  }
  if(plan.setupArgs){const setup=await capture(plan.native.command,[...plan.native.prefix,...plan.setupArgs],{cwd:plan.cwd,env,timeoutMs:remaining()});if(setup.exitCode!==0||setup.reason)throw Error('harness2_native_setup_failed');}
  if(plan.protocol==='zcode-app-server'){
    const {runZcode}=await import('./zcode-rpc.mjs');return runZcode(plan,{env,emit,timeoutMs:remaining(),killTree,inspectEvent});
  }
  let failures=0,events=0;
  const result=await capture(plan.native.command,[...plan.native.prefix,...(plan.mode==='check'?plan.checkArgs:plan.runArgs)],{cwd:plan.cwd,env,timeoutMs:remaining(),onLine:line=>{
    if(plan.mode!=='run')return;
    try{const event=JSON.parse(line);events++;const innerErrors=inspectEvent(event);failures+=innerErrors.length;emit({type:'native_event',host:plan.host,event,innerErrors});}catch{emit({type:'native_text',host:plan.host,text:line});}
  }});
  // Raw diagnostics are local only; no key-bearing environment or model requests are logged.
  if(result.stderr)process.stderr.write(result.stderr);
  if(plan.mode==='check'){
    emit({type:'native_probe',host:plan.host,stdout:result.stdout,probe:plan.probe,modelInvoked:false});
    if(/unmatched|not matched|no matching/i.test(result.stderr))throw Error('harness2_native_patch_unmatched');
    if(plan.host==='claude-code'&&!/finance[\s\S]*(?:Connected|connected|✓)/.test(result.stdout))throw Error('harness2_native_mcp_connection_unproven');
    if(plan.host==='dsh'&&(!result.stdout.includes('finance-harness-mcp')||!result.stdout.includes('FINANCE_MCP_PROFILE')))throw Error('harness2_native_config_unproven');
    if(plan.host==='dsh'&&plan.mountArgs){
      const mounted=await capture(plan.native.command,[...plan.native.prefix,...plan.mountArgs],{cwd:plan.cwd,env,timeoutMs:remaining()});
      if(mounted.stderr)process.stderr.write(mounted.stderr);
      emit({type:'native_probe',host:plan.host,stdout:mounted.stdout,probe:'native-agent-mount',modelInvoked:false});
      const proof=mounted.stdout.split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(event=>event?.type==='harness2_dsh_probe');
      if(mounted.exitCode!==0||mounted.reason||proof?.status!=='passed'||proof.modelInvoked!==false||proof.turnCount!==0||JSON.stringify(proof.visibleTools?.slice().sort())!==JSON.stringify(plan.allowedToolNames))throw Error('harness2_dsh_native_mount_unproven');
    }
  }
  const status=result.reason??(result.exitCode!==0?'process_failed':plan.mode==='run'&&!events?'trajectory_missing':failures?'completed_with_tool_errors':'completed');
  emit({type:'host_result',host:plan.host,status,exitCode:result.exitCode,innerErrorCount:failures,modelInvoked:plan.mode==='run',probe:plan.probe});
  return {status,exitCode:result.exitCode,innerErrorCount:failures};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await runPlan(JSON.parse(readFileSync(process.argv[2],'utf8')));if(!['completed','completed_with_tool_errors'].includes(result.status))process.exitCode=1;}
  catch(error){process.stderr.write((error.code??error.message??'harness2_native_failed')+'\n');process.exitCode=1;}
}
