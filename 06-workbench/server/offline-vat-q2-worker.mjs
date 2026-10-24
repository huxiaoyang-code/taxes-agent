// Validate the expected/initial/current byte closure before any financial import.
import { assertOfflineVatQ2CodeCurrent } from './offline-vat-q2-code.mjs';
let session;
const send = message => new Promise((ok, no) => {
  if (!process.send || !process.connected) return no(new Error('disconnected'));
  process.send({ version: 'offline-vat-q2-ipc/1', ...message }, e => e ? no(e) : ok());
});
const close = () => { try { session?.close(); } finally { session = undefined; } };
const shutdown = () => { try { close(); } finally { process.exit(1); } };
process.on('disconnect', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
let reply;
try {
  const expected = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
  assertOfflineVatQ2CodeCurrent(expected);
  const [loader, calculator, adapters] = await Promise.all([import('./offline-vat-input.mjs'), import('./tax-calculation.mjs'), import('./offline-material-adapters.mjs')]);
  assertOfflineVatQ2CodeCurrent(expected);
  const request = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
  session = await loader.openVatInputPairFiles(request);
  const before = await loader.assertVatInputPairCurrent(session);
  const result = await calculator.calculateOfflineVatQ2(session);
  const after = await loader.assertVatInputPairCurrent(session);
  adapters.requireValue(adapters.stable(before) === adapters.stable(after), 'q2_context_stale');
  const binding = { relationship: result.proof.relationship, proofDigest: result.proof.proofDigest, databaseInstanceId: session.snapshots.prior.instance.instanceId, enterpriseKey: session.snapshots.prior.scope.enterpriseKey, accountSetId: session.snapshots.prior.scope.accountSetId,
    prior: { scope: session.prior.rawInput.scope, ledgerDigest: before.proof.priorDigest, inputDigest: adapters.hash(adapters.stable(session.prior.rawInput)) },
    target: { scope: session.target.rawInput.scope, ledgerDigest: before.proof.targetDigest, inputDigest: adapters.hash(adapters.stable(session.target.rawInput)) } };
  binding.bindingDigest = adapters.hash(adapters.stable(binding));
  const codeBinding = assertOfflineVatQ2CodeCurrent(expected);
  reply = { type: 'result', result: { ...result, binding, codeBinding } };
} catch (e) {
  const permitted = ['pair_scope_mismatch', 'pair_instance_mismatch', 'pair_profile_mismatch', 'pair_quarter_mismatch', 'pair_account_set_invalid', 'pair_previous_computation_forbidden', 'ledger_target_file_mismatch', 'q2_code_restart_required', 'q2_context_stale'];
  reply = { type: 'failure', code: permitted.includes(e?.code) ? e.code : /^tax_/.test(e?.code) ? 'q2_tax_facts_invalid' : /^ledger_/.test(e?.code) ? 'q2_ledger_invalid' : 'q2_input_rejected' };
} finally { close(); }
if (process.connected) {
  try { await send(reply); } catch { process.exit(1); }
}
process.removeListener('disconnect', shutdown);
if (process.connected) process.disconnect();
process.exit(0);
