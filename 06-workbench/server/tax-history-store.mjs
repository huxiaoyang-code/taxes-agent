// 固定规范私有存储；工具不接受任意路径。
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,realpath,lstat,open,readFile,unlink,link} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPrivateDirectory,verifyPrivateFile} from './tax-browser-diagnostic.mjs';
import {validateHistoryRecord,historyRef,historyFail} from './tax-history-contract.mjs';
const WORKSPACE=fileURLToPath(new URL('../../',import.meta.url));
const DEFAULT_ROOT=join(WORKSPACE,'.agent-runs','tax-history-evidence');
const CAPTURE_ROOT=join(WORKSPACE,'.agent-runs','business-query-navigation','evidence');
const fail=()=>historyFail('history_storage_invalid');
async function checked(check,action){check?.();const result=await action();check?.();return result;}
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
export class TaxHistoryStore{
 constructor({root=DEFAULT_ROOT,captureRoot=CAPTURE_ROOT,security={}}={}){this.root=resolve(root);this.captureRoot=resolve(captureRoot);
  this.security={verifyDirectory:verifyPrivateDirectory,verifyFile:verifyPrivateFile,secureDirectory:secureCreatedDirectory,...security};}
 async ready(check){
  check?.();
  if(this.security.testStorage!==true){if(this.root!==resolve(DEFAULT_ROOT)||this.captureRoot!==resolve(CAPTURE_ROOT))throw fail();
   for(const path of [this.root,this.captureRoot])await checked(check,()=>new Promise((yes,no)=>execFile('git',['check-ignore','--quiet','--',path],
    {cwd:WORKSPACE,shell:false,windowsHide:true,timeout:5000,maxBuffer:1024},e=>e?no(fail()):yes())));}
  await canonicalAncestors(dirname(this.root));let created=false;
  try{await mkdir(this.root);created=true}catch(e){if(e.code!=='EEXIST')throw fail();}
  await canonicalAncestors(this.root);if(created)await checked(check,()=>this.security.secureDirectory(this.root));await checked(check,()=>this.security.verifyDirectory(this.root));
 }
 async read(path,max,check){
  check?.();await canonicalAncestors(dirname(path));await checked(check,()=>this.security.verifyDirectory(dirname(path)));
  const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||await realpath(path)!==path)throw fail();
  await checked(check,()=>this.security.verifyFile(path));const h=await open(path,'r');
  try{const stat=await h.stat();if(stat.ino!==before.ino||stat.dev!==before.dev||stat.nlink!==1||stat.size>max)throw fail();
   const text=await h.readFile('utf8'),after=await h.stat(),current=await lstat(path);
   if(Buffer.byteLength(text)>max||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ino!==current.ino
    ||after.dev!==current.dev||current.nlink!==1||current.isSymbolicLink())throw fail();
   await checked(check,()=>this.security.verifyFile(path));return JSON.parse(text);
  }finally{await h.close();}
 }
 async loadArtifact(artifactRef,check){
  if(typeof artifactRef!=='string'||!/^taxquery_[a-f0-9]{48}$/.test(artifactRef))throw fail();await this.ready(check);
  await canonicalAncestors(this.captureRoot);await checked(check,()=>this.security.verifyDirectory(this.captureRoot));
  return this.read(join(this.captureRoot,artifactRef,'manifest.json'),16777216,check);
 }
 async save(kind,value,check){
  check?.();validateHistoryRecord(kind,value);await this.ready(check);const ref='taxhistory'+kind+'_'+randomBytes(24).toString('hex'),
   path=join(this.root,ref+'.json'),staging=path+'.tmp',text=JSON.stringify(value);if(Buffer.byteLength(text)>8388608)throw fail();
  const h=await open(staging,'wx',0o600);let linked=false;
  try{await h.writeFile(text);await h.sync();await h.close();await checked(check,()=>this.security.verifyFile(staging));
   validateHistoryRecord(kind,await this.read(staging,8388608,check));check?.();await link(staging,path);linked=true;await unlink(staging);
   validateHistoryRecord(kind,await this.read(path,8388608,check));return ref;
  }catch(error){if(linked)try{await unlink(path)}catch{throw historyFail('history_publication_unknown');}throw error;
  }finally{await h.close().catch(()=>{});await unlink(staging).catch(()=>{});}
 }
 async load(ref,check){
  const kind=['template','context','run'].find(kind=>historyRef(ref,kind));if(!kind)throw fail();await this.ready(check);
  return validateHistoryRecord(kind,await this.read(join(this.root,ref+'.json'),8388608,check));
 }
}
