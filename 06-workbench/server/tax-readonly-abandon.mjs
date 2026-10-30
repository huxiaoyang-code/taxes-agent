// 显式本机管理员能力，不通过 HTTP、Agent 或 MCP 导出。
// 这里只退役已审计的只读操作，不会停止渲染器或请求，
// 不能证明执行域已销毁，也不阻止延迟响应或 Set-Cookie。
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {open,lstat,unlink,realpath,link} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {TaxCollectionStore,readCollectionLock,collectionRecoveryLock} from './tax-collection-local.mjs';
import {verifyPrivateFile,verifyPrivateDirectory,openRegisteredBrowserDiagnostic} from './tax-browser-diagnostic.mjs';
import {TaxBrowserError} from './tax-browser-transport.mjs';
import {validateEvidence} from './tax-collection-contract.mjs';
import {pageReference} from '../scripts/inventory-tax-browser.mjs';

export const READONLY_AUDIT_VERSION='legacy_identity_before_c1d663a7_8FD7E4AFDACE_v1';
const AUDIT=Object.freeze({version:1,operatorAttested:true,phase:'identity_before',
  generatorCommit:'c1d663a7b107f8538e01100a37c0b1102b9c02aa',
  generatorBlob:'a5f850069a9693e720360677aa07e513ce64b805',loadedBytesProof:false,
  prototypeDigestPrefix:'8FD7E4AFDACE',prototypeBytesRecovered:false,
  identityGetOnly:true,hostChainStoppedBeforeFiling:true,hostResultConsumerExited:true,
  browserScriptHasNoHostFollowup:true,performedCounterProvesNoRequest:false,
  terminationProven:false,lateSessionEffectsPossible:true});
