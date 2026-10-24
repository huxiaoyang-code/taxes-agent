// Opaque pair facade. Only the fixed fresh worker holds raw inputs, snapshots and the DB.
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { spawn } from 'node:child_process';
import { assertOfflineVatPairCodeCurrent, markOfflineVatPairCodeRestartRequired } from './offline-vat-pair-code.mjs';
import { fields, requirePlainJson, requireValue, stable, hash, validateScope } from './offline-material-adapters.mjs';

const receipts = new WeakMap(), IPC_TIMEOUT_MS = 30_000;
const limitations = ['Q1_recomputation_and_Q2_inputs_only', 'no_Q2_tax_calculation_or_YTD', 'no_reusable_accountant_confirmation', 'local_attestation_not_source_authentication', 'unobserved_ABA_changes_not_detected', 'same_file_clone_authenticity_not_proven'];
const flags = { targetBinding: 'not_verified', q2CalculationReady: false, accountantApproval: 'pending', periodComplete: false, submittable: false, authorizesExecution: false, sourceAuthenticity: 'unverified' };
const safeCodes = new Set(['pair_request_invalid', 'pair_input_rejected', 'pair_context_stale', 'pair_receipt_untrusted', 'pair_receipt_closed', 'pair_code_restart_required', 'pair_calculation_blocked', 'pair_calculation_unsupported', 'pair_january_establishment_required', 'pair_scope_mismatch', 'pair_instance_mismatch', 'pair_profile_mismatch', 'pair_quarter_mismatch', 'pair_account_set_invalid', 'pair_target_mismatch', 'pair_material_store_not_current', 'pair_tax_facts_invalid', 'pair_ledger_invalid', 'pair_worker_unavailable', 'pair_worker_timeout']);
const diagnostic = (status, code, extra = {}) => ({ version: 'offline-vat-pair-diagnostic/1', status, code, ...flags, limitations: [...limitations], ...extra });
const failure = code => Object.assign(new Error(code), { code });
function safeError(e, fallback) { return safeCodes.has(e?.code) ? e.code : fallback; }

function checkRequest(request) {
  const record = (value, names) => {
    requireValue(value !== null && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
    const keys = Reflect.ownKeys(value), d = Object.getOwnPropertyDescriptors(value);
    requireValue(keys.length === names.length && keys.every(k => typeof k === 'string' && names.includes(k) && Object.hasOwn(d[k], 'value') && d[k].enumerable));
    return Object.fromEntries(names.map(k => [k, d[k].value]));
  };
  const path = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0') && isAbsolute(value);
  try {
    const r = record(request, ['version', 'priorInputPath', 'targetInputPath', 'target']);
    const t = record(r.target, ['dbPath', 'databaseInstanceId', 'enterpriseKey', 'accountSetId']);
    requireValue(r.version === 'offline-vat-pair-request/1' && path(r.priorInputPath) && path(r.targetInputPath) && path(t.dbPath));
    requireValue(typeof t.databaseInstanceId === 'string' && /^[a-f0-9-]{36}$/.test(t.databaseInstanceId) && typeof t.enterpriseKey === 'string' && Number.isSafeInteger(t.accountSetId) && t.accountSetId > 0);
    validateScope({ enterpriseKey: t.enterpriseKey, accountSetId: String(t.accountSetId), period: '2026-Q1', currency: 'CNY', unit: 'yuan' });
    requirePlainJson(request);
  } catch { throw failure('pair_request_invalid'); }
}

const retiredDiagnostic = state => diagnostic(state.retired === 'pair_receipt_closed' ? 'closed' : 'stale', state.retired);
function deferred() {
  let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
function startWorker(binding) {
  // Never inherit Node preloads or a user's default accounting data directory.
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.WORKBENCH_DATA_DIR;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./offline-vat-pair-worker.mjs', import.meta.url)), Buffer.from(JSON.stringify(binding)).toString('base64url')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = deferred(), exited = deferred();
  const state = { child, ready, exited, pending: null, sequence: 0, queue: Promise.resolve(), retired: null, stopping: null, didExit: false };
  child.on('message', message => {
    if (message?.version !== 'offline-vat-pair-ipc/1') { state.pending?.reject(failure('pair_worker_unavailable')); ready.reject(failure('pair_worker_unavailable')); return; }
    if (message.type === 'ready') ready.resolve(message.codeBinding);
    else if (message.type === 'result' && state.pending && message.sequence === state.pending.sequence) state.pending.resolve(message.reply);
    else if (message.type !== 'closed') { state.pending?.reject(failure('pair_worker_unavailable')); ready.reject(failure('pair_worker_unavailable')); }
  });
  child.on('error', () => { state.pending?.reject(failure('pair_worker_unavailable')); ready.reject(failure('pair_worker_unavailable')); });
  const onExit = () => {
    if (state.didExit) return;
    state.didExit = true; state.retired ??= 'pair_worker_unavailable';
    state.pending?.reject(failure('pair_worker_unavailable')); ready.reject(failure('pair_worker_unavailable')); exited.resolve();
  };
  child.on('exit', onExit); child.on('close', onExit);
  child.on('disconnect', () => { if (!state.didExit) { state.retired ??= 'pair_worker_unavailable'; state.pending?.reject(failure('pair_worker_unavailable')); ready.reject(failure('pair_worker_unavailable')); } });
  ready.promise.catch(() => {});
  return state;
}
async function timed(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('pair_worker_timeout')), IPC_TIMEOUT_MS); })]); }
  finally { clearTimeout(timer); }
}
async function command(state, command, request) {
  if (state.didExit || !state.child.connected) throw failure('pair_worker_unavailable');
  const pending = deferred(); pending.sequence = ++state.sequence; state.pending = pending;
  try {
    state.child.send({ version: 'offline-vat-pair-ipc/1', type: 'command', sequence: pending.sequence, command, ...(request === undefined ? {} : { request }) }, error => { if (error) pending.reject(failure('pair_worker_unavailable')); });
    return await timed(pending.promise);
  } finally { if (state.pending === pending) state.pending = null; }
}
async function stopWorker(state) {
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.didExit) return;
    try { if (state.child.connected) state.child.send({ version: 'offline-vat-pair-ipc/1', type: 'command', sequence: 0, command: 'close' }, () => {}); } catch { /* Kill below if IPC cannot close. */ }
    let timer;
    try { await Promise.race([state.exited.promise, new Promise(ok => { timer = setTimeout(ok, 500); })]); } finally { clearTimeout(timer); }
    if (!state.didExit) {
      try { state.child.kill('SIGTERM'); } catch { /* Escalate below. */ }
      try { await Promise.race([state.exited.promise, new Promise(ok => { timer = setTimeout(ok, 500); })]); } finally { clearTimeout(timer); }
    }
    if (!state.didExit) { try { state.child.kill('SIGKILL'); } catch { /* Exit event still owns completion. */ } }
    await state.exited.promise;
  })();
  return state.stopping;
}
async function retire(state, code) { state.retired ??= code; await stopWorker(state); return retiredDiagnostic(state); }
function assertBinding(expected, actual) {
  if (stable(expected) !== stable(actual)) { markOfflineVatPairCodeRestartRequired(); throw failure('pair_code_restart_required'); }
}
function validateReply(reply, binding) {
  requirePlainJson(reply); fields(reply, ['status', 'code'], ['result']);
  requireValue(['pair_bound_prior_q1_recomputed', 'blocked', 'unsupported', 'restart_required', 'stale'].includes(reply.status));
  requireValue(reply.code === null || safeCodes.has(reply.code));
  if (reply.code === 'pair_code_restart_required') markOfflineVatPairCodeRestartRequired();
  if (reply.result) {
    fields(reply.result, ['priorComputation', 'targetDiagnostics', 'binding', 'inputFiles', 'codeBinding']); assertBinding(binding, reply.result.codeBinding);
  }
  requireValue(reply.status !== 'pair_bound_prior_q1_recomputed' || reply.code === null && reply.result?.priorComputation.calculationReady === true);
  return diagnostic(reply.status, reply.code, { ...(reply.result ?? {}), ...(reply.status === 'pair_bound_prior_q1_recomputed' ? { targetBinding: 'same_held_readonly_source' } : {}) });
}

