// 仅处理前期的公开外观层；税算及持有的数据库在全新 Node worker 内。
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { spawn } from 'node:child_process';
import { fields, requirePlainJson, requireValue, stable, hash } from './offline-material-adapters.mjs';
import { assertOfflineVatHistoryCodeCurrent, markOfflineVatHistoryCodeRestartRequired } from './offline-vat-history-code.mjs';

const receipts = new WeakMap(), IPC_TIMEOUT_MS = 30_000;
const limitations = ['prior_Q1_only', 'no_target_database_binding', 'no_Q2_tax_calculation', 'no_reusable_accountant_confirmation', 'local_attestation_not_source_authentication', 'unobserved_ABA_changes_not_detected'];
const flags = { targetBinding: 'not_verified', q2CalculationReady: false, accountantApproval: 'pending', periodComplete: false, submittable: false, authorizesExecution: false, sourceAuthenticity: 'unverified' };
const safeCodes = new Set(['prior_request_invalid', 'prior_input_rejected', 'prior_context_stale', 'prior_receipt_untrusted', 'prior_receipt_closed', 'prior_code_restart_required', 'prior_calculation_blocked', 'prior_calculation_unsupported', 'prior_january_establishment_required', 'prior_worker_unavailable', 'prior_worker_timeout']);
const diagnostic = (status, code, extra = {}) => ({ version: 'offline-vat-prior-diagnostic/1', status, code, ...flags, limitations: [...limitations], ...extra });
const failure = code => Object.assign(new Error(code), { code });
function safeError(e, fallback) { return safeCodes.has(e?.code) ? e.code : fallback; }

function checkRequest(request) {
  try {
    requireValue(request !== null && typeof request === 'object' && !types.isProxy(request) && Object.getPrototypeOf(request) === Object.prototype);
    const keys = Reflect.ownKeys(request);
    requireValue(keys.length === 2 && keys.every(k => k === 'version' || k === 'priorInputPath'));
    const descriptors = Object.getOwnPropertyDescriptors(request);
    requireValue(keys.every(k => Object.hasOwn(descriptors[k], 'value') && descriptors[k].enumerable));
    const version = descriptors.version.value, path = descriptors.priorInputPath.value;
    // 在递归校验器触碰 Proxy 之前，先拒绝非法嵌套值。
    requireValue(typeof version === 'string' && version === 'offline-vat-prior-request/1' && typeof path === 'string' && path.length > 0 && path.length <= 32768 && !path.includes('\0'));
    fields(request, ['version', 'priorInputPath']); requirePlainJson(request);
  } catch { throw Object.assign(new Error('prior_request_invalid'), { code: 'prior_request_invalid' }); }
}

