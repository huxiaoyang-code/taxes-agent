// 无状态外观层：全部财务执行在全新的原生引导进程中进行。
import { open, lstat, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertAccountantReviewQ2CodeCurrent, markAccountantReviewQ2CodeRestartRequired } from './accountant-review-q2-code.mjs';
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
const hash = v => createHash('sha256').update(v).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const flags = { calculationReady: false, reviewReady: false, q2CalculationReady: false, accountantApproval: 'pending', periodComplete: false, submittable: false, authorizesExecution: false, sourceAuthenticity: 'unverified', onlineCompatibility: 'unverified' };
function plain(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw fail('q2_request_invalid');
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(descriptors[k], 'value') || !descriptors[k].enumerable)) throw fail('q2_request_invalid');
  return Object.fromEntries(keys.map(k => [k, descriptors[k].value]));
}
function checkRequest(value) {
  const r = plain(value, ['version', 'priorInputPath', 'targetInputPath', 'target']);
  if (r.version !== 'offline-vat-q2-request/1') throw fail('q2_request_invalid');
  const t = plain(r.target, ['dbPath', 'databaseInstanceId', 'enterpriseKey', 'accountSetId']);
  const text = s => typeof s === 'string' && s.length > 0 && s.length <= 32768 && !s.includes('\0');
  if (![r.priorInputPath, r.targetInputPath, t.dbPath].every(s => text(s) && isAbsolute(s)) || !text(t.databaseInstanceId) || !text(t.enterpriseKey) || !Number.isSafeInteger(t.accountSetId) || t.accountSetId <= 0) throw fail('q2_request_invalid');
  return { ...r, target: t };
}
const diagnostic = (status, code, extra = {}) => {
  const result = { version: 'offline-accountant-review-q2-diagnostic/1', status, code, ...flags, ...extra, exportTrust: 'diagnostic_only_not_restorable', limitations: ['selected_services_fields_only', 'accountant_review_and_new_82_confirmation_chain_pending', 'source_authenticity_and_online_compatibility_unverified', 'not_full_return_or_period_completion', 'unobserved_ABA_changes_not_detected', 'year_to_date_mapping_is_engineering_inference_pending_accountant_review'] };
  result.contentDigest = hash(stable(result)); return result;
};
const sameIdentity = (a,b) => a && b && a.dev===b.dev && a.ino===b.ino && a.birthtimeMs===b.birthtimeMs;
const validOutputStat = (s,expected,before=s) => s.isFile() && s.nlink===1 && s.size===expected.bytes && sameIdentity(s,expected.identity) && s.mtimeMs===before.mtimeMs && s.ctimeMs===before.ctimeMs;
async function verifyOutputFile(directory, expected) {
  try {
    if(!expected || !['bundle.json','workpaper.xlsx','manifest.json'].includes(expected.name) || !Number.isSafeInteger(expected.bytes) || expected.bytes<0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw fail('review_q2_publication_failed');
    const path=join(directory,expected.name),before=await lstat(path);
    if(!validOutputStat(before,expected)) throw fail('review_q2_publication_failed');
    const h=await open(path,'r');
    try {
      const held=await h.stat();if(!validOutputStat(held,expected,before))throw fail('review_q2_publication_failed');
      const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0;
      for(;;){const r=await h.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;count+=r.bytesRead;if(count>expected.bytes)throw fail('review_q2_publication_failed');digest.update(buffer.subarray(0,r.bytesRead));}
      const after=await h.stat(),named=await lstat(path);
      if(count!==expected.bytes || digest.digest('hex')!==expected.sha256 || !validOutputStat(after,expected,before) || !validOutputStat(named,expected,before))throw fail('review_q2_publication_failed');
    } finally { await h.close(); }
  } catch { throw fail('review_q2_publication_failed'); }
}
function ownMarkerExpected(result, publicationId) {
  const records=result?.outputFiles,manifest=result?.manifest;
  if(!Array.isArray(records)||records.length!==3||records.map(f=>f?.name).join(',')!=='bundle.json,workpaper.xlsx,manifest.json'||manifest?.publicationId!==publicationId)throw fail('review_q2_publication_failed');
  const marker=records[2],bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  if(marker.bytes!==bytes.length||marker.sha256!==hash(bytes)||result.manifestSha256!==marker.sha256)throw fail('review_q2_publication_failed');
  return marker;
}
async function removeOwnMarker(directory,result,publicationId) {
  try { const marker=ownMarkerExpected(result,publicationId);await verifyOutputFile(directory,marker);await unlink(join(directory,marker.name)); }
  catch { /* 只可移除与本次发布字节和身份精确一致的对象。 */ }
}
const publishedResults = new WeakMap();
async function execute(request, binding, outputDirectory, publicationId) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH', 'WORKBENCH_DATA_DIR'].includes(key.toUpperCase())) delete env[key];
  let child, timer, reply, endedResolve, closeInfo, exitInfo;
  // Windows 上的 Node 在父进程主动断开 IPC 后可能不触发 close。
  // 此处忽略全部 stdio，因此在这种情况下由实际 exit 事件完成清理；
  // 没有 exit 事件的 spawn 错误则由实际 close 事件收尾。
  const ended = new Promise(ok => { endedResolve = ok; });
  const result = new Promise((ok, no) => {
    child = spawn(process.execPath, [fileURLToPath(new URL('./accountant-review-q2-worker.mjs', import.meta.url)), Buffer.from(JSON.stringify(binding)).toString('base64url'), Buffer.from(JSON.stringify(request)).toString('base64url'), outputDirectory, publicationId], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', m => {
      if (reply || m?.version !== 'offline-accountant-review-q2-ipc/1' || !['result', 'failure'].includes(m.type)) { no(fail('q2_worker_unavailable')); return; }
      reply = m;
    });
    child.on('error', () => no(fail('q2_worker_unavailable')));
    child.on('disconnect', () => { if (!reply) no(fail('q2_worker_unavailable')); });
    child.on('exit', (code, signal) => { exitInfo = { code, signal }; endedResolve(); if (code !== 0 || signal !== null || !reply) no(fail('q2_worker_unavailable')); });
    child.on('close', (code, signal) => { closeInfo = { code, signal }; endedResolve(); if (code === 0 && signal === null && reply) ok(reply); else no(fail('q2_worker_unavailable')); });
    timer = setTimeout(() => no(fail('q2_worker_timeout')), 30000);
  });
  try { return await result; }
  catch(e) { if(reply?.type==='result') e.publication=reply.result; throw e; }
  finally {
    clearTimeout(timer);
    if (!closeInfo && !exitInfo && child) {
      try { child.kill('SIGKILL'); } catch { /* 由实际 exit/close 事件决定完成。 */ }
      await ended;
    }
  }
}
export async function runAccountantReviewQ2(request, outputDirectory) {
  let published; const publicationId = randomUUID();
  try {
    if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory) || outputDirectory.includes('\0')) throw fail('review_q2_output_invalid');
    const value = checkRequest(request), binding = assertAccountantReviewQ2CodeCurrent();
    const reply = await execute(value, binding, outputDirectory, publicationId);
    if (reply.type === 'result') published = reply.result;
    const current = assertAccountantReviewQ2CodeCurrent(binding);
    if (reply.type === 'failure') {
      if (reply.code === 'q2_code_restart_required') { markAccountantReviewQ2CodeRestartRequired(); throw fail(reply.code); }
      throw fail(reply.code);
    }
    if (stable(reply.result?.codeBinding) !== stable(current)) { markAccountantReviewQ2CodeRestartRequired(); throw fail('q2_code_restart_required'); }
    ownMarkerExpected(reply.result,publicationId);
    for(const file of reply.result.outputFiles) await verifyOutputFile(outputDirectory,file);
    assertAccountantReviewQ2CodeCurrent(binding);
    const ready = reply.result.calculationReady === true;
    const completed=diagnostic('complete_draft', null, { ...reply.result, calculationReady: ready, reviewReady: ready, q2CalculationReady: ready });
    publishedResults.set(completed,{directory:outputDirectory,publicationId,proof:structuredClone({manifest:reply.result.manifest,manifestSha256:reply.result.manifestSha256,outputFiles:reply.result.outputFiles})});
    return completed;
  } catch (e) {
    // 父进程最终代码检查失败时，只使本 worker 的精确标记失效。
    if(typeof outputDirectory==='string') await removeOwnMarker(outputDirectory,published??e.publication,publicationId);
    const code = ['q2_request_invalid', 'review_q2_output_invalid', 'review_q2_publication_failed', 'review_q2_output_conflict', 'review_q2_context_stale', 'review_q2_input_or_publication_rejected', 'pair_scope_mismatch', 'pair_instance_mismatch', 'pair_profile_mismatch', 'pair_quarter_mismatch', 'pair_account_set_invalid', 'pair_previous_computation_forbidden', 'ledger_target_file_mismatch', 'q2_code_restart_required', 'q2_worker_timeout', 'q2_worker_unavailable'].includes(e?.code) ? e.code : 'q2_input_rejected';
    return diagnostic(code === 'q2_code_restart_required' ? 'restart_required' : 'blocked', code);
  }
}
// 只有实际成功返回所持有的身份，才能使其自身发布失效。
// 诊断 JSON 及可变公开字段不能恢复或重定向此能力。
export async function invalidateAccountantReviewQ2Output(result) {
  const state=publishedResults.get(result);
  if(!state) throw fail('review_q2_publication_untrusted');
  await removeOwnMarker(state.directory,state.proof,state.publicationId);
}