const LOCK='YoushuCollectionLockV1.json',MUTEX='YoushuCollectionRecoveryV1.json';
const fail=()=>new Error('tax_readonly_abandon_failed');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function lockShape(v,sourceRef){
  if(!exact(v,['version','nonce','ownerPid','scope'])||v.version!==1||!/^[a-f0-9]{48}$/.test(v.nonce||'')
    ||!Number.isSafeInteger(v.ownerPid)||v.ownerPid<=0||v.ownerPid>2147483647
    ||!exact(v.scope,['sourceRef','operation'])||v.scope.sourceRef!==sourceRef||v.scope.operation!=='business_page_prepare')throw fail();
  return v;
}
function mutexShape(v){
  if(!exact(v,['version','nonce','ownerPid'])||v.version!==1||!/^[a-f0-9]{48}$/.test(v.nonce||'')
    ||!Number.isSafeInteger(v.ownerPid)||v.ownerPid<=0||v.ownerPid>2147483647)throw fail();return v;
}
async function ownerAlive(pid){
  try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw fail()}
}
// 持久恢复文件在崩溃后仍排除普通采集者；
// 操作系统互斥锁进一步串行化接管死进程文件的管理员，
// 防止两个恢复进程同时提前退役其互斥保护。
// 辅助进程无浏览器权限；关闭 stdin 即释放操作系统互斥锁，
// Node 管理员意外退出时也一样。
export async function acquireReadonlyAdminGuard(profile){
  if(process.platform!=='win32')throw fail();
  const script=`$ErrorActionPreference='Stop'
$held=$false
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security=[Security.AccessControl.MutexSecurity]::new()
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true,$false)
foreach ($allowed in @($sid,$system)) {
 $security.AddAccessRule([Security.AccessControl.MutexAccessRule]::new($allowed,'FullControl','Allow'))
}
$created=$false
$mutex=[Threading.Mutex]::new($false,$env:TAX_ABANDON_MUTEX,[ref]$created,$security)
try {
 $actual=$mutex.GetAccessControl()
 if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'acl' }
 $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if ($rules.Count -ne 2) { throw 'rules' }
 foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18') -or $rule.AccessControlType -ne 'Allow' -or $rule.MutexRights -ne 'FullControl' -or $rule.IsInherited) { throw 'rule' }
 }
 try { $held=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held=$true }
 if (-not $held) { [Console]::WriteLine('busy'); exit 2 }
 [Console]::WriteLine('held')
 [Console]::Out.Flush()
 [void][Console]::ReadLine()
} finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,TAX_ABANDON_MUTEX:'Global\\YoushuTaxAbandon_'+hash(Buffer.from(profile))}});
  child.stdin.on('error',()=>{});
  let held=false,exited=false;
  const ended=new Promise(done=>{child.once('exit',()=>{exited=true;held=false;done()});child.once('error',()=>{exited=true;held=false;done()});});
  const close=async()=>{child.stdin.end();let timer;
    try{await Promise.race([ended,new Promise(done=>{timer=setTimeout(()=>{child.kill();done()},3000)})]);}
    finally{clearTimeout(timer)}
    await ended;
  };
  try{await new Promise((yes,no)=>{
    let text='',timer=setTimeout(()=>no(fail()),5000);
    const finish=error=>{clearTimeout(timer);error?no(fail()):yes()};
    child.stdout.on('data',bytes=>{text+=String(bytes);if(text==='held\r\n'||text==='held\n'){held=true;finish();}else if(text.length>16||text.includes('\n'))finish(true)});
    child.once('exit',()=>finish(true));child.once('error',()=>finish(true));
  });}catch{await close();throw fail()}
  const guard={verify(){if(!held||exited)throw fail()},close};
  // 仅供本机冒烟核验，不可枚举、不写日志，也不向模型暴露。
  Object.defineProperty(guard,'helperPid',{value:child.pid});return guard;
}
async function bounded(path,d,limit=16384){
  await d.verifyFile(path);const h=await open(path,'r');
  try{const s=await h.stat();if(!s.isFile()||s.size>limit)throw fail();
    const buffer=Buffer.alloc(limit+1),{bytesRead}=await h.read(buffer,0,buffer.length,0);
    if(bytesRead>limit)throw fail();return buffer.subarray(0,bytesRead);
  }finally{await h.close()}
}
async function maybe(path,d){try{return await bounded(path,d)}catch(e){if(e.code==='ENOENT')return null;throw e}}
async function createDurable(path,bytes,d){
  // 使用独占链接发布完整不可变字节；写入期间崩溃只会留下
  // 无引用的私有 staging 文件，绝不留下部分 prepare/commit 标记。
  // 既有证据永不覆盖。
  const staging=path+'.'+randomBytes(16).toString('hex')+'.tmp';
  try{
    const h=await open(staging,'wx',0o600);
    try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}
    await d.verifyFile(staging);await link(staging,path);await d.verifyFile(path);
    const published=await open(path,'r+');try{await published.sync()}finally{await published.close()}
    if(!(await bounded(path,d)).equals(Buffer.from(bytes)))throw fail();
  }finally{await unlink(staging).catch(()=>{})}
}
async function checkPath(path,d){
  let current=resolve(path);
  for(;;){const s=await lstat(current);if(s.isSymbolicLink()||await realpath(current)!==current)throw fail();
    const parent=dirname(current);if(current===parent)break;current=parent;}
  await d.verifyDirectory(path);
}
const safeResult=(status,phase,extra={})=>({status,phase,requestTermination:status==='abandoned_readonly'||extra.abandonedStateCommitted===true?'unknown_abandoned':'unknown',
  realmDestructionProven:false,lateSessionEffectsPossible:true,oldResultConsumption:'permanently_forbidden',
  auditTrust:'operator_attested_not_loaded_bytes_proof',
  newSourceRequired:true,newDocumentScopeRequired:true,newIdentityVerificationRequired:true,businessScopeVerified:false,...extra});

export async function abandonReadonlyOperation(args={},overrides={}){
  const d={store:new TaxCollectionStore(),openDiagnostic:openRegisteredBrowserDiagnostic,
    readLock:readCollectionLock,acquireRecovery:collectionRecoveryLock,isOwnerAlive:ownerAlive,
    verifyFile:verifyPrivateFile,verifyDirectory:verifyPrivateDirectory,acquireAdminGuard:acquireReadonlyAdminGuard,checkpoint:async()=>{},...overrides};
  let transport,guard,result,journalPaths,recoveryPath,expectedMarker;
  let phase='validation',mutex,prepared=false,retired=false,committed=false;
  try{
    if(!args||typeof args!=='object'||Array.isArray(args)||!Object.hasOwn(args,'sourceRef')
      ||Object.keys(args).some(k=>!['sourceRef','execute','resume','auditVersion'].includes(k))
      ||!/^taxsource_[a-f0-9]{48}$/.test(args.sourceRef||'')
      ||args.execute!==undefined&&typeof args.execute!=='boolean'||args.resume!==undefined&&typeof args.resume!=='boolean'
      ||args.auditVersion!==undefined&&args.auditVersion!==READONLY_AUDIT_VERSION
      ||args.resume===true&&args.execute!==true)throw fail();
    if(args.execute===true&&args.auditVersion!==READONLY_AUDIT_VERSION)throw fail();
    phase='source';const source=validateEvidence('source',await d.store.load(args.sourceRef));
    if(source.version!==1||source.pageRef!==pageReference(source.registrationRef,source.targetId))throw fail();
    await d.store.ready();await checkPath(d.store.root,d);
    const base=join(d.store.root,`abandon_${args.sourceRef}`),paths={archive:base+'.lock.bin',prepare:base+'.prepare.json',commit:base+'.commit.json',finished:base+'.finished.json'};
    journalPaths=paths;
    phase='registration';transport=await d.openDiagnostic({registrationRef:source.registrationRef,registrationRoot:source.registrationRoot},
      {registrationBase:dirname(resolve(source.registrationRoot))});
    const local=transport.localScope;
    if(local?.browserKey!==source.browserKey||local.registrationState!=='quarantined')throw fail();
    const profile=local.profilePath;await checkPath(profile,d);
    if(args.execute===true){phase='admin_exclusion';guard=await d.acquireAdminGuard(profile);guard.verify();}
    const lockPath=join(profile,LOCK),mutexPath=join(profile,MUTEX);
    recoveryPath=mutexPath;
    const verifyRegistration=async()=>{guard?.verify();if(await local.currentRegistrationState()!=='quarantined'||local.browserKey!==source.browserKey)throw fail();guard?.verify();};
    await verifyRegistration();
    phase='journal';const prepareBytes=await maybe(paths.prepare,d),commitBytes=await maybe(paths.commit,d),finishBytes=await maybe(paths.finished,d);
    let original,expected,record;
    if(prepareBytes){
      if(args.resume!==true) return result=safeResult('resume_required',phase,{lockRetired:false});
      record=JSON.parse(prepareBytes);
      if(!exact(record,['version','state','sourceRef','sourceDigest','browserKey','profilePath','originalSha256','mutex','attestation'])
        ||record.version!==1||record.state!=='prepared'||record.sourceRef!==args.sourceRef
        ||record.sourceDigest!==hash(Buffer.from(canonical(source)))||record.browserKey!==source.browserKey||record.profilePath!==profile
        ||canonical(record.attestation)!==canonical(AUDIT)||!/^[a-f0-9]{64}$/.test(record.originalSha256||''))throw fail();
      mutex=mutexShape(record.mutex);original=await bounded(paths.archive,d);
      if(hash(original)!==record.originalSha256)throw fail();expected=lockShape(JSON.parse(original),args.sourceRef);
      prepared=true;
      const marker={version:1,state:'abandoned_readonly',prepareSha256:hash(prepareBytes),requestTermination:'unknown_abandoned',oldResultConsumption:'permanently_forbidden'};
      expectedMarker=marker;
      if(commitBytes){if(canonical(JSON.parse(commitBytes))!==canonical(marker))throw fail();committed=true;}
      if(finishBytes){
        if(!committed||canonical(JSON.parse(finishBytes))!==canonical({version:1,state:'finished',commitSha256:hash(commitBytes)}))throw fail();
        const mutexBytes=await maybe(mutexPath,d);
        if(mutexBytes){
          if(canonical(mutexShape(JSON.parse(mutexBytes)))!==canonical(mutex)||await d.isOwnerAlive(mutex.ownerPid)
            ||await maybe(lockPath,d)!==null)throw fail();
          await verifyRegistration();await unlink(mutexPath);
        }
        // 原始互斥锁消失后，绝不触碰新的规范锁。
        return result=safeResult('abandoned_readonly','finished',{lockRetired:true,resumed:true});
      }
      const actual=mutexShape(JSON.parse(await bounded(mutexPath,d)));
      if(canonical(actual)!==canonical(mutex)||await d.isOwnerAlive(actual.ownerPid))throw fail();
    }else{
      if(commitBytes||finishBytes)throw fail();
      phase='lock';expected=lockShape(await d.readLock(profile),args.sourceRef);
      original=await bounded(lockPath,d);if(canonical(JSON.parse(original))!==canonical(expected))throw fail();
      if(await d.isOwnerAlive(expected.ownerPid))return result=safeResult('owner_alive',phase,{lockRetired:false});
      const orphanBytes=await maybe(mutexPath,d);
      if(orphanBytes){
        if(args.resume!==true)return result=safeResult('resume_required',phase,{lockRetired:false});
        mutex=mutexShape(JSON.parse(orphanBytes));if(await d.isOwnerAlive(mutex.ownerPid))throw fail();
      }else if(args.resume===true)throw fail();
    }
    const verifyMutex=async()=>{
      const actual=mutexShape(JSON.parse(await bounded(mutexPath,d)));
      if(canonical(actual)!==canonical(mutex))throw fail();
      if(actual.ownerPid!==process.pid&&await d.isOwnerAlive(actual.ownerPid))throw fail();
    };
    const verifyOriginal=async({absentAllowed=false}={})=>{
      await verifyMutex();await verifyRegistration();if(await d.isOwnerAlive(expected.ownerPid))throw fail();
      const bytes=await maybe(lockPath,d);
      if(bytes===null){if(!absentAllowed)throw fail();return false;}
      lockShape(JSON.parse(bytes),args.sourceRef);if(!bytes.equals(original))throw fail();return true;
    };
    phase='target';let targetMissing=false;
    try{await transport.cdp.send('Target.getTargetInfo',{targetId:source.targetId},{timeoutMs:5000});}
    catch(error){if(!(error instanceof TaxBrowserError)||error.code!=='tax_browser_target_not_found')throw fail();targetMissing=true;}
    if(!targetMissing)throw fail();
    const list=await transport.cdp.send('Target.getTargets',{filter:[{}]},{timeoutMs:5000});
    if(!Array.isArray(list?.targetInfos)||list.targetInfos.length>10000
      ||list.targetInfos.some(t=>!t||typeof t.targetId!=='string'||t.targetId===source.targetId))throw fail();
    await verifyRegistration();if(await d.isOwnerAlive(expected.ownerPid))throw fail();
    if(args.execute!==true)return result=safeResult('diagnosed',phase,{lockRetired:false,targetAbsent:true,operatorAttestationRequired:true});
    if(!mutex){
      phase='mutex';await d.acquireRecovery(profile,expected);
      mutex=mutexShape(JSON.parse(await bounded(mutexPath,d)));if(mutex.ownerPid!==process.pid)throw fail();
      await d.checkpoint('mutex_created');
    }
    await verifyOriginal({absentAllowed:committed});
    if(!prepared){
      phase='archive';const archive=await maybe(paths.archive,d);
      if(archive){if(!archive.equals(original))throw fail();}else await createDurable(paths.archive,original,d);
      await d.checkpoint('archive_durable');await verifyOriginal();
      record={version:1,state:'prepared',sourceRef:args.sourceRef,sourceDigest:hash(Buffer.from(canonical(source))),browserKey:source.browserKey,
        profilePath:profile,originalSha256:hash(original),mutex,attestation:AUDIT};
      await createDurable(paths.prepare,JSON.stringify(record),d);prepared=true;await d.checkpoint('prepare_durable');
    }
    phase='commit';const actualPrepare=await bounded(paths.prepare,d);
    if(canonical(JSON.parse(actualPrepare))!==canonical(record))throw fail();
    if(!committed){
      await verifyOriginal();
      expectedMarker={version:1,state:'abandoned_readonly',prepareSha256:hash(actualPrepare),
        requestTermination:'unknown_abandoned',oldResultConsumption:'permanently_forbidden'};
      await createDurable(paths.commit,JSON.stringify(expectedMarker),d);
      committed=true;await d.checkpoint('commit_durable');
    }
    phase='retire';if(await verifyOriginal({absentAllowed:true})){
      await d.checkpoint('before_retire');await verifyOriginal();await unlink(lockPath);
    }
    retired=true;await d.checkpoint('lock_retired');
    phase='finish';const actualCommit=await bounded(paths.commit,d);
    await createDurable(paths.finished,JSON.stringify({version:1,state:'finished',commitSha256:hash(actualCommit)}),d);
    await d.checkpoint('finished_durable');await verifyMutex();await verifyRegistration();
    await unlink(mutexPath);await d.checkpoint('mutex_retired');
    return result=safeResult('abandoned_readonly','finished',{lockRetired:true,resumed:args.resume===true});
  }catch{
    // 发布先于 ACL 和读回核验；await 被拒绝时，磁盘可能已经
    // 存在完整持久化状态，因此不能凭内存布尔值作否定结论。
    // 状态不可读时，须显式保留 unknown。
    let commitState=committed?true:'unknown',resumeRequired=mutex||prepared?true:'unknown';
    if(!committed&&journalPaths){
      try{const bytes=await maybe(journalPaths.commit,d);
        commitState=bytes===null?false:expectedMarker&&canonical(JSON.parse(bytes))===canonical(expectedMarker)?true:'unknown';
      }catch{commitState='unknown'}
    }
    if(resumeRequired!==true&&recoveryPath){
      try{resumeRequired=await maybe(recoveryPath,d)!==null}catch{resumeRequired='unknown'}
    }
    return result=safeResult('abandon_failed',phase,{lockRetired:retired,resumeRequired,abandonedStateCommitted:commitState});
  }finally{
    let transportCleanupConfirmed=true,adminGuardCleanupConfirmed=true;
    try{await transport?.close()}catch{transportCleanupConfirmed=false}
    try{await guard?.close()}catch{adminGuardCleanupConfirmed=false}
    if(result){
      result.transportCleanupConfirmed=transportCleanupConfirmed;result.adminGuardCleanupConfirmed=adminGuardCleanupConfirmed;
      result.cleanupConfirmed=transportCleanupConfirmed&&adminGuardCleanupConfirmed;
      if(!result.cleanupConfirmed){
        result.operationStatus=result.status;result.status='abandon_cleanup_failed';
        result.abandonedStateCommitted??=committed?true:'unknown';
        if(result.abandonedStateCommitted===true)result.requestTermination='unknown_abandoned';
      }
    }
  }
}
