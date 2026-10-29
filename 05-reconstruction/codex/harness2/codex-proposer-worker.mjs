// Trusted outer-host bridge. It never runs inside the Pi candidate namespace.
// Reuse the operator's Codex authentication/configuration; never copy credentials.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
const hash=x=>createHash('sha256').update(x).digest('hex');
function safeLog(value){let out=value;for(const [key,secret]of Object.entries(process.env))if(/(?:API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)&&typeof secret==='string'&&secret.length>=6)out=out.split(secret).join('[redacted]');return out.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g,'[redacted-key]').replace(/(Bearer\s+)[^\s"\\]+/gi,'$1[redacted]');}
function fail(code){const error=Error(code);error.code=code;throw error;}
function plainParents(path){for(let p=resolve(path);;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())fail('codex_context_link_forbidden');if(dirname(p)===p)break;}}
function relativeFile(path){return typeof path==='string'&&path&&!path.startsWith('/')&&!path.includes('\\')&&!path.includes(':')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!['.git','.codex','auth.json','credentials.json','.env','.npmrc'].includes(p))&&/\.(md|json|txt|diff)$/.test(path);}
const fileNames=['SKILL.md','tools.md','recovery.md'];
const schema={type:'object',additionalProperties:false,required:['reply','files'],properties:{reply:{type:'string'},files:{type:'object',additionalProperties:false,required:fileNames,properties:Object.fromEntries(fileNames.map(name=>[name,{type:['string','null']}]))}}};
function recoverableTransportDiagnostic(event){
  if(event.type==='error'&&typeof event.message==='string'){
    const match=/^Reconnecting\.\.\. ([1-9]\d*)\/([1-9]\d*) \(request timed out\)$/.exec(event.message);
    return Boolean(match&&Number.isSafeInteger(Number(match[1]))&&Number.isSafeInteger(Number(match[2]))&&Number(match[1])<=Number(match[2]));
  }
  return event.type==='item.completed'&&event.item?.type==='error'&&event.item.message==='Falling back from WebSockets to HTTPS transport. request timed out';
}
export async function runCodexRequest(request,{signal}={}){
  if(request?.version!=='finance-codex-proposer/1'||!isAbsolute(request.codexCli??'')||!isAbsolute(request.workRoot??'')||typeof request.label!=='string'||!request.label||typeof request.mission!=='string'||!request.syntheticFiles||Array.isArray(request.syntheticFiles))fail('codex_request_invalid');
  if(request.timeoutMs!==undefined&&(!Number.isSafeInteger(request.timeoutMs)||request.timeoutMs<1))fail('codex_timeout_invalid');
  if(request.codexScript!==undefined&&(!isAbsolute(request.codexScript)||!existsSync(request.codexScript)||!lstatSync(request.codexScript).isFile()))fail('codex_script_invalid');
  const input=request.syntheticFiles;
  if(Object.entries(input).some(([path,text])=>!relativeFile(path)||typeof text!=='string'))fail('codex_context_file_forbidden');
  if(!existsSync(request.codexCli)||!lstatSync(request.codexCli).isFile())fail('codex_cli_missing');
  plainParents(request.workRoot);mkdirSync(request.workRoot,{recursive:true});
  const directory=join(realpathSync(request.workRoot),hash(request.label));
  if(existsSync(directory))fail('codex_invocation_already_exists');mkdirSync(directory);
  for(const [path,text]of Object.entries(input)){const out=join(directory,'context',...path.split('/'));mkdirSync(dirname(out),{recursive:true});writeFileSync(out,text,{flag:'wx'});}
  const schemaPath=join(directory,'output-schema.json'),answerPath=join(directory,'answer.json');
  writeFileSync(schemaPath,JSON.stringify(schema),{flag:'wx'});
  const owned=new Set();let reason=null;
  const stop=why=>{if(!reason)reason=why;for(const child of owned){if(!child.pid)continue;if(process.platform==='win32'){try{child.kill('SIGKILL');}catch{}}else try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}};
  const cancel=()=>stop('cancelled');signal?.addEventListener('abort',cancel,{once:true});
  const exitCleanup=()=>stop('parent_exit');process.once('exit',exitCleanup);
  async function capture(args,{stdin,logName}={}){
    if(signal?.aborted)fail('codex_cancelled');
    const env={...process.env};for(const key of Object.keys(env))if(/^(DEEPSEEK_|ANTHROPIC_|FINANCE_|ETAX_)/.test(key))delete env[key];
    const child=spawn(request.codexCli,[...(request.codexScript?[request.codexScript]:[]),...args],{cwd:directory,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});owned.add(child);
    let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    if(stdin!==undefined)child.stdin.end(stdin);else child.stdin.end();
    const timer=request.timeoutMs===undefined?null:setTimeout(()=>stop('timeout'),request.timeoutMs);
    let result;try{result=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok({code,signal}));});}finally{if(timer)clearTimeout(timer);}
    if(logName){writeFileSync(join(directory,logName+'.stdout'),safeLog(stdout),{flag:'wx'});writeFileSync(join(directory,logName+'.stderr'),safeLog(stderr),{flag:'wx'});}
    return {...result,stdout,stderr};
  }
  try{
    const version=await capture(['--version']);if(version.code!==0||reason)fail(reason?'codex_'+reason:'codex_version_failed');
    // This command can contain configured env/header secrets. Project only names
    // in memory, never persist or return its stdout/stderr.
    const servers=await capture(['mcp','list','--json']);if(servers.code!==0||reason)fail(reason?'codex_'+reason:'codex_mcp_inventory_failed');
    let configured;try{configured=JSON.parse(servers.stdout);}catch{fail('codex_mcp_inventory_invalid');}
    if(!Array.isArray(configured)||configured.some(x=>typeof x.name!=='string'||!x.name))fail('codex_mcp_inventory_invalid');
    if(configured.some(x=>!/^[A-Za-z0-9_-]+$/.test(x.name)))fail('codex_mcp_server_name_unsupported');
    if(configured.some(x=>!['stdio','streamable_http'].includes(x.transport?.type)))fail('codex_mcp_transport_unsupported');
    const disabledFeatures=['shell_tool','apps','plugins','remote_plugin','browser_use','computer_use','multi_agent','view_image','workspace_dependencies','hooks','skill_mcp_dependency_install'];
    const configArgs=['--config','tools.web_search=false'];
    for(const feature of disabledFeatures)configArgs.push('--config',`features.${feature}=false`);
    // A dynamic MCP entry may not exist in config.toml. Supplying enabled=false
    // alone creates an invalid entry without a transport. A valid disabled stub
    // never starts and avoids copying any original command/env/header secrets.
    const serverNames=[...new Set(configured.map(x=>x.name))].sort();
    for(const name of serverNames){const transport=configured.find(x=>x.name===name).transport.type;
      const stub=transport==='stdio'?`{command=${JSON.stringify(request.codexCli)},enabled=false}`:'{url="http://127.0.0.1:1",enabled=false}';
      configArgs.push('--config',`mcp_servers.${name}=${stub}`);
    }
    const disabled=await capture(['mcp','list','--json',...configArgs]);
    if(disabled.code!==0||reason)fail(reason?'codex_'+reason:'codex_mcp_disable_verification_failed');
    let verified;try{verified=JSON.parse(disabled.stdout);}catch{fail('codex_mcp_disable_verification_failed');}
    if(!Array.isArray(verified)||verified.some(x=>typeof x.name!=='string'||x.enabled!==false)||JSON.stringify(verified.map(x=>x.name).sort())!==JSON.stringify(serverNames))fail('codex_mcp_disable_verification_failed');
    const args=['exec','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--json','--output-schema',schemaPath,'--output-last-message',answerPath,...configArgs,'-'];
    const contract='Use only the supplied synthetic context below. Mission file paths are logical paths in syntheticFiles; all file contents are already supplied. Do not invoke any tools, read other files, modify global configuration or infer hidden business answers. Return the requested notes/choice/experience blocks in reply. For a guidance edit, files may replace only SKILL.md, tools.md, recovery.md; use null for unchanged files. For selection/reflection all files must be null. Preserve uncertainty and pending human accountant review. No code, scripts, hooks, permissions or accounting approvals.';
    const prompt=JSON.stringify({contract,mission:request.mission,syntheticFiles:input});
    writeFileSync(join(directory,'invocation.json'),JSON.stringify({version:'finance-codex-invocation/1',label:request.label,codexCli:request.codexCli,cliVersion:version.stdout.trim(),modelSelection:'inherited',actualModel:null,providerSelection:'inherited',disabledMcpServerCount:configured.length,disabledFeatures,sandbox:'read-only',shellTool:false,webSearch:false,inputUtf8Bytes:Buffer.byteLength(prompt),inputSha256:hash(prompt),contextFiles:Object.keys(input).sort(),credentialsCopied:false},null,2),{flag:'wx'});
    const result=await capture(args,{stdin:prompt,logName:'codex'});
    const events=result.stdout.split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
    const recoverable=new Set(events.filter(recoverableTransportDiagnostic));
    const fatalErrors=events.filter(x=>x.type==='turn.failed'||((x.type==='error'||x.item?.type==='error')&&!recoverable.has(x)));
    const terminal=events.findLast(x=>x.type==='turn.completed'),failed=fatalErrors.length>0;
    const unexpectedItemTypes=[...new Set(events.filter(x=>x.type?.startsWith('item.')&&!['agent_message','reasoning','todo_list'].includes(x.item?.type)&&!recoverable.has(x)).map(x=>typeof x.item?.type==='string'?x.item.type:'missing_type'))];
    // Only recognized fixed-format diagnostics enter metadata; arbitrary error
    // text (possibly including unrelated URLs/headers) stays in redacted logs.
    const diagnostics=[...recoverable].map(x=>({eventType:x.type,itemType:x.item?.type??null,classification:'recoverable_transport',message:safeLog(x.type==='error'?x.message:x.item.message)}));
    const metadata={version:'finance-codex-result/1',label:request.label,status:reason??(result.code!==0?'process_failed':failed?'turn_failed':unexpectedItemTypes.length?'unexpected_tool_use':!terminal?'completion_missing':'completed'),exitCode:result.code,signal:result.signal,modelSelection:'inherited',actualModel:null,cliVersion:version.stdout.trim(),threadId:events.find(x=>x.type==='thread.started')?.thread_id??null,usage:terminal?.usage??null,unexpectedItemTypes,diagnostics,fatalErrorCount:fatalErrors.length,transportRecovered:false,actualBilledUsd:null,artifactDirectory:directory};
    const actual=events.find(x=>['thread.started','turn.started','turn.completed','session.created'].includes(x.type)&&typeof x.model==='string');if(actual)metadata.actualModel=actual.model;
    let answer,files;
    if(metadata.status==='completed'){
      try{answer=JSON.parse(readFileSync(answerPath,'utf8'));}catch{metadata.status='answer_invalid';}
      if(metadata.status==='completed'&&(!answer||typeof answer.reply!=='string'||!answer.reply.trim()||!answer.files||Object.keys(answer).some(k=>!['reply','files'].includes(k))||Object.keys(answer.files).some(k=>!fileNames.includes(k))||fileNames.some(k=>!(k in answer.files)||!(answer.files[k]===null||typeof answer.files[k]==='string'))))metadata.status='answer_invalid';
      if(metadata.status==='completed'){
        files=Object.fromEntries(Object.entries(answer.files).filter(([,value])=>value!==null));
        if(!request.harvest&&Object.keys(files).length)metadata.status='nonedit_stage_returned_files';
      }
    }
    metadata.transportRecovered=metadata.status==='completed'&&recoverable.size>0;
    writeFileSync(join(directory,'result.json'),JSON.stringify(metadata,null,2),{flag:'wx'});
    if(metadata.status!=='completed')return {ok:false,code:'codex_'+metadata.status,metadata};
    return {ok:true,reply:answer.reply,files,metadata};
  }finally{signal?.removeEventListener('abort',cancel);process.removeListener('exit',exitCleanup);stop(reason??'finished');}
}
if(process.argv[1]&&import.meta.url===(await import('node:url')).pathToFileURL(process.argv[1]).href){
  const controller=new AbortController();const lines=createInterface({input:process.stdin,terminal:false});let received=false,done=false;
  lines.once('close',()=>{if(!done)controller.abort();});for(const event of ['SIGTERM','SIGINT'])process.once(event,()=>controller.abort());
  lines.on('line',async line=>{if(received){controller.abort();return;}received=true;try{const result=await runCodexRequest(JSON.parse(line),{signal:controller.signal});done=true;console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;}catch(e){done=true;console.log(JSON.stringify({ok:false,code:/^[a-z_]+$/.test(e.code??e.message)?e.code??e.message:'codex_worker_failed'}));process.exitCode=1;}finally{lines.close();process.stdin.destroy();}});
}