/** API paths must be absolute. No caller-supplied DB/snapshot/receipt JSON is consumed. */
export async function openOfflineVatPairContext(request) {
  let state;
  try {
    checkRequest(request);
    const binding = assertOfflineVatPairCodeCurrent();
    state = startWorker(binding); assertBinding(binding, await timed(state.ready.promise));
    assertBinding(binding, assertOfflineVatPairCodeCurrent());
    const result = validateReply(await command(state, 'open', structuredClone(request)), binding);
    assertBinding(binding, assertOfflineVatPairCodeCurrent());
    if (state.retired) throw failure(state.retired);
    if (result.status !== 'pair_bound_prior_q1_recomputed') { await retire(state, result.code ?? 'pair_input_rejected'); return { receipt: null, diagnostic: result }; }
    const receipt = Object.freeze(Object.create(null));
    state.binding = binding; state.digest = hash(stable(result)); receipts.set(receipt, state);
    return { receipt, diagnostic: structuredClone(result) };
  } catch (e) {
    const code = safeError(e, 'pair_input_rejected'); if (state) await retire(state, code);
    return { receipt: null, diagnostic: diagnostic(code === 'pair_code_restart_required' ? 'restart_required' : 'blocked', code) };
  }
}

/** Serialized IPC; every call recomputes inside the original fresh worker/session. */
export async function assertOfflineVatPairContextCurrent(receipt) {
  const state = receipts.get(receipt);
  if (!state) return diagnostic('blocked', 'pair_receipt_untrusted');
  const work = async () => {
    if (state.retired) { await stopWorker(state); return retiredDiagnostic(state); }
    try {
      assertBinding(state.binding, assertOfflineVatPairCodeCurrent());
      const result = validateReply(await command(state, 'current'), state.binding);
      assertBinding(state.binding, assertOfflineVatPairCodeCurrent());
      if (state.retired) { await stopWorker(state); return retiredDiagnostic(state); }
      if (result.status !== 'pair_bound_prior_q1_recomputed') return retire(state, result.code ?? 'pair_context_stale');
      if (hash(stable(result)) !== state.digest) return retire(state, 'pair_context_stale');
      return structuredClone(result);
    } catch (e) { return retire(state, safeError(e, 'pair_context_stale')); }
  };
  const next = state.queue.then(work, work); state.queue = next.catch(() => {}); return next;
}

/** Await actual worker exit; close also cancels an in-flight consume. */
export async function closeOfflineVatPairContext(receipt) {
  const state = receipts.get(receipt);
  return state ? retire(state, 'pair_receipt_closed') : diagnostic('blocked', 'pair_receipt_untrusted');
}
