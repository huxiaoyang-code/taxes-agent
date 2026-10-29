#!/usr/bin/env node
// Synthetic preparation and real Pi execution are separate commands. No API key
// file is read or copied; run uses the operator's already authorized environment.
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,appendFileSync,readdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {createHash} from 'node:crypto';
import {prepareAnnualScenario} from '../test/annual-close-harness.test.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),[command,rootArg,piArg,stageArg]=process.argv.slice(2),root=rootArg&&resolve(rootArg);
const json=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2),{flag:'wx'});
const read=p=>JSON.parse(readFileSync(p,'utf8'));
export function selectRunnerOutcome(exit,modelErrors){
 const runSucceeded=exit.code===0&&exit.signal==null&&modelErrors===0;
 return {cliExitCode:exit.code,cliExitSignal:exit.signal??null,modelErrors,runnerExitCode:runSucceeded?0:Number.isSafeInteger(exit.code)&&exit.code>0?exit.code:1,runSucceeded};
}
export function measurePiToolResult(event,args){
 const result=event.result??{},wrapper=result.structuredContent??result.details?.structuredContent??null,nativeMcp=event.toolName?.startsWith('mcp__')&&wrapper&&Array.isArray(wrapper.content)?wrapper:null,bytes=v=>v===null||v===undefined?null:Buffer.byteLength(JSON.stringify(v)),contentBytes=content=>(content??[]).filter(c=>c.type==='text').reduce((n,c)=>n+Buffer.byteLength(c.text??''),0),textBytes=contentBytes(result.content),harness=event.toolName?.startsWith('mcp__finance__harness_');
 return {toolName:event.toolName,toolCallId:event.toolCallId,isError:event.isError??false,requestedResponseMode:args?.responseMode??null,responseModeSource:args?.responseMode!==undefined?'explicit':harness?'summary_default':'not_applicable',observedPresentationMode:nativeMcp?.structuredContent?.presentation?.mode??null,textBytes,structuredBytes:bytes(wrapper),structuredBytesMeaning:'Pi structured wrapper; not the native MCP structured payload',nativeMcpTextBytes:nativeMcp?contentBytes(nativeMcp.content):null,nativeMcpStructuredBytes:bytes(nativeMcp?.structuredContent),nativeMcpCallToolResultBytes:bytes(nativeMcp),piStructuredWrapperBytes:bytes(wrapper),piToolResultBytes:bytes(result),resultBytes:bytes(result),structuredLayout:nativeMcp?'pi.result.structuredContent -> MCP CallToolResult -> structuredContent':wrapper===null?'no structured content observed':'Pi structured content without a recognized MCP wrapper'};
}
export function prepareDisclosureScenario(root){
 if(existsSync(root))throw Error('acceptance_directory_must_be_new');mkdirSync(root,{recursive:true});
 const fixture=prepareAnnualScenario(join(root,'fixture-engine'),{empty:true}),originals=join(root,'customer-originals');mkdirSync(originals);
 writeFileSync(join(originals,'客户寄来.陌生布局'),`【全部为合成原件；客户排版，不是程序输入模板】\n企业=${fixture.target.enterpriseKey}；2026年1月1日新设；期初零；仅本企业，无历史业务/亏损。\n主体：公司；境内普通咨询服务；小企业会计准则 small-2011-basic-v1；小规模增值税，月报，未放弃免税；查账，复式记账。地区资料尚未提供。\n1月18日合同=SYN-SERVICE-18；销方本企业，买方SYN-BUYER；普通咨询已经完成并验收，取得索款权；每小时100.00元不含税；普通发票登记征收率1%，尚未收款。两份已签收清单对实际工时互相矛盾，尚未判定哪份有效。\n1月20日收到行政采购单：供应商SYN-SUPPLIER，收据ADMIN-1，当月日常组织行政服务，票面37.23元，税0.00，未付款；用途和受益期只覆盖当月，不含资产/项目。\n本月银行无收支，无税款支付凭证；应纳税和计提不能当成实缴。所得税核定频率、年度调整及季度人数资产资料尚未提供。\n未覆盖事项：一份非标准合同的履约归属不明，仅保留待核，不编造会计处理或未发生声明。\n`);
 writeFileSync(join(originals,'签收清单甲.raw'),'合成已签收服务清单甲：合同SYN-SERVICE-18；日期2026-01-18；实际咨询服务2小时；签收方SYN-BUYER。\n');
 writeFileSync(join(originals,'签收清单乙.raw'),'合成已签收服务清单乙：合同SYN-SERVICE-18；日期2026-01-18；实际咨询服务3小时；签收方SYN-BUYER。\n');
 const scenario={version:'harness-disclosure-acceptance/1',root,target:fixture.target,scope:{...fixture.scope,period:'2026-01'},storePath:join(root,'harness-store'),otherId:fixture.otherId,originals,modelInvoked:false};json(join(root,'scenario.json'),scenario);
 writeFileSync(join(root,'goal-initial.txt'),`全部为合成验收。通过实际标准Harness MCP处理 ${originals} 的陌生布局原件，自行写并运行解析/验证代码，记录来源定位、原件事实/程序推导/待核判断和未识别内容。禁止委派或子Agent、禁止读fixture-engine内部资料/测试/黄金预期/凭据，fixture-engine只提供已存在空账目标。产品源码只读，正常参数优先discover选capability合同和按需Skill。\n范围 ${JSON.stringify(scenario.scope)}；目标 ${JSON.stringify(scenario.target)}；新Store ${scenario.storePath}。调用harness_facts_register时采用factEvidencePolicy=require。不得原地改原件；地区未知不能填市区7%；无缴款证据不能登记付款。冲突仅阻塞相关分支；能独立计算的业务继续，未覆盖事项保留有依据草稿/验证/待反馈或具体补件。计算/准备/会计确认分别报告，不冒充会计。保存结果简报引用真实摘要和分段完整回执，报告补件与未完成项。\n`);
 return scenario;
}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
if(command==='prepare'&&root){console.log(JSON.stringify(prepareDisclosureScenario(root)));}
else if(['supplement','correct','recover'].includes(command)&&root){
 const s=read(join(root,'scenario.json'));
 if(command==='supplement')writeFileSync(join(s.originals,'负责人补件.回函'),'【合成原始补件，不是会计确认】\n登记所在地：市区\n原合同SYN-SERVICE-18本月实际完成2小时；签收清单甲有效，清单乙为客户撤回的错误版本。没有任何税款缴款记录。\n',{flag:'wx'});
 if(command==='correct')writeFileSync(join(s.originals,'会计反馈与更正原件.回函'),'【合成测试会计反馈，不冒充真实执业审定】\n原合同SYN-SERVICE-18经重新核验，实际完成3小时，每小时100.00元不含税；更正原因是原验收漏计1小时。原日期2026年1月18日保留。请以新资料重算，旧结果不能仍称当前有效；新版本仍待会计复核。未提供税款支付凭证；其他采购业务未变化。\n',{flag:'wx'});
 writeFileSync(join(root,`goal-${command}.txt`),`全部为合成验收。先从原 Store ${s.storePath} 的真实status恢复，不重建Store；${command==='recover'?'本次为新进程中断恢复：先查原operation，再只处理未完成/受影响任务。':'调查customer-originals新增回函，保持旧原件、解析与原生回执，更新来源/事实，修复冲突并显式重绑受影响版本。'}保留整张DAG；已执行不代表结果当前或确认当前，不能重复入账无关业务。新结果待真实人类复核；需要原生接受时仅准备并报告精确版本绑定，禁止自行制造接受。factEvidencePolicy=require；使用摘要/receipt分页，无缴款证据绝不称已缴。禁止子Agent、账库SQL、读fixture-engine资料/测试黄金值/凭据。产物只写本合成目录。\n`,{flag:'wx'});
 console.log(JSON.stringify({preparedOnly:true,stage:command,goal:join(root,`goal-${command}.txt`)}));
}else if(command==='run'&&root&&piArg&&/^[a-z-]+$/.test(stageArg??'')){
 const piRoot=resolve(piArg),pkg=read(join(piRoot,'package.json')),catalog=read(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json')),model=catalog['openai-completions']['chat:deepseek-flash'];
 if(pkg.version!=='1.1.0'||model.baseUrl!=='https://api.deepseek.com'||model.name!=='DeepSeek V4.1 Flash')throw Error('verified_official_pi_model_required');
 if(!process.env.DEEPSEEK_API_KEY)throw Error('operator_environment_key_required');
 const secret=process.env.DEEPSEEK_API_KEY,redact=s=>s.split(secret).join('[REDACTED_API_KEY]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]'),s=read(join(root,'scenario.json')),logs=join(root,'logs'),isolated=join(root,'isolated-pi');mkdirSync(logs,{recursive:true});mkdirSync(isolated,{recursive:true});
 const goal=join(root,`goal-${stageArg}.txt`),events=join(logs,stageArg+'.jsonl');if(!existsSync(goal)||existsSync(events))throw Error('goal_missing_or_stage_already_logged');
 const env={...process.env,PI_CODING_AGENT_DIR:isolated,PI_OFFLINE:'1',NODE_NO_WARNINGS:'1',FINANCE_DATABASE_PATH:s.target.dbPath,WORKBENCH_DATA_DIR:dirname(s.target.dbPath),HOST:'127.0.0.1',PORT:'0'};
 const server=spawn(process.execPath,[join(repo,'06-workbench/server/server.mjs')],{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='',parent;
 server.stdout.on('data',b=>{text+=b.toString();appendFileSync(join(logs,stageArg+'.server.log'),redact(b.toString()));});server.stderr.on('data',b=>appendFileSync(join(logs,stageArg+'.server.stderr.log'),redact(b.toString())));
 const stop=()=>{for(const child of [parent,server])if(child&&child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}};
 process.on('SIGINT',()=>{stop();process.exit(130);});process.on('SIGTERM',()=>{stop();process.exit(143);});
 try{
  const deadline=Date.now()+45000;while(!/(?:127\.0\.0\.1|localhost):\d+/.test(text)){if(server.exitCode!==null||Date.now()>deadline)throw Error('synthetic_server_unavailable');await new Promise(r=>setTimeout(r,100));}
  env.FINANCE_API_BASE='http://127.0.0.1:'+text.match(/(?:127\.0\.0\.1|localhost):(\d+)/)[1];
  const tools=['read','write','edit',process.platform==='win32'?'powershell':'bash','tool_search','mcp__finance__harness_*','mcp__finance__skills_read','mcp__finance__skills_list'];
  const args=[join(piRoot,'dist/bundle/cli.js'),'--mode','json','--print','--no-session','--no-context-files','--no-extensions','--no-skills','--no-prompt-templates','--offline','-e','builtin:mcp','-e','builtin:tool-search','-e',join(repo,'05-reconstruction/codex/pi/finance-harness.ts'),'--skill',join(repo,'05-reconstruction/codex/skills/harness/SKILL.md'),'--provider','deepseek','--model','deepseek-flash','--thinking','low','--tools',tools.join(','),'--append-system-prompt','仅进行已授权的合成财税验收。禁止委派或启动子 Agent。不得读取凭据/认证/配置/会话、测试/黄金答案/评估器预期或 fixture-engine 资料。产品文件只读。仅可读写提供的合成运行产物，shell 仅用于运行你编写的解析/验证代码；绝不能写账簿 SQL，也不能通过 HTTP/API/shell 绕过 MCP。模型固定为官方 DeepSeek V4.1 Flash，无回退。使用原生 Harness MCP 及其渐进式合同。不得编造会计批准或付款。受阻时保留证据和准确的下一步。','读取 '+goal+' 并执行已授权任务。'];
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),inventory=directory=>readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(d=>d.isDirectory()?inventory(join(directory,d.name)):d.isFile()?[{path:join(directory,d.name),sha256:sha(readFileSync(join(directory,d.name)))}]:[]),product=[...inventory(join(repo,'06-workbench/server')),...inventory(join(repo,'05-reconstruction/codex/mcp/finance-mcp')),...inventory(join(repo,'05-reconstruction/codex/pi')),...inventory(join(repo,'05-reconstruction/codex/skills/harness'))].filter(x=>/\.(?:mjs|ts|md)$/.test(x.path));
  json(join(logs,stageArg+'.invocation.json'),{piVersion:pkg.version,provider:'deepseek',model:'deepseek-flash',endpoint:model.baseUrl,tools,goal,goalSha256:sha(readFileSync(goal)),originals:inventory(s.originals),scenarioSha256:sha(readFileSync(join(root,'scenario.json'))),productInventory:product,productDigest:sha(JSON.stringify(product)),target:s.target,repo,apiBase:env.FINANCE_API_BASE,keyMaterialLogged:false,delegationAllowed:false,authorization:'User explicitly authorized official DeepSeek synthetic acceptance; no accountant approval, payment, credential reads, product edits or extra agents.'});
  parent=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});console.log(JSON.stringify({status:'pi_started',stage:stageArg,pid:parent.pid}));
  let buffer='',transportBytes=0,toolCalls=0,modelErrors=0;const metrics=[],toolInputs=new Map(),decoder=new StringDecoder('utf8');
  const consume=chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let e;try{e=JSON.parse(line);}catch{appendFileSync(join(logs,stageArg+'.unparsed.log'),redact(line)+'\n');continue;}if(e.type!=='message_update')appendFileSync(events,redact(line)+'\n');if(e.type==='tool_execution_start'){toolCalls++;toolInputs.set(e.toolCallId,e.args);console.log(JSON.stringify({event:'tool_start',number:toolCalls,name:e.toolName}));}if(e.type==='tool_execution_end'){metrics.push(measurePiToolResult(e,toolInputs.get(e.toolCallId)));toolInputs.delete(e.toolCallId);}if(e.type==='message_end'&&e.message?.role==='assistant'){if(['error','aborted'].includes(e.message.stopReason))modelErrors++;const final=(e.message.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');if(final)writeFileSync(join(logs,stageArg+'.last-message.txt'),redact(final));}}};
  parent.stdout.on('data',b=>{transportBytes+=b.length;consume(decoder.write(b));});parent.stdout.on('end',()=>{consume(decoder.end());if(buffer)consume('\n');});parent.stderr.on('data',b=>appendFileSync(join(logs,stageArg+'.stderr.log'),redact(b.toString())));
  const exit=await new Promise((ok,no)=>{parent.on('error',no);parent.on('close',(code,signal)=>ok({code,signal}));});
  const outcome=selectRunnerOutcome(exit,modelErrors);
  json(join(logs,stageArg+'.metrics.json'),{...exit,...outcome,stage:stageArg,toolCalls,transportBytes,tools:metrics,manualInterventions:{status:'not_evaluated',events:[]},manualInterventionsMeaning:'The evaluator must record actual actions and staged supplemental/customer feedback; this field does not claim zero intervention.',sourceSearchReview:{status:'not_evaluated',instruction:'Inspect actual tool_execution_start args and classify avoidable source searches; no call-count reduction implies correctness.'},omittedOnlyIncrementalMessageUpdates:true});console.log(JSON.stringify({status:'pi_finished',...exit,...outcome,toolCalls,transportBytes}));process.exitCode=outcome.runnerExitCode;
 }finally{stop();}
}else{console.log('prepare <new-dir> | supplement|correct|recover <dir> | run <dir> <pi-package-root> <initial|supplement|correct|recover>');process.exitCode=2;}
}
