#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedPath, readLocalFile } from '../server/offline-material-store.mjs';
import { runOfflinePeriodPlan, sha, unavailable } from '../server/offline-period-plan.mjs';
export async function runCli(args) {
  if(args.length!==4 || args[0]!=='--input' || args[2]!=='--output' || !args[1] || !args[3])return {exitCode:2,message:'OFFLINE_PERIOD_PLAN_USAGE_ERROR'};
  let h,started=false;
  try {
    const f=await readLocalFile(resolve(args[1])), r=JSON.parse(f.bytes.toString('utf8').replace(/^\uFEFF/,''));
    if(typeof r.inputPath==='string')r.inputPath=resolve(dirname(f.canonicalPath),r.inputPath);
    await checkedPath(dirname(resolve(args[3])),true); h=await open(resolve(args[3]),'wx',0o600); started=true;
    const result=runOfflinePeriodPlan(r); await h.writeFile(JSON.stringify(result,null,2)+'\n'); await h.sync();
    const after=await readLocalFile(f.canonicalPath);
    if(sha(after.bytes)!==sha(f.bytes))throw 0;
    const fresh=runOfflinePeriodPlan(r);
    if(JSON.stringify(fresh)!==JSON.stringify(result))throw 0;
    await h.close();h=null;
    return {exitCode:result.status==='ready_for_manifest'?0:4,message:'OFFLINE_PERIOD_PLAN_RESULT status='+result.status+' authorizesExecution=false'};
  }catch{if(h){try{const bytes=Buffer.from(JSON.stringify(unavailable('period_plan_publication_unverified'))+'\n');await h.write(bytes,0,bytes.length,0);await h.truncate(bytes.length);await h.sync();}catch{}}return {exitCode:4,message:started?'OFFLINE_PERIOD_PLAN_OUTPUT_STALE_OR_UNAVAILABLE authorizesExecution=false':'OFFLINE_PERIOD_PLAN_INPUT_OR_OUTPUT_REJECTED'};}
  finally{await h?.close().catch(()=>{});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=await runCli(process.argv.slice(2));process.stdout.write(r.message+'\n');process.exitCode=r.exitCode;}
