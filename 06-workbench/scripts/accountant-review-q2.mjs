#!/usr/bin/env node
// 仅处理原生请求；财务模块只在全新工作进程中加载。
import { realpath, lstat, open } from 'node:fs/promises';
import { dirname, resolve, join, parse, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertAccountantReviewQ2CodeCurrent } from '../server/accountant-review-q2-code.mjs';
import { runAccountantReviewQ2, invalidateAccountantReviewQ2Output } from '../server/accountant-review-q2.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sameRequestStat=(s,b)=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size===b.size&&s.dev===b.dev&&s.ino===b.ino&&s.birthtimeMs===b.birthtimeMs&&s.mtimeMs===b.mtimeMs&&s.ctimeMs===b.ctimeMs;
async function readRequest(path) {
  const absolute=resolve(path),root=parse(absolute).root; let current=root;
  for(const part of relative(root,absolute).split(/[\\/]/).filter(Boolean)) { current=join(current,part);const s=await lstat(current);if(s.isSymbolicLink()||(current!==absolute&&!s.isDirectory())||(current===absolute&&(!s.isFile()||s.nlink!==1)))throw Error('request_path'); }
  const canonical=await realpath(absolute),before=await lstat(absolute),limit=5*1024*1024;
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error('request_path');
  if(before.size>limit)throw Error('request_size');
  const h=await open(canonical,'r');
  try {
    const held=await h.stat();if(!sameRequestStat(held,before))throw Error('request_changed');
    const b=Buffer.alloc(limit+1);let length=0;
    while(length<=limit){const r=await h.read(b,length,b.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}
    const after=await h.stat(),named=await lstat(absolute);
    if(length>limit||length!==before.size||!sameRequestStat(after,before)||!sameRequestStat(named,before)||await realpath(absolute)!==canonical)throw Error('request_changed');
    return{canonical,bytes:b.subarray(0,length)};
  }finally{await h.close();}
}
export async function runCli(args) {
  if(args.length!==4||args[0]!=='--input'||args[2]!=='--output'||!args[1]||!args[3]) return {exitCode:2,message:'ACCOUNTANT_REVIEW_Q2_USAGE_ERROR'};
  let result, output;
  try {
    const input=resolve(args[1]), {canonical,bytes}=await readRequest(input);
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));
    for(const k of ['priorInputPath','targetInputPath']) if(typeof value?.[k]==='string') value[k]=resolve(dirname(canonical),value[k]);
    if(typeof value?.target?.dbPath==='string') value.target.dbPath=resolve(dirname(canonical),value.target.dbPath);
    output=resolve(args[3]);
    result=await runAccountantReviewQ2(value,output);
    const finalRequest=await readRequest(input);
    if(sha(finalRequest.bytes)!==sha(bytes)||finalRequest.canonical!==canonical) throw Error('request_changed');
    if(result.status==='complete_draft') assertAccountantReviewQ2CodeCurrent(result.codeBinding);
    if(result.status!=='complete_draft') return {exitCode:4,message:`ACCOUNTANT_REVIEW_Q2_REJECTED code=${result.code}`};
    return {exitCode:result.calculationReady?0:3,message:`ACCOUNTANT_REVIEW_Q2_WRITTEN status=complete_draft computation=${result.computationStatus}`};
  } catch {
    if(result) try { await invalidateAccountantReviewQ2Output(result); } catch { /* 保留未知或其他来源的标记。 */ }
    return {exitCode:4,message:'ACCOUNTANT_REVIEW_Q2_REJECTED'};
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) { const r=await runCli(process.argv.slice(2));process.stdout.write(r.message+'\n');process.exitCode=r.exitCode; }
