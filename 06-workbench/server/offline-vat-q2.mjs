// 无状态外观层：全部财务执行在全新的原生引导进程中进行。
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertOfflineVatQ2CodeCurrent, markOfflineVatQ2CodeRestartRequired } from './offline-vat-q2-code.mjs';
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
  const result = { version: 'offline-vat-q2-diagnostic/1', status, code, ...flags, ...extra, exportTrust: 'diagnostic_only_not_restorable', limitations: ['selected_services_fields_only', 'accountant_review_and_new_82_confirmation_chain_pending', 'source_authenticity_and_online_compatibility_unverified', 'not_full_return_or_period_completion', 'unobserved_ABA_changes_not_detected', 'year_to_date_mapping_is_engineering_inference_pending_accountant_review'] };
  result.contentDigest = hash(stable(result)); return result;
};
async function execute(request, binding) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH', 'WORKBENCH_DATA_DIR'].includes(key.toUpperCase())) delete env[key];
  let child, timer, reply, endedResolve, closeInfo, exitInfo;
  // Windows 上的 Node 在父进程主动断开 IPC 后可能不触发 close。
  // 此处忽略全部 stdio，因此在这种情况下由实际 exit 事件完成清理；
  // 没有 exit 事件的 spawn 错误则由实际 close 事件收尾。
  const ended = new Promise(ok => { endedResolve = ok; });
  const result = new Promise((ok, no) => {
    child = spawn(process.execPath, [fileURLToPath(new URL('./offline-vat-q2-worker.mjs', import.meta.url)), Buffer.from(JSON.stringify(binding)).toString('base64url'), Buffer.from(JSON.stringify(request)).toString('base64url')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', m => {
      if (reply || m?.version !== 'offline-vat-q2-ipc/1' || !['result', 'failure'].includes(m.type)) { no(fail('q2_worker_unavailable')); return; }
      reply = m;
    });
    child.on('error', () => no(fail('q2_worker_unavailable')));
    child.on('disconnect', () => { if (!reply) no(fail('q2_worker_unavailable')); });
    child.on('exit', (code, signal) => { exitInfo = { code, signal }; endedResolve(); if (code !== 0 || signal !== null || !reply) no(fail('q2_worker_unavailable')); });
    child.on('close', (code, signal) => { closeInfo = { code, signal }; endedResolve(); if (code === 0 && signal === null && reply) ok(reply); else no(fail('q2_worker_unavailable')); });
    timer = setTimeout(() => no(fail('q2_worker_timeout')), 30000);
  });
  try { return await result; }
  finally {
    clearTimeout(timer);
    if (!closeInfo && !exitInfo && child) {
      try { child.kill('SIGKILL'); } catch { /* 由实际 exit/close 事件决定完成。 */ }
      await ended;
    }
  }
}
export async function runOfflineVatQ2(request) {
  try {
    const value = checkRequest(request), binding = assertOfflineVatQ2CodeCurrent();
    const reply = await execute(value, binding);
    const current = assertOfflineVatQ2CodeCurrent(binding);
    if (reply.type === 'failure') {
      if (reply.code === 'q2_code_restart_required') { markOfflineVatQ2CodeRestartRequired(); throw fail(reply.code); }
      return diagnostic('blocked', reply.code);
    }
    if (stable(reply.result?.codeBinding) !== stable(current)) { markOfflineVatQ2CodeRestartRequired(); throw fail('q2_code_restart_required'); }
    const ready = reply.result.computation.calculationReady === true;
    return diagnostic(ready ? 'q2_selected_fields_calculated' : reply.result.computation.status, null, { ...reply.result, calculationReady: ready, reviewReady: ready, q2CalculationReady: ready, targetBinding: 'same_held_readonly_source' });
  } catch (e) {
    const code = ['q2_request_invalid', 'q2_code_restart_required', 'q2_worker_timeout', 'q2_worker_unavailable'].includes(e?.code) ? e.code : 'q2_input_rejected';
    return diagnostic(code === 'q2_code_restart_required' ? 'restart_required' : 'blocked', code);
  }
}
/** 只作比较，即使猜中相同摘要也不授予权限。 */
export async function checkOfflineVatQ2Current(request, expectedContentDigest) {
  const fresh = await runOfflineVatQ2(request);
  return { status: fresh.status === 'restart_required' ? 'restart_required' : typeof expectedContentDigest === 'string' && /^[a-f0-9]{64}$/.test(expectedContentDigest) && fresh.contentDigest === expectedContentDigest ? 'current' : 'stale', expectedContentDigest: typeof expectedContentDigest === 'string' ? expectedContentDigest : null, diagnostic: fresh, authorizesExecution: false };
}
