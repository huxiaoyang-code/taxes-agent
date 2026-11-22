// 合成操作员的运行目录与真实产品宿主。每项任务均建独立账库。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from '../../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
export const repo=fileURLToPath(new URL('../../../',import.meta.url));
export const read=path=>JSON.parse(readFileSync(path,'utf8'));
export const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
export const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function layout(dir,task) {
  const root=resolve(dir), reviewer=join(root,'reviewer'),data=join(root,'账库'),source=join(root,'业务资料'),audit=join(root,'业务记录');
  mkdirSync(root);
  for(const dir of [reviewer,data,source,audit])mkdirSync(dir);
  return {task,root,reviewer,data,source,audit,dbPath:join(data,'workbench.db')};
}
export function bind(f,name,period) {
  const host=join(f.root,name);
  const run=(script,...args)=>execFileSync(process.execPath,[script,...args],{cwd:f.root,windowsHide:true,encoding:'utf8',env:{...process.env,WORKBENCH_DATA_DIR:f.data}});
  run(join(repo,'06-workbench/scripts/finance-host-config.mjs'),'--host','claude-code','--node',process.execPath,'--api-base',f.apiBase,'--database',f.dbPath,'--source-root',f.source,'--audit-dir',f.audit,'--out',host);
  run(join(host,'start-business-session.mjs'),'--account-set-id',String(f.accountSetId),'--period',period,'--prepare-only');
  return host;
}
export async function stdio(f,fn,host=f.host) {
  const client=new McpStdioClient(join(repo,'05-reconstruction/codex/mcp/finance-mcp/server.mjs'),{cwd:host,env:{...read(join(host,'.mcp.json')).mcpServers.finance.env,WORKBENCH_DATA_DIR:f.data},timeoutMs:30000}).start();
  try {
    await client.initialize('synthetic-product-evaluation');
    return await fn(async(name,args)=>{const r=await client.call(name,args);assert(!r.isError&&r.data?.ok!==false,name+' '+r.text);return r.data;});
  } finally {await client.close();}
}
export function http(base) {
  return async(path,body,method='POST')=>{
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    return {status:response.status,data:await response.json()};
  };
}
export function note(host,name,message){writeFileSync(join(host,name),message+'\n',{flag:'wx'});}
