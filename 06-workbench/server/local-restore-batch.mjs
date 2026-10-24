// Explicit restore intent and path binding. No default database, callbacks or SQL input.
import fs from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { restoreCanonical, restoreHash, restoreError, plainRestorePath, restorePathKey, assertRestoreControl } from './local-restore-control.mjs';
const fail=code=>{throw restoreError(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const hash=b=>createHash('sha256').update(b).digest('hex');
const inside=(a,b)=>{a=restorePathKey(a);b=restorePathKey(b);return a===b||a.startsWith(b+sep);};
const overlap=(a,b)=>inside(a,b)||inside(b,a);
const canonicalPath=p=>{if(typeof p!=='string'||!isAbsolute(p)||resolve(p)!==p||/[\x00-\x1f]/.test(p))fail('restore_plan_invalid');return p;};
const idPair=({dev,ino})=>({dev,ino});

export async function checkRestoreBatch(args={}) {
 const LB=await import('./local-backup.mjs');return LB.checkRestoreTarget(args);
}
export async function activateRestoreBatch(args={}) {
 const LB=await import('./local-backup.mjs');return LB.activateRestoreTarget(args);
}
/** Reject duplicate JSON object keys before JSON.parse can discard them. */
export function readRestorePlanFile(file) {
 const identity=plainRestorePath(file),text=fs.readFileSync(file,'utf8'),after=plainRestorePath(file);
 if(identity.dev!==after.dev||identity.ino!==after.ino||Buffer.byteLength(text)>4*1024*1024)fail('restore_plan_invalid');
 let pos=0;const ws=()=>{while(/\s/.test(text[pos]??'')&&pos<text.length)pos++;};
 const string=()=>{const m=/^"(?:[^"\\]|\\.)*"/.exec(text.slice(pos));if(!m)fail('restore_plan_invalid');pos+=m[0].length;return JSON.parse(m[0]);};
 const value=()=>{
  ws();const c=text[pos];
  if(c==='{'){pos++;ws();const keys=new Set();if(text[pos]==='}'){pos++;return;}for(;;){ws();const key=string();if(keys.has(key))fail('restore_plan_invalid');keys.add(key);ws();if(text[pos++]!==':')fail('restore_plan_invalid');value();ws();const end=text[pos++];if(end==='}')return;if(end!==',')fail('restore_plan_invalid');}}
  if(c==='['){pos++;ws();if(text[pos]===']'){pos++;return;}for(;;){value();ws();const end=text[pos++];if(end===']')return;if(end!==',')fail('restore_plan_invalid');}}
  if(c==='"'){string();return;}
  const m=/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));if(!m)fail('restore_plan_invalid');pos+=m[0].length;
 };
 value();ws();if(pos!==text.length)fail('restore_plan_invalid');return JSON.parse(text);
}
/** Read only: every existing job/input/report must occur exactly once. */
export function validateRestorePlan(db,raw,{targetDir,backupDir,ledgerPath,outDir,activation}={}) {
 restoreCanonical(raw);
 if(!exact(raw,['version','targetInstanceId','jobs'])||raw.version!==1||raw.targetInstanceId!==assertRestoreControl(db).row.target_instance_id||!Array.isArray(raw.jobs))fail('restore_plan_invalid');
 const installed=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_batch_jobs'").get();
 const jobs=(installed?db.prepare('SELECT * FROM local_batch_jobs ORDER BY job_key').all():[]).filter(j=>!activation||activation.outputs.some(o=>o.jobId===j.id));
 const historicalSources=installed?db.prepare('SELECT job_id,source_path FROM local_batch_inputs WHERE source_path IS NOT NULL').all().filter(i=>!activation||activation.outputs.some(o=>o.jobId===i.job_id)).map(i=>restorePathKey(i.source_path)):[];
 if(raw.jobs.length!==jobs.length||new Set(raw.jobs.map(j=>j.jobKey)).size!==jobs.length)fail('restore_plan_incomplete');
 const result={version:1,targetInstanceId:raw.targetInstanceId,jobs:[]},inputs=[],outputs=[];
 const protectedRoots=[targetDir,backupDir,dirname(ledgerPath),...(outDir?[outDir]:[])].map(canonicalPath);
 const roots=[];
 for(const job of jobs){
  const p=raw.jobs.find(j=>j.jobKey===job.job_key);
  if(!exact(p,['jobKey','outputRoot','inputs','reports'])||!Array.isArray(p.inputs)||!Array.isArray(p.reports))fail('restore_plan_invalid');
  const root=canonicalPath(p.outputRoot);
  // Compare history as text only. Never stat, read or discover an old root.
  if(protectedRoots.some(r=>overlap(root,r))||jobs.some(j=>overlap(root,j.output_dir))||historicalSources.some(file=>inside(file,root))||roots.some(r=>overlap(root,r)))fail('restore_path_conflict');
  roots.push(root);
  let identity=null;
  if(fs.existsSync(root))identity=idPair(plainRestorePath(root,{directory:true}));else plainRestorePath(root,{absent:true});
  if(identity&&!activation){
   const allowed=new Set(db.prepare('SELECT relative_path FROM local_batch_artifacts WHERE job_id=?').all(job.id).map(a=>restorePathKey(resolve(root,a.relative_path))));
   const scan=(dir,depth=0)=>{
    if(depth>8)fail('restore_path_conflict');plainRestorePath(dir,{directory:true});
    for(const name of fs.readdirSync(dir)){
     const child=join(dir,name),st=fs.lstatSync(child);
     if(st.isDirectory()){if(![...allowed].some(file=>inside(file,child)))fail('restore_output_unknown_file');scan(child,depth+1);}
     else {plainRestorePath(child);if(!allowed.has(restorePathKey(child)))fail('restore_output_unknown_file');}
    }
   };scan(root);
  }
  outputs.push({jobId:job.id,root,identity});
  const saved=db.prepare('SELECT * FROM local_batch_inputs WHERE job_id=? ORDER BY input_key').all(job.id).filter(i=>!activation||activation.inputs.some(a=>a.inputKey===i.input_key));
  const reports=db.prepare("SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.job_id=? AND s.stage_key LIKE 'report:%' ORDER BY s.id").all(job.id).filter(r=>!activation||activation.plan.jobs.some(j=>j.reports.some(a=>a.stageId===r.id)));
  if(p.inputs.length!==saved.length||new Set(p.inputs.map(i=>i.inputKey)).size!==saved.length||p.reports.length!==reports.length||new Set(p.reports.map(r=>r.stageId)).size!==reports.length)fail('restore_plan_incomplete');
  const norm={jobKey:job.job_key,outputRoot:root,inputs:[],reports:[]};
  for(const input of saved){
   const b=p.inputs.find(i=>i.inputKey===input.input_key);
   if(!exact(b,['inputKey','mode','source'])||!['source','inline','saved_snapshot'].includes(b.mode)||b.mode!=='source'&&b.source!==null||b.mode==='inline'&&input.source_path!==null)fail('restore_plan_invalid');
   const bytes=Buffer.from(input.content);
   if(bytes.length!==input.bytes||hash(bytes)!==input.source_hash)fail('restore_input_changed');
   const record={inputKey:input.input_key,mode:b.mode,source:b.source,identity:null};
   if(b.mode==='source'){
    const file=canonicalPath(b.source);
    if(protectedRoots.some(r=>inside(file,r))||jobs.some(j=>inside(file,j.output_dir))||roots.some(r=>inside(file,r))||historicalSources.includes(restorePathKey(file)))fail('restore_path_conflict');
    const before=plainRestorePath(file),actual=fs.readFileSync(file),after=plainRestorePath(file);
    if(before.dev!==after.dev||before.ino!==after.ino||actual.length!==input.bytes||hash(actual)!==input.source_hash)fail('restore_input_changed');
    record.identity=idPair(before);
   }
   inputs.push(record);norm.inputs.push({inputKey:b.inputKey,mode:b.mode,source:b.source});
  }
  for(const report of reports){
   const r=p.reports.find(r=>r.stageId===report.id);
   if(!exact(r,['stageId','action'])||!['preserve','review','rebuild'].includes(r.action)||r.action==='rebuild'&&report.attempt===0)fail('restore_plan_invalid');
   norm.reports.push({stageId:r.stageId,action:r.action});
  }
  result.jobs.push(norm);
 }
 // Cross-job source/output aliases are checked after collecting every root.
 if(inputs.some(i=>i.source&&roots.some(r=>inside(i.source,r))))fail('restore_path_conflict');
 return {plan:result,planDigest:restoreHash(result),inputs,outputs};
}
export function restorePlanRequirements(db) {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_batch_jobs'").get())return [];
 return db.prepare('SELECT id,job_key FROM local_batch_jobs ORDER BY job_key').all().map(j=>({jobKey:j.job_key,
  inputs:db.prepare('SELECT input_key,source_hash,bytes,source_path IS NULL AS was_inline FROM local_batch_inputs WHERE job_id=? ORDER BY input_key').all(j.id).map(i=>({inputKey:i.input_key,sha256:i.source_hash,bytes:i.bytes,modes:i.was_inline?['inline','saved_snapshot','source']:['saved_snapshot','source']})),
  reports:db.prepare("SELECT s.id,s.item_id,s.period,s.stage_key,s.status,s.attempt FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id WHERE i.job_id=? AND s.stage_key LIKE 'report:%' ORDER BY s.id").all(j.id).map(s=>{
   const a=db.prepare('SELECT * FROM local_batch_artifacts WHERE item_id=? AND period=? AND stage_key=?').get(s.item_id,s.period,s.stage_key);
   return {stageId:s.id,stageKey:s.stage_key,status:s.status,attempt:s.attempt,artifact:a?{relativePath:a.relative_path,bytes:a.bytes,sha256:a.bytes_hash,kind:a.kind,format:a.format}:null};
  })}));
}
/** Known artifact only: no directory scan or old path fallback. */
export function restoredArtifactPresent(root,artifact) {
 try {
  plainRestorePath(root,{directory:true});
  const file=resolve(root,artifact.relative_path);
  if(!inside(file,root)||file===root)return false;
  const a=plainRestorePath(file),b=fs.readFileSync(file),z=plainRestorePath(file);
  return a.dev===z.dev&&a.ino===z.ino&&b.length===artifact.bytes&&hash(b)===artifact.bytes_hash;
 }catch{return false;}
}
