import {existsSync, statSync, realpathSync, mkdirSync, writeFileSync} from 'node:fs';
import {isAbsolute, resolve, dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function absolute(value,label){if(typeof value!=='string'||!isAbsolute(value)||/[\0\r\n]/.test(value))fail('host_'+label+'_absolute_required');return resolve(value);}
function existing(value,label,kind){const path=absolute(value,label);if(!existsSync(path)||!(kind==='file'?statSync(path).isFile():statSync(path).isDirectory()))fail('host_'+label+'_missing');return realpathSync(path);}
export function createContext({nodePath,apiBase,databasePath,outputDir}){
  nodePath=existing(nodePath,'node','file');
  const db=absolute(databasePath,'database'),out=absolute(outputDir,'output');
  if(existsSync(out))fail('host_output_must_be_new');
  existing(dirname(out),'output_parent','directory');
  if(typeof apiBase!=='string')fail('host_api_base_required');
  let url;try{url=new URL(apiBase);}catch{fail('host_api_base_invalid');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.port)fail('host_api_base_loopback_required');
  const serverPath=join(repoRoot,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),skillsDir=join(repoRoot,'05-reconstruction/codex/skills');
  const mcpEnv={FINANCE_MCP_PROFILE:'harness',FINANCE_API_BASE:url.origin,FINANCE_DATABASE_PATH:db,FINANCE_SKILLS_DIR:skillsDir};
  return {repoRoot,nodePath,serverPath,skillsDir,apiBase:url.origin,databasePath:db,outputDir:out,mcpEnv,mcp:{command:nodePath,args:[serverPath],env:mcpEnv,cwd:repoRoot}};
}
export function writeBundle(context,bundle){
  if(!Array.isArray(bundle?.files)||!bundle.files.length)fail('host_files_required');
  const names=new Set();
  for(const file of bundle.files){
    if(typeof file.path!=='string'||!file.path||isAbsolute(file.path)||file.path.includes('\\')||file.path.split('/').some(p=>!p||p==='.'||p==='..')||/[\0\r\n:]/.test(file.path)||typeof file.content!=='string')fail('host_file_invalid');
    const path=resolve(context.outputDir,file.path),rel=relative(context.outputDir,path);if(rel.startsWith('..'+sep)||isAbsolute(rel)||names.has(path.toLowerCase()))fail('host_file_invalid');names.add(path.toLowerCase());
  }
  mkdirSync(context.outputDir); // 仅允许全新独占输出，绝不合并到用户配置。
  for(const file of bundle.files){const path=join(context.outputDir,file.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,file.content,{encoding:'utf8',flag:'wx'});}
  return {outputDir:context.outputDir,files:bundle.files.map(f=>f.path),notes:bundle.notes??[],modelInvoked:false};
}
