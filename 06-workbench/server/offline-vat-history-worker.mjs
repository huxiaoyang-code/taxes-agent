// 固定私有子进程入口，不导入 db.mjs，也不接受调用者提供的能力对象。
import { fields, requireValue, stable, hash } from './offline-material-adapters.mjs';
import { openVatInputFiles, assertVatInputSessionCurrent } from './offline-vat-input.mjs';
import { calculateOfflineVat } from './tax-calculation.mjs';
import { assertOfflineVatHistoryCodeCurrent } from './offline-vat-history-code.mjs';

let session, digest, closed = false, queue = Promise.resolve();
const send = message => new Promise((ok, no) => {
  if (!process.send || !process.connected) return no(new Error('disconnected'));
  process.send({ version: 'offline-vat-prior-ipc/1', ...message }, error => error ? no(error) : ok());
});
function closeSession() { try { session?.close(); } finally { session = undefined; closed = true; } }
function shutdown() { try { closeSession(); } finally { process.exit(0); } }
process.on('disconnect', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
async function recompute() {
  const codeBinding = assertOfflineVatHistoryCodeCurrent();
  const inputFiles = await assertVatInputSessionCurrent(session, session.rawInput, session.source, session.snapshot);
  const computation = calculateOfflineVat(session.rawInput, session.source, session.snapshot);
  await assertVatInputSessionCurrent(session, session.rawInput, session.source, session.snapshot);
  assertOfflineVatHistoryCodeCurrent();
  return { computation, inputFiles, codeBinding };
}
function permitted(result) {
  const p = result.computation;
  if (p.calculationReady !== true) return { status: p.status === 'unsupported' ? 'unsupported' : 'blocked', code: p.status === 'unsupported' ? 'prior_calculation_unsupported' : 'prior_calculation_blocked', result };
  if (!/^2026-01-(?:0[1-9]|[12]\d|3[01])$/.test(p.taxFactsEvidence.enterprise.establishedOn)) return { status: 'unsupported', code: 'prior_january_establishment_required', result };
  return null;
}
async function handle(message) {
  fields(message, ['version', 'type', 'sequence', 'command'], ['priorInputPath']);
  requireValue(message.version === 'offline-vat-prior-ipc/1' && message.type === 'command' && Number.isSafeInteger(message.sequence) && message.sequence >= 0 && ['open', 'current', 'close'].includes(message.command));
  if (message.command === 'close') { closeSession(); await send({ type: 'closed', sequence: message.sequence }); shutdown(); return; }
  let reply;
  try {
    requireValue(!closed);
    if (message.command === 'open') { requireValue(!session && typeof message.priorInputPath === 'string'); session = await openVatInputFiles(message.priorInputPath); }
    else requireValue(session && digest && !('priorInputPath' in message));
    const result = await recompute(); reply = permitted(result);
    if (!reply && digest && digest !== hash(stable(result))) reply = { status: 'stale', code: 'prior_context_stale' };
    if (!reply) { digest ??= hash(stable(result)); reply = { status: 'prior_q1_recomputed', code: null, result }; }
    else closeSession();
  } catch (e) {
    closeSession();
    const code = e?.code === 'prior_code_restart_required' ? 'prior_code_restart_required' : message.command === 'open' ? 'prior_input_rejected' : 'prior_context_stale';
    reply = { status: code === 'prior_code_restart_required' ? 'restart_required' : message.command === 'open' ? 'blocked' : 'stale', code };
  }
  await send({ type: 'result', sequence: message.sequence, reply });
}
if (process.send && process.connected) {
  process.on('message', message => { queue = queue.then(() => handle(message)).catch(shutdown); });
  send({ type: 'ready', codeBinding: assertOfflineVatHistoryCodeCurrent() }).catch(shutdown);
}
