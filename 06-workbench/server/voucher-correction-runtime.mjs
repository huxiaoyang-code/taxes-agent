// 委托来自本机生成的宿主配置。调用参数只能选择当前账套内的凭证，不能选择授权文件或数据库。
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {loadBoundBusinessSession} from '../../05-reconstruction/codex/hosts/shared/business-session.mjs';
import {annotateFinanceCall,currentFinanceCall} from './finance-call-chain.mjs';
import {validateSchemaValue} from './harness-schema-validation.mjs';
import {VOUCHER_CORRECTION_SCHEMA} from './voucher-correction-contract.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
function delegation(args){
  const digest=process.env.FINANCE_CORRECTION_SOURCE_DIGEST;
  const sessionPath=process.env.FINANCE_BUSINESS_SESSION;
  if(!/^[a-f0-9]{64}$/.test(digest??'')||!sessionPath)fail('finance_correction_delegation_required');
  if(!existsSync(sessionPath))fail('finance_correction_binding_required');
  const {config,session,path}=loadBoundBusinessSession(dirname(dirname(sessionPath)));
  if(resolve(path)!==resolve(sessionPath)||config.mcpEnv.FINANCE_CORRECTION_SOURCE_DIGEST!==digest||
    session.databasePath!==process.env.FINANCE_DATABASE_PATH||session.sourceRoot!==process.env.FINANCE_SOURCE_ROOT||
    session.scope.accountSetId!==args.accountSetId||session.scope.period!==args.period)fail('finance_correction_scope_mismatch');
  const manifestPath=join(dirname(path),'correction-sources.json');
  const stat=lstatSync(manifestPath,{throwIfNoEntry:false});
  if(!stat?.isFile()||stat.nlink!==1||stat.size>32*1024*1024||
    resolve(realpathSync(manifestPath))!==resolve(manifestPath))fail('finance_correction_delegation_invalid');
  const bytes=readFileSync(manifestPath);
  if(createHash('sha256').update(bytes).digest('hex')!==digest)fail('finance_correction_delegation_changed');
  const manifest=JSON.parse(bytes);
  if(manifest.sourceRoot!==session.sourceRoot||manifest.databasePath!==session.databasePath||
    !Array.isArray(manifest.originals))fail('finance_correction_delegation_invalid');
  return {dbPath:session.databasePath,auditDir:session.auditDir,scope:session.scope,
    sourceRoot:session.sourceRoot,originals:manifest.originals};
}

// 会计模块按进程环境打开账库。隔离线程固定路径与只读模式，避免并发调用改变宿主环境。
function execute(args,context){
  if(join(dirname(context.dbPath),'workbench.db')!==context.dbPath)fail('finance_correction_database_path_invalid');
  if(args.action==='apply'&&process.env.WORKBENCH_DATABASE_MODE==='readonly')fail('finance_correction_readonly');
  const worker=new Worker(new URL('./voucher-correction-worker.mjs',import.meta.url),{
    env:{...process.env,WORKBENCH_DATA_DIR:dirname(context.dbPath),FINANCE_AUDIT_DIR:context.auditDir,
      WORKBENCH_DATABASE_MODE:args.action==='inspect'?'readonly':'readwrite'},
    workerData:{args,context},execArgv:[],stdout:true,stderr:true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise((done,reject)=>{
    // 未收到原生结果时不能推断未写入。相同 operationId 可用于恢复。
    let reply;
    worker.once('message',message=>{reply=message;});
    worker.once('error',()=>reject(Object.assign(Error('finance_correction_worker_failed'),{code:'finance_correction_worker_failed'})));
    worker.once('exit',code=>{
      if(code!==0||!reply)reject(Object.assign(Error('finance_correction_worker_failed'),{code:'finance_correction_worker_failed'}));
      else if(reply.error)reject(Object.assign(Error(reply.error),{code:reply.error}));
      else done(reply.result);
    });
  });
}

export async function runDelegatedCorrection(args){
  if(validateSchemaValue(VOUCHER_CORRECTION_SCHEMA,args).length)fail('finance_correction_arguments_invalid');
  const context=delegation(args);
  const result=await execute(args,context);
  // 完整分录和前后摘要留在已绑定账套的本机凭证审计中；模型仅取得核对所需的数值。
  annotateFinanceCall({scope:context.scope,configuredTarget:{databasePath:context.dbPath,
    bindingOrigin:'bound_voucher_correction',accountSetId:args.accountSetId,period:args.period},
    ...(args.action==='apply'?{nativeOperationId:args.operationId}:{})});
  return {...result,callId:currentFinanceCall()?.callId??null};
}