const retiredDiagnostic = state => diagnostic(state.retired === 'prior_receipt_closed' ? 'closed' : 'stale', state.retired);
function deferred() {
  let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
function startWorker() {
  // 绝不继承 Node 预加载项或用户默认会计数据目录。
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.WORKBENCH_DATA_DIR;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./offline-vat-history-worker.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = deferred(), exited = deferred();
  const state = { child, ready, exited, pending: null, sequence: 0, queue: Promise.resolve(), retired: null, stopping: null, didExit: false };
  child.on('message', message => {
    if (message?.version !== 'offline-vat-prior-ipc/1') { state.pending?.reject(failure('prior_worker_unavailable')); ready.reject(failure('prior_worker_unavailable')); return; }
    if (message.type === 'ready') ready.resolve(message.codeBinding);
    else if (message.type === 'result' && state.pending && message.sequence === state.pending.sequence) state.pending.resolve(message.reply);
    else if (message.type !== 'closed') { state.pending?.reject(failure('prior_worker_unavailable')); ready.reject(failure('prior_worker_unavailable')); }
  });
  child.on('error', () => { state.pending?.reject(failure('prior_worker_unavailable')); ready.reject(failure('prior_worker_unavailable')); });
  const onExit = () => {
    if (state.didExit) return;
    state.didExit = true; state.retired ??= 'prior_worker_unavailable';
    state.pending?.reject(failure('prior_worker_unavailable')); ready.reject(failure('prior_worker_unavailable')); exited.resolve();
  };
  child.on('exit', onExit); child.on('close', onExit);
  ready.promise.catch(() => {});
  return state;
}
async function timed(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('prior_worker_timeout')), IPC_TIMEOUT_MS); })]); }
  finally { clearTimeout(timer); }
}
async function command(state, command, priorInputPath) {
  if (state.didExit || !state.child.connected) throw failure('prior_worker_unavailable');
  const pending = deferred(); pending.sequence = ++state.sequence; state.pending = pending;
  try {
    state.child.send({ version: 'offline-vat-prior-ipc/1', type: 'command', sequence: pending.sequence, command, ...(priorInputPath === undefined ? {} : { priorInputPath }) }, error => { if (error) pending.reject(failure('prior_worker_unavailable')); });
    return await timed(pending.promise);
  } finally { if (state.pending === pending) state.pending = null; }
}
async function stopWorker(state) {
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.didExit) return;
    try { if (state.child.connected) state.child.send({ version: 'offline-vat-prior-ipc/1', type: 'command', sequence: 0, command: 'close' }, () => {}); } catch { /* IPC 无法关闭时，在下方终止进程。 */ }
    let timer;
    try { await Promise.race([state.exited.promise, new Promise(ok => { timer = setTimeout(ok, 500); })]); } finally { clearTimeout(timer); }
    if (!state.didExit) {
      try { state.child.kill('SIGTERM'); } catch { /* 在下方升级为强制处理。 */ }
      try { await Promise.race([state.exited.promise, new Promise(ok => { timer = setTimeout(ok, 500); })]); } finally { clearTimeout(timer); }
    }
    if (!state.didExit) { try { state.child.kill('SIGKILL'); } catch { /* 完成仍由实际 exit 事件决定。 */ } }
    await state.exited.promise;
  })();
  return state.stopping;
}
async function retire(state, code) { state.retired ??= code; await stopWorker(state); return retiredDiagnostic(state); }
function assertBinding(expected, actual) {
  if (stable(expected) !== stable(actual)) { markOfflineVatHistoryCodeRestartRequired(); throw failure('prior_code_restart_required'); }
}
function validateReply(reply, binding) {
  requirePlainJson(reply); fields(reply, ['status', 'code'], ['result']);
  requireValue(['prior_q1_recomputed', 'blocked', 'unsupported', 'restart_required', 'stale'].includes(reply.status));
  requireValue(reply.code === null || safeCodes.has(reply.code));
  if (reply.code === 'prior_code_restart_required') markOfflineVatHistoryCodeRestartRequired();
  if (reply.result) {
    fields(reply.result, ['computation', 'inputFiles', 'codeBinding']); assertBinding(binding, reply.result.codeBinding);
  }
  requireValue(reply.status !== 'prior_q1_recomputed' || reply.code === null && reply.result?.computation.calculationReady === true);
  return diagnostic(reply.status, reply.code, reply.result ?? {});
}

/** API 中的相对 priorInputPath 以 process.cwd() 为基准解析。 */
export async function openOfflineVatPriorContext(request) {
  let state;
  try {
    checkRequest(request);
    const path = resolve(request.priorInputPath), binding = assertOfflineVatHistoryCodeCurrent();
    state = startWorker(); assertBinding(binding, await timed(state.ready.promise));
    assertBinding(binding, assertOfflineVatHistoryCodeCurrent());
    const result = validateReply(await command(state, 'open', path), binding);
    assertBinding(binding, assertOfflineVatHistoryCodeCurrent());
    if (state.retired) throw failure(state.retired);
    if (result.status !== 'prior_q1_recomputed') { await retire(state, result.code ?? 'prior_input_rejected'); return { receipt: null, diagnostic: result }; }
    const receipt = Object.freeze(Object.create(null));
    state.binding = binding; state.digest = hash(stable(result)); receipts.set(receipt, state);
    return { receipt, diagnostic: structuredClone(result) };
  } catch (e) {
    const code = safeError(e, 'prior_input_rejected'); if (state) await retire(state, code);
    return { receipt: null, diagnostic: diagnostic(code === 'prior_code_restart_required' ? 'restart_required' : 'blocked', code) };
  }
}

/** 串行化 IPC；每次调用都在原始全新 worker/会话内重新计算。 */
export async function assertOfflineVatPriorContextCurrent(receipt) {
  const state = receipts.get(receipt);
  if (!state) return diagnostic('blocked', 'prior_receipt_untrusted');
  const work = async () => {
    if (state.retired) { await stopWorker(state); return retiredDiagnostic(state); }
    try {
      assertBinding(state.binding, assertOfflineVatHistoryCodeCurrent());
      const result = validateReply(await command(state, 'current'), state.binding);
      assertBinding(state.binding, assertOfflineVatHistoryCodeCurrent());
      if (state.retired) { await stopWorker(state); return retiredDiagnostic(state); }
      if (result.status !== 'prior_q1_recomputed') return retire(state, result.code ?? 'prior_context_stale');
      if (hash(stable(result)) !== state.digest) return retire(state, 'prior_context_stale');
      return structuredClone(result);
    } catch (e) { return retire(state, safeError(e, 'prior_context_stale')); }
  };
  const next = state.queue.then(work, work); state.queue = next.catch(() => {}); return next;
}

/** 等待 worker 实际退出；close 也会取消正在进行的 consume。 */
export async function closeOfflineVatPriorContext(receipt) {
  const state = receipts.get(receipt);
  return state ? retire(state, 'prior_receipt_closed') : diagnostic('blocked', 'prior_receipt_untrusted');
}
