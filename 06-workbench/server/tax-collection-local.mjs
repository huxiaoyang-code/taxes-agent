// Local-only private storage and cross-checkout exclusion. Never return local paths.
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,realpath,lstat,open,readFile,unlink,rename} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPrivateDirectory,verifyPrivateFile} from './tax-browser-diagnostic.mjs';
import {validateEvidence,requireActiveSource} from './tax-collection-contract.mjs';
const DEFAULT_ROOT=fileURLToPath(new URL('../../.agent-runs/tax-collection-evidence/',import.meta.url));
const WORKSPACE=fileURLToPath(new URL('../../',import.meta.url));
const REF=/^tax(?:source|run)_[a-f0-9]{48}$/;
const LOCK='YoushuCollectionLockV1.json';
const RECOVERY='YoushuCollectionRecoveryV1.json';
const fail=()=>new Error('tax_collection_local_failed');
async function secureCreatedDirectory(path){
  if(process.platform!=='win32')throw fail();
  const script=`$ErrorActionPreference='Stop'
$path=$env:TAX_COLLECTION_PRIVATE_PATH
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($allowed in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($allowed,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
[IO.Directory]::SetAccessControl($path,$acl)
[Console]::Write('secured')`;
  const output=await new Promise((yes,no)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {shell:false,windowsHide:true,timeout:10000,maxBuffer:1024,env:{...process.env,TAX_COLLECTION_PRIVATE_PATH:path}},
    (error,stdout)=>error?no(fail()):yes(String(stdout))));
  if(output!=='secured')throw fail();
}
async function canonicalAncestors(path){
  let cursor=resolve(path);
  for(;;){const info=await lstat(cursor);if(info.isSymbolicLink()||await realpath(cursor)!==cursor)throw fail();
    const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
}
export class TaxCollectionStore{
  constructor({root=process.env.TAX_COLLECTION_EVIDENCE_ROOT||DEFAULT_ROOT,security={}}={}){
    this.root=resolve(root);this.security={verifyDirectory:verifyPrivateDirectory,verifyFile:verifyPrivateFile,secureDirectory:secureCreatedDirectory,...security};
  }
  async ready(){
    if(this.security.testStorage!==true){
      if(this.root!==resolve(DEFAULT_ROOT))throw fail();
      await new Promise((yes,no)=>execFile('git',['check-ignore','--quiet','--',this.root],
        {cwd:WORKSPACE,shell:false,windowsHide:true,timeout:5000,maxBuffer:1024},error=>error?no(fail()):yes()));
    }
    const parent=dirname(this.root);await canonicalAncestors(dirname(parent));
    try{await mkdir(parent)}catch(e){if(e.code!=='EEXIST')throw fail()}
    await canonicalAncestors(parent);
    let created=false;try{await mkdir(this.root);created=true}catch(e){if(e.code!=='EEXIST')throw fail()}
    await canonicalAncestors(this.root);if(created)await this.security.secureDirectory(this.root);
    await this.security.verifyDirectory(this.root);
  }
  async save(kind,value){
    if(!['source','run'].includes(kind))throw fail();validateEvidence(kind,value);
    if(kind==='source')requireActiveSource(value);
    const text=JSON.stringify(value);if(Buffer.byteLength(text)>4194304)throw fail();await this.ready();
    const ref='tax'+kind+'_'+randomBytes(24).toString('hex'),file=join(this.root,ref+'.json');
    const staging=file+'.tmp',handle=await open(staging,'wx',0o600);
    try{await handle.writeFile(text);await handle.sync()}finally{await handle.close()}
    try{await this.security.verifyFile(staging);validateEvidence(kind,JSON.parse(await readFile(staging,'utf8')));
      await rename(staging,file);await this.security.verifyFile(file);return ref;
    }finally{await unlink(staging).catch(()=>{})}
  }
  async load(ref){
    if(typeof ref!=='string'||!REF.test(ref))throw fail();await this.ready();
    const path=join(this.root,ref+'.json');await this.security.verifyFile(path);
    const handle=await open(path,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.size>4194304)throw fail();
      const text=await handle.readFile('utf8');if(Buffer.byteLength(text)>4194304)throw fail();
      return validateEvidence(ref.startsWith('taxsource_')?'source':'run',JSON.parse(text));
    }finally{await handle.close()}
  }
}
export async function collectionLock(profilePath,{security={},scope}={}){
  const d={verifyDirectory:verifyPrivateDirectory,verifyFile:verifyPrivateFile,...security};
  await canonicalAncestors(profilePath);await d.verifyDirectory(profilePath);
  try{await lstat(join(profilePath,RECOVERY));throw new Error('tax_collection_busy')}catch(error){if(error.code!=='ENOENT')throw error}
  const file=join(profilePath,LOCK),nonce=randomBytes(24).toString('hex');
  let handle;try{handle=await open(file,'wx',0o600)}catch{throw new Error('tax_collection_busy')}
  try{await handle.writeFile(JSON.stringify({version:1,nonce,ownerPid:process.pid,scope}));await handle.sync()}finally{await handle.close()}
  await d.verifyFile(file);let ended=false;
  return{async release(){if(ended)return;await d.verifyFile(file);const current=JSON.parse(await readFile(file,'utf8'));
    if(current.nonce!==nonce||current.ownerPid!==process.pid)throw fail();await unlink(file);ended=true;},
    retain(){ended=true;}};
}
async function privateJson(path,d){
  await d.verifyFile(path);const handle=await open(path,'r');
  try{const info=await handle.stat();if(!info.isFile()||info.size>4096)throw fail();
    const text=await handle.readFile('utf8');if(Buffer.byteLength(text)>4096)throw fail();return JSON.parse(text);
  }finally{await handle.close()}
}
export async function readCollectionLock(profilePath,{security={}}={}){
  const d={verifyDirectory:verifyPrivateDirectory,verifyFile:verifyPrivateFile,...security};
  await canonicalAncestors(profilePath);await d.verifyDirectory(profilePath);
  const value=await privateJson(join(profilePath,LOCK),d);
  if(!value||Object.keys(value).length!==4||value.version!==1||!/^[a-f0-9]{48}$/.test(value.nonce||'')
    ||!Number.isSafeInteger(value.ownerPid)||value.ownerPid<=0||value.ownerPid>2147483647
    ||!value.scope||typeof value.scope!=='object'||Array.isArray(value.scope))throw fail();
  return value;
}
export async function collectionRecoveryLock(profilePath,expected,{security={}}={}){
  const d={verifyDirectory:verifyPrivateDirectory,verifyFile:verifyPrivateFile,...security};
  const matches=current=>current.nonce===expected.nonce&&current.ownerPid===expected.ownerPid
    &&JSON.stringify(current.scope)===JSON.stringify(expected.scope);
  if(!matches(await readCollectionLock(profilePath,{security:d})))throw fail();
  const file=join(profilePath,RECOVERY),nonce=randomBytes(24).toString('hex');
  let handle;try{handle=await open(file,'wx',0o600)}catch{throw new Error('tax_collection_recovery_busy')}
  try{await handle.writeFile(JSON.stringify({version:1,nonce,ownerPid:process.pid}));await handle.sync()}finally{await handle.close()}
  await d.verifyFile(file);let released=false;
  const ownMutex=async()=>{const current=await privateJson(file,d);if(current.nonce!==nonce||current.ownerPid!==process.pid)throw fail()};
  return{
    async verifyOriginal(){await ownMutex();if(!matches(await readCollectionLock(profilePath,{security:d})))throw fail();},
    async releaseOriginal(){await this.verifyOriginal();await unlink(join(profilePath,LOCK));},
    async close(){if(released)return;await ownMutex();await unlink(file);released=true;},
  };
}
