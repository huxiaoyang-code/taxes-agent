#!/usr/bin/env node
// Real Pi loader/context projection/MCP path, no provider or credentials.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolveSolPi,loadSolPi,prepareArchive} from '../../05-reconstruction/codex/sol-pi/runtime.mjs';
import {MAIN_TOOLS} from '../../05-reconstruction/codex/hosts/pi/launcher.mjs';

const args=process.argv.slice(2),options={host:'pi',runtimeEfficiency:'sol-pi'},keys={'--tool-root':'toolRoot','--archive-root':'archiveRoot','--account-set-id':'accountSetId','--failure-case':'failureCase'};
for(let i=0;i<args.length;i+=2){if(!keys[args[i]]||!args[i+1]||options[keys[args[i]]]!==undefined)throw Error('sol_pi_probe_arguments_invalid');options[keys[args[i]]]=args[i+1];}
if(!options.failureCase){
  for(const failureCase of ['missing','corrupt','unwritable'])execFileSync(process.execPath,[fileURLToPath(import.meta.url),...args,'--failure-case',failureCase],{windowsHide:true,stdio:'inherit'});
  process.exit(0);
}
const selection=loadSolPi(resolveSolPi(options),{probe:true}),repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const archive=prepareArchive(selection),agentDir=join(archive,'isolated-agent');mkdirSync(agentDir);
// A hostile existing global config in this isolated agent directory cannot
// activate another mechanism: this bridge registers only the public factory.
writeFileSync(join(agentDir,'sol-pi.json'),JSON.stringify({version:1,actionFusion:true,observationPack:false,evidencePreservingReducer:true,onlineContextCompact:true}));
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.FINANCE_SOL_PI_ARCHIVE=archive;process.env.FINANCE_SOL_PI_FINGERPRINT=selection.fingerprint;
const piImport=path=>import(pathToFileURL(join(selection.piRoot,'dist',path)).href);
const [{DefaultResourceLoader},{builtInExtensions},{SettingsManager},{SessionManager},{AuthStorage},{ModelRuntime},{createAgentSession}]=await Promise.all(['core/resource-loader.js','extensions/index.js','core/settings-manager.js','core/session-manager.js','core/auth-storage.js','core/model-runtime.js','core/sdk.js'].map(piImport));
const settingsManager=SettingsManager.inMemory(),extensionPaths=['builtin:mcp','builtin:tool-search',join(repo,'05-reconstruction/codex/pi/finance-harness.ts'),selection.extensionPath];
const loader=new DefaultResourceLoader({cwd:repo,agentDir,settingsManager,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:extensionPaths,extensionFactories:builtInExtensions});await loader.reload();
const modelRuntime=await ModelRuntime.create({credentials:AuthStorage.inMemory(),modelsPath:null,modelsStorePath:join(agentDir,'models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
const {session,extensionsResult}=await createAgentSession({cwd:repo,agentDir,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(repo),modelRuntime,tools:[...MAIN_TOOLS,'obs_recall']});
try{
  const extensionErrors=[];
  assert.deepEqual(extensionsResult.errors,[]);await session.bindExtensions({onError:error=>extensionErrors.push(error)});
  const deadline=Date.now()+15000;while(!session.getAllTools().some(t=>t.name==='mcp__finance__harness_status')&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,50));
  const tool=name=>session.agent.state.tools.find(t=>t.name===name);
  assert.ok(tool('obs_recall'));assert.ok(tool('finance_delegate_parser'));assert.ok(tool('tool_search'));
  await tool('tool_search').execute('search',{query:'harness_status',limit:3},AbortSignal.timeout(15000));
  assert.ok(tool('mcp__finance__harness_status'));
  const native=await tool('mcp__finance__harness_discover').execute('native',{},AbortSignal.timeout(15000));
  assert.ok(native.content.some(c=>c.type==='text'&&c.text.includes('capabilities')));
  // These are actual Pi tool results, recorded without logging their payload.
  const nativeShape={contentTypes:native.content.map(c=>c.type),textBytes:Buffer.byteLength(native.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')),hasStructuredContent:Object.hasOwn(native,'structuredContent'),detailsKeys:Object.keys(native.details??{})};
  const shell=tool(process.platform==='win32'?'powershell':'bash');assert.ok(shell);
  const shellResult=await shell.execute('native-shell',{command:process.platform==='win32'?"[Console]::Write(('中文🙂合成资料'+[Environment]::NewLine)*700)":"printf 'synthetic\\n'",timeout:10},AbortSignal.timeout(15000));
  assert.ok(shellResult.content.some(c=>c.type==='text'&&c.text.includes(process.platform==='win32'?'中文🙂合成资料':'synthetic')));
  const failedShell=await shell.execute('native-shell-error',{command:'exit 7',timeout:10},AbortSignal.timeout(15000));assert.equal(failedShell.isError,true);assert.match(failedShell.content[0].text,/7/);
  const cancellation=new AbortController();const timer=setTimeout(()=>cancellation.abort(),150),cancelStarted=Date.now();
  try{await assert.rejects(()=>shell.execute('native-shell-cancel',{command:process.platform==='win32'?'Start-Sleep -Seconds 2':'sleep 2'},cancellation.signal),/aborted/i);}finally{clearTimeout(timer);}
  const cancellationMs=Date.now()-cancelStarted;
  const text=('中文🙂资料,金额123.45\n').repeat(1700)+'终';
  const message={role:'toolResult',toolCallId:'synthetic-long',toolName:process.platform==='win32'?'powershell':'bash',content:[{type:'text',text}],isError:false,timestamp:Date.now()};
  const project=messages=>session.extensionRunner.emitContext(messages);
  const first=await project([message]),second=await project([message]),third=await project([message]);
  assert.equal(first[0].content[0].text,text);assert.equal(second[0].content[0].text,text);assert.match(third[0].content[0].text,/large tool result replaced/);assert.equal(message.content[0].text,text);
  const id=third[0].content[0].text.match(/id: (obs_[a-f0-9]{24})/)[1];
  let offset=0,recalled='';for(let page=0;page<100;page++){
    const result=await tool('obs_recall').execute('recall-'+page,{id,offset},AbortSignal.timeout(15000));
    recalled+=result.content[0].text.split('\n').slice(2).join('\n');
    assert.ok(result.details.nextOffset>=offset);offset=result.details.nextOffset;if(result.details.eof)break;
  }
  assert.equal(recalled,text);assert.equal(offset,Buffer.byteLength(text));
  const digest=createHash('sha256').update(recalled).digest('hex');
  await assert.rejects(()=>tool('obs_recall').execute('invalid-offset',{id,offset:-1},AbortSignal.timeout(15000)),/offset invalid/);
  const longLine={...message,toolCallId:'long-line',content:[{type:'text',text:'中文🙂'.repeat(4000)}]};
  await project([longLine]);await project([longLine]);const longProjection=await project([longLine]);
  assert.match(longProjection[0].content[0].text,/large tool result replaced/);
  const lineId=longProjection[0].content[0].text.match(/id: (obs_[a-f0-9]{24})/)[1];
  let lineText='',lineOffset=0;for(let i=0;i<10;i++){const part=await tool('obs_recall').execute('line-'+i,{id:lineId,offset:lineOffset},AbortSignal.timeout(15000));lineText+=part.content[0].text.split('\n').slice(2).join('\n');lineOffset=part.details.nextOffset;if(part.details.eof)break;}assert.equal(lineText,longLine.content[0].text);
  const nativeMessage={...message,toolCallId:'native-protected',toolName:'mcp__finance__harness_receipt_read',content:[{type:'text',text}],details:{structuredContent:{operationState:'unknown',resultCurrent:false,confirmationCurrent:false,receiptRef:'synthetic-ref'}}};
  for(let i=0;i<4;i++)assert.deepEqual((await project([nativeMessage]))[0],nativeMessage);
  for(const other of [{...message,toolCallId:'error',isError:true},{...message,toolCallId:'mixed',content:[...message.content,{type:'image',data:'AA==',mimeType:'image/png'}]},{...message,toolCallId:'threshold',content:[{type:'text',text:'x'.repeat(10240)}]}])for(let i=0;i<3;i++)assert.deepEqual((await project([other]))[0],other);
  const {convertMessages}=await import(pathToFileURL(join(selection.toolRoot,'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')).href);
  const transmitted=convertMessages({provider:'deepseek',id:'deepseek-flash',api:'openai-completions',reasoning:false,input:['text']},{messages:[{...message,...native,toolName:'mcp__finance__harness_discover',toolCallId:'native'}]},{});
  const nativeText=native.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  assert.equal(transmitted.length,1);assert.equal(transmitted[0].content,nativeText);assert.equal(Object.hasOwn(transmitted[0],'structuredContent'),false);
  nativeShape.providerTextBytes=Buffer.byteLength(transmitted[0].content);nativeShape.structuredPayloadDuplicated=false;
  // Missing observations are explicit failures; unchanged history remains recoverable.
  const find=(dir)=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?find(join(dir,e.name)):[join(dir,e.name)]);
  const object=find(archive).find(path=>path.endsWith(id+'.txt'));assert.ok(object);
  const failureCase=options.failureCase??'missing';if(!['missing','corrupt','unwritable'].includes(failureCase))throw Error('sol_pi_probe_failure_case_invalid');
  if(failureCase==='corrupt')writeFileSync(object,'corrupted synthetic bytes');
  else if(failureCase==='unwritable'){
    const ledger=join(dirname(dirname(object)),'ledger.jsonl');rmSync(ledger);mkdirSync(ledger);
    const unchanged=await project([message]);assert.equal(unchanged[0].content[0].text,text);
    assert.ok(extensionErrors.some(error=>String(error.error).includes('sol_pi_archive_failure')),'Pi must surface the adapter failure after abort');
    assert.ok(readFileSync(join(archive,'adapter-failures.jsonl'),'utf8').includes('sol_pi_archive_failure'));
  }
  else rmSync(object);
  await assert.rejects(()=>tool('obs_recall').execute('failed-archive',{id,offset:0},AbortSignal.timeout(15000)),/Unknown observation|missing|ENOENT|hash mismatch|EISDIR|illegal operation|not a regular file/i);
  assert.equal(message.content[0].text,text);
  const report={version:'sol-pi-model-free/1',status:'passed',fingerprint:selection.fingerprint,piVersion:'1.1.0',upstreamCommit:'219568034fa54ed121ede80961655e33dfb9d0e3',modelInvoked:false,nativeMcp:true,toolSearch:true,financeParserRegistered:true,extensions:extensionPaths,archive,fullSends:2,recallBytes:offset,recallSha256:digest,nativeShape,financeReceiptExcluded:true,errorMixedThresholdUnchanged:true,archiveFailureCase:failureCase,archiveFailureExplicit:true,nativeShellExecuted:true,nativeShellFailureAndAbortReported:true,cancellationMs,cancellationTerminationVerified:false,longChineseEmojiLineExactRecall:true,globalSolPiConfigurationCannotEnableOtherMechanisms:true,scope:'model-free actual Pi projection and native tool execution; no model A/B or business correctness claim; sandbox abort does not prove process-tree termination'};
  const evidencePath=join(selection.toolRoot,'sol-pi-verified.json');let previous;
  try{previous=JSON.parse(readFileSync(evidencePath,'utf8'));}catch{}
  const cases=previous?.fingerprint===selection.fingerprint?previous.cases??{}:{};cases[failureCase]=report;
  const complete=['missing','corrupt','unwritable'].every(name=>cases[name]?.status==='passed');
  const evidence={...report,status:complete?'passed':'pending',cases};
  writeFileSync(evidencePath,JSON.stringify(evidence,null,2));console.log(JSON.stringify({...report,suiteStatus:evidence.status,evidencePath}));
}finally{await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
