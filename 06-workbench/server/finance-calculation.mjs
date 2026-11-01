// 记录可信本机脚本的真实执行；不是沙箱，不替脚本判断税法或审批业务结果。
import {mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync,readdirSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {captureEvidenceSource,parseEvidenceCsv} from './business-evidence.mjs';
import {currentFinanceCall,financeAuditDirectory,annotateFinanceCall} from './finance-call-chain.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';

const text={type:'string',minLength:1,maxLength:8000};
export const CALCULATION_SCHEMA={type:'object',additionalProperties:false,required:['title','engine','script','sources'],properties:{
 title:text,engine:{enum:['python','javascript']},script:{type:'string',minLength:1,maxLength:200000},
 sources:{type:'array',maxItems:64,items:{type:'object',additionalProperties:false,required:['path'],properties:{path:text,locator:{type:'object',additionalProperties:false,properties:{jsonPointer:{type:'string'},row:{type:'integer',minimum:1},column:{anyOf:[text,{type:'integer',minimum:1}]},headerRows:{type:'array',maxItems:8,items:{type:'integer',minimum:1}},sheet:text}}}}},
 parameters:{type:'object'},notes:{type:'array',maxItems:40,items:text},rerunOf:{type:'string',pattern:'^[a-f0-9-]{36}$'},timeoutMs:{type:'integer',minimum:100,maximum:60000}
}};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const fail=code=>{throw Object.assign(Error(code),{code});};
const inside=(root,path)=>{const part=relative(root,path);return !!part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('../')&&!part.startsWith('..\\');};
function plainPath(path,{missing=false}={}){
 for(let p=resolve(path);;p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())fail('finance_calculation_link_forbidden');}catch(e){if(!missing||e.code!=='ENOENT')throw e;}if(p===dirname(p))break;}
}
function fileBytes(path,limit=8*1024*1024){
 plainPath(path);const st=lstatSync(path);
 if(!st.isFile()||st.nlink!==1||st.size>limit||realpathSync(path).toLowerCase()!==resolve(path).toLowerCase())fail('finance_calculation_file_forbidden');
 return readFileSync(path);
}
const save=(path,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);writeFileSync(path,bytes,{flag:'wx',mode:0o600});return {sha256:sha(bytes),bytes:bytes.length};};
function childEnvironment(work){
 // 不复制宿主环境、模型密钥、账库位置、代理或用户目录；仍不是操作系统权限隔离。
 const env={TEMP:work,TMP:work,TMPDIR:work,HOME:work,USERPROFILE:work,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'};
 for(const key of ['SystemRoot','WINDIR'])if(process.env[key])env[key]=process.env[key];
 return env;
}
function execute(program,args,{cwd,env,timeoutMs}){
 return new Promise(resolveResult=>{
  const startedAt=new Date().toISOString(),started=Date.now();let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),reason=null;
  const child=spawn(program,args,{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>{reason='timeout';child.kill();},timeoutMs);
  const collect=key=>chunk=>{let current=key==='stdout'?stdout:stderr;const room=1024*1024-current.length;if(chunk.length>room){reason='output_limit';child.kill();}current=Buffer.concat([current,chunk.subarray(0,Math.max(0,room))]);if(key==='stdout')stdout=current;else stderr=current;};
  child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
  child.on('error',e=>{reason=e.code??'spawn_failed';});
  child.on('close',(exitCode,signal)=>{clearTimeout(timer);resolveResult({program,args,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-started,exitCode,signal,reason,stdout,stderr});});
 });
}
function outputIndex(root){
 const files=[];let total=0;
 const visit=dir=>{plainPath(dir);for(const ent of readdirSync(dir,{withFileTypes:true})){const path=join(dir,ent.name);if(ent.isSymbolicLink())fail('finance_calculation_output_link');if(ent.isDirectory()){if(relative(root,path).split(/[\\/]/).length>8)fail('finance_calculation_output_limit');visit(path);}else{const bytes=fileBytes(path,20*1024*1024);total+=bytes.length;if(total>20*1024*1024||files.length>=64)fail('finance_calculation_output_limit');files.push({path:relative(root,path).replaceAll('\\','/'),sha256:sha(bytes),bytes:bytes.length,kind:'derived_calculation'});}}};visit(root);return files;
}
const escape=value=>String(value??'未知').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function humanReview(record){
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+escape(record.title)+'</title><style>body{font:16px/1.7 sans-serif;max-width:1000px;margin:40px auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}</style><h1>'+escape(record.title)+'</h1><h2>计算记录与文件索引</h2><p>本页是执行记录，业务账表请打开下列输出文件；不是完整财税报告。独立派生计算；'+(record.status==='executed'?'脚本执行完成':'执行失败或记录需要核查')+'。执行成功不代表业务已核、税法适用正确、已入账或已申报。未给事实保留未知；脚本规则、参数及缺件说明由编写者声明，尚待复核。</p><h2>计算结果文件</h2><ul>'+record.outputs.map(o=>'<li><a href="outputs/'+o.path.split('/').map(encodeURIComponent).join('/')+'">'+escape(o.path)+'</a>（派生文件；'+o.bytes+' 字节）</li>').join('')+'</ul><h2>方法、规则及缺件声明</h2><pre>'+escape(json(record.notes))+'</pre><h2>实际参数</h2><pre>'+escape(json(record.parameters))+'</pre><h2>输入文件结构与选取位置</h2>'+record.sources.map(s=>'<h3>'+escape(s.path)+'</h3><pre>'+escape(json({sha256:s.sha256,structure:s.structure,locator:s.locator,meaning:'输入文件快照，来源性质待核；路径授权及哈希不证明原件真实性或参数语义正确'}))+'</pre>').join('')+'<h2>执行记录</h2><p>本机可信脚本按当前用户权限执行；目录约定、超时和环境精简不是安全沙箱。未记录绕过本工具的宿主调用。计时限制仅针对直接子进程，不能约束其创建的后代进程或内存。</p><pre>'+escape(json({runId:record.runId,rerunOf:record.rerunOf,status:record.status,error:record.error,runtime:record.runtime,execution:record.execution,sourceChecks:record.sourceChecks,executionFileChecks:record.executionFileChecks}))+'</pre><p><a href="request.json">完整请求</a> · <a href="script.'+(record.engine==='python'?'py':'mjs')+'">版本化脚本</a> · <a href="input.json">实际执行输入</a> · <a href="stdout.txt">标准输出</a> · <a href="stderr.txt">错误输出</a> · <a href="record.json">完整记录</a></p></html>';
}

export async function runFinanceCalculation(args){
 if(validateSchemaValue(CALCULATION_SCHEMA,args).length)fail('finance_calculation_input_invalid');
 const call=currentFinanceCall(),root=join(call?.auditDir??financeAuditDirectory(),'calculations');plainPath(root,{missing:true});mkdirSync(root,{recursive:true});
 let parent=null;
 if(args.rerunOf){const p=join(root,args.rerunOf,'record.json');let bytes;try{bytes=fileBytes(p);}catch{fail('finance_calculation_previous_missing');}const previous=JSON.parse(bytes);if(previous.runId!==args.rerunOf||previous.version!=='finance-calculation/1')fail('finance_calculation_previous_invalid');
  for(const [name,expected]of [['request.json',previous.request],['script.'+(previous.engine==='python'?'py':'mjs'),previous.script],...(previous.input?[['input.json',previous.input]]:[])])if(sha(fileBytes(join(dirname(p),name)))!==expected?.sha256)fail('finance_calculation_previous_changed');
  parent={runId:args.rerunOf,recordSha256:sha(bytes)};
 }
 const runId=randomUUID(),dir=join(root,runId),working=join(dir,'working'),outputDir=join(dir,'outputs');mkdirSync(dir);mkdirSync(working);mkdirSync(outputDir);mkdirSync(join(dir,'sources'));
 const scriptName='script.'+(args.engine==='python'?'py':'mjs');const request=save(join(dir,'request.json'),json(args)),script=save(join(dir,scriptName),args.script);
 const record={version:'finance-calculation/1',kind:'derived_calculation',runId,callId:call?.callId??null,title:args.title,engine:args.engine,rerunOf:parent,parameters:args.parameters??{},notes:args.notes??[],request,script,recorderSha256:sha(readFileSync(fileURLToPath(import.meta.url))),startedAt:new Date().toISOString(),status:'failed',sources:[],outputs:[],sourceChecks:[]};
 save(join(dir,'begin.json'),json(record));
 try{
  let total=0;const sourceRoot=process.env.FINANCE_SOURCE_ROOT;
  if(args.sources.length&&(!sourceRoot||!isAbsolute(sourceRoot)))fail('finance_calculation_source_root_required');
  for(const [index,source] of args.sources.entries()){
   const path=resolve(source.path);if(!isAbsolute(source.path)||!inside(resolve(sourceRoot),path))fail('finance_calculation_source_forbidden');
   const bytes=fileBytes(path);total+=bytes.length;if(total>20*1024*1024)fail('finance_calculation_source_limit');
   const extension=extname(path).toLowerCase(),snapshotPath=join(dir,'sources',String(index)+extension);save(snapshotPath,bytes);
   let structure={status:'unparsed',note:'仅保存字节快照；结构由脚本解析，未声称读取表头。'};
   if(source.locator)structure=captureEvidenceSource({path,...source.locator},{sourceRoot,fileCache:new Map([[path,bytes]])});
   else if(extension==='.csv'||extension==='.json'){
    // 自动摘要失败不是计算门槛；其他编码/复杂结构由获授权脚本选择解析方法。
    try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
     if(extension==='.csv'){const rows=parseEvidenceCsv(decoded);structure={format:'csv',headerRows:[1],headers:rows.slice(0,1),rowCount:rows.length,meaning:'默认首行作为结构展示，脚本自行判断业务表头。'};}
     else{const value=JSON.parse(decoded);structure={format:'json',keys:value&&typeof value==='object'?Object.keys(value):[],meaning:'根结构，具体字段由脚本选择。'};}
    }catch{structure={status:'unparsed',note:'自动结构摘要未完成；已保存原字节，由脚本按实际编码/结构处理，未声称读取表头。'};}
   }
   record.sources.push({kind:'source_snapshot',path,snapshotPath,sha256:sha(bytes),bytes:bytes.length,locator:source.locator??null,structure});
  }
  annotateFinanceCall({sources:record.sources.map(s=>({path:s.path,sha256:s.sha256,bytes:s.bytes,locator:'calculation_source_snapshot'}))});
  // 实际脚本输入只给副本位置；来源路径与完整结构留在独立记录中。
  const input={parameters:args.parameters??{},sources:record.sources.map((s,index)=>({index,snapshotPath:s.snapshotPath,sha256:s.sha256,locator:s.locator})),outputDir};
  record.input=save(join(dir,'input.json'),json(input));
  const program=args.engine==='javascript'?process.execPath:process.env.FINANCE_PYTHON_PATH;
  if(!program||!isAbsolute(program))fail('finance_calculation_python_path_required');
  const executable=fileBytes(program,150*1024*1024);record.runtime={program,executableSha256:sha(executable)};
  const env=childEnvironment(working),version=await execute(program,['--version'],{cwd:working,env,timeoutMs:5000});
  record.runtime.version=version.stdout.toString('utf8').trim()||version.stderr.toString('utf8').trim();if(version.exitCode!==0)fail('finance_calculation_runtime_unavailable');
  const argv=args.engine==='python'?['-I','-X','utf8',join(dir,scriptName),join(dir,'input.json')]:[join(dir,scriptName),join(dir,'input.json')];
  const execution=await execute(program,argv,{cwd:working,env,timeoutMs:args.timeoutMs??30000});
  save(join(dir,'stdout.txt'),execution.stdout);save(join(dir,'stderr.txt'),execution.stderr);
  const {stdout,stderr,...details}=execution;record.execution=details;
  record.outputs=outputIndex(outputDir);
  if(execution.exitCode===0&&!execution.reason)record.status='executed';else record.error={code:'finance_calculation_execution_failed',reason:execution.reason??'nonzero_exit'};
 }catch(error){record.error={code:error.code??'finance_calculation_failed',message:String(error.message)};}
 // 执行失败也保留输入文件快照、错误和已有输出；来源变化只报告，绝不回写来源文件。
 for(const source of record.sources){try{record.sourceChecks.push({path:source.path,sourceUnchanged:sha(fileBytes(source.path))===source.sha256,snapshotUnchanged:sha(fileBytes(source.snapshotPath))===source.sha256});}catch{record.sourceChecks.push({path:source.path,sourceUnchanged:null,snapshotUnchanged:null});}}
 if(record.sourceChecks.some(s=>s.sourceUnchanged!==true||s.snapshotUnchanged!==true)){record.status='failed';record.error={code:'finance_calculation_source_changed'};}
 record.executionFileChecks=[];
 for(const [name,expected]of [[scriptName,record.script],...(record.input?[['input.json',record.input]]:[])]){let unchanged=false;try{unchanged=sha(fileBytes(join(dir,name)))===expected.sha256;}catch{}record.executionFileChecks.push({file:name,unchanged});}
 if(record.executionFileChecks.some(s=>!s.unchanged)){record.status='failed';record.error={code:'finance_calculation_execution_input_changed'};}
 for(const name of ['stdout.txt','stderr.txt'])if(!existsSync(join(dir,name)))save(join(dir,name),'');
 record.finishedAt=new Date().toISOString();save(join(dir,'record.json'),json(record));save(join(dir,'review.html'),humanReview(record));
 annotateFinanceCall({artifactRefs:[join(dir,'record.json'),join(dir,'review.html')]});
 return {status:record.status,kind:record.kind,runId,reviewPath:join(dir,'review.html'),recordPath:join(dir,'record.json'),outputs:record.outputs.map(o=>({...o,path:join(outputDir,o.path)})),...(record.error?{error:{code:record.error.code}}:{}),businessStatus:'unreviewed',boundary:'记录器不调用记账接口；脚本按当前用户权限执行，其副作用不由本工具保证。非安全沙箱，未认定业务或规则正确。'};
}
