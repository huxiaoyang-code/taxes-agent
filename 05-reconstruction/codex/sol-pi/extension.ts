// 在未修改的 NVIDIA MIT factory 外增加窄范围财税工作台适配。
// 不可变来源及全部原始哈希见 upstream-manifest.json。
import {readFileSync,appendFileSync,existsSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {createObservationPackExtension} from './upstream/src/sol-pi/extensions/observation-pack/index.ts';
import {createObservation,isPureTextResult,observationPath,ensureStored} from './upstream/src/sol-pi/extensions/observation-pack/observation.ts';
import {runtimeRoot} from './upstream/src/sol-pi/runtime-paths.ts';

const allowed=new Set(['read','bash','powershell']);
export default function financeObservationPack(pi:ExtensionAPI){
  const archive=process.env.FINANCE_SOL_PI_ARCHIVE;
  if(!archive||!isAbsolute(archive)||!existsSync(join(archive,'retention.json'))||!process.env.FINANCE_SOL_PI_FINGERPRINT)throw Error('sol_pi_explicit_verified_launch_required');
  let fatal:string|undefined;
  const hashes=new Map<string,string>();
  const scoped=(ctx:any)=>new Proxy(ctx,{get(target,key){if(key==='sessionManager')return new Proxy(target.sessionManager,{get(manager,name){if(name==='getSessionDir')return ()=>archive;const value=manager[name];return typeof value==='function'?value.bind(manager):value;}});const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const stop=(ctx:any,error:any)=>{fatal=String(error?.message??error);try{appendFileSync(join(archive,'adapter-failures.jsonl'),JSON.stringify({time:new Date().toISOString(),code:'sol_pi_archive_failure',reason:fatal})+'\n');}finally{ctx.abort();}throw Error('sol_pi_archive_failure: '+fatal);};
  const eligible=(message:any)=>message.role!=='toolResult'||(allowed.has(message.toolName)&&!message.structuredContent&&!message.details);
  const proxy=new Proxy(pi,{get(target,key){
    if(key==='on')return (event:string,handler:any)=>{
      if(event!=='context')throw Error('sol_pi_unexpected_official_event');
      return target.on('context',async(event:any,ctx:any)=>{
        const context=scoped(ctx),messages=event.messages.filter(eligible),root=runtimeRoot(context);
        try{
          if(fatal)throw Error(fatal);
          // 上游 factory 失败时会放行；先预检持久化，并在每次投影前再次验证，
          // 保留历史，发现损坏即终止。
          const expectedIds:string[]=[];
          for(const message of messages)if(isPureTextResult(message)){
            const observation=createObservation(message,root);if(!observation)continue;
            await ensureStored(observation);hashes.set(observation.id,observation.contentHash);expectedIds.push(observation.id);
          }
          const ledger=join(root,'observation-pack','ledger.jsonl'),before=expectedIds.length&&existsSync(ledger)?readFileSync(ledger).length:0;
          await handler({...event,messages},context);
          if(expectedIds.length){
            const appended=readFileSync(ledger).subarray(before).toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
            for(const id of expectedIds){const index=appended.findIndex(entry=>entry.id===id&&['full','placeholder'].includes(entry.event));if(index<0)throw Error('Official ObservationPack failed to persist projection evidence');appended.splice(index,1);}
          }
        }catch(error){stop(ctx,error);}
      });
    };
    if(key==='registerTool')return (definition:any)=>{
      if(definition.name!=='obs_recall')throw Error('sol_pi_unexpected_official_tool');
      return target.registerTool({...definition,async execute(id:any,params:any,signal:any,update:any,ctx:any){
        const context=scoped(ctx);
        if(!/^obs_[a-f0-9]{24}$/.test(params.id))throw Error('Unknown observation id');
        const expected=hashes.get(params.id);if(!expected)throw Error('Unknown observation id for this run');
        if(!Number.isInteger(params.offset??0)||(params.offset??0)<0)throw Error('Observation offset invalid');
        try{
          if(fatal)throw Error(fatal);
          const path=observationPath(runtimeRoot(context),params.id),stat=lstatSync(path);
          if(!stat.isFile()||stat.isSymbolicLink())throw Error('Stored observation is not a regular file');
          const bytes=readFileSync(path);
          if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Stored observation hash mismatch');
          if((params.offset??0)<bytes.length&&((bytes[params.offset??0]??0)&0xc0)===0x80)throw Error('Observation offset splits UTF-8 code point');
          return await definition.execute(id,params,signal,update,context);
        }catch(error){stop(ctx,error);}
      }});
    };
    const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
  }});
  createObservationPackExtension()(proxy);
}
