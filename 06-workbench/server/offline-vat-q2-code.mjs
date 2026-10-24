// Native-only closure. This module must not import application code or the DB.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const Q2_CODE_FILES = Object.freeze([
  'accountant-review-store.mjs', 'accountant-review-feedback.mjs', 'accountant-review.mjs', 'accountant-review-export.mjs',
  'offline-vat-input.mjs', 'offline-ledger-snapshot.mjs', 'offline-accounting-readiness.mjs',
  'offline-materials.mjs', 'offline-material-adapters.mjs', 'offline-material-store.mjs', 'offline-invoice-xlsx.mjs',
  'offline-contracts.mjs', 'offline-bookkeeping.mjs', 'offline-voucher-rules.mjs', 'offline-task-planner.mjs',
  'material-completeness.mjs', 'customer-data-request.mjs', 'tax-calculation.mjs', 'tax-rule-registry.mjs',
  'enterprise-identity.mjs', 'import-storage.mjs', 'bank-import.mjs', 'money.mjs', 'accounting-profiles.mjs',
  'local-audit-storage.mjs', 'local-audit.mjs', 'local-batch-storage.mjs', 'database-open-guard.mjs',
  'offline-vat-q2.mjs', 'offline-vat-q2-code.mjs', 'offline-vat-q2-worker.mjs', '../scripts/offline-vat-q2.mjs',
]);
const inventory = () => Q2_CODE_FILES.map(name => ({ name, sha256: sha(readFileSync(new URL(name, import.meta.url))) }));
let loaded = [], serialized = '', digest = '', retired = false;
// Missing/unreadable initial bytes are also a permanent native-code failure.
// Keep module evaluation native and nonthrowing so the worker can report a safe
// restart diagnostic before it ever imports any financial application module.
try { loaded = inventory(); serialized = JSON.stringify(loaded); digest = sha(serialized); }
catch { retired = true; }
export function markOfflineVatQ2CodeRestartRequired() { retired = true; }
export function assertOfflineVatQ2CodeCurrent(expected) {
  try { if (JSON.stringify(inventory()) !== serialized || expected !== undefined && JSON.stringify(expected) !== JSON.stringify({ digest, files: loaded })) retired = true; }
  catch { retired = true; }
  if (retired) throw Object.assign(new Error('q2_code_restart_required'), { code: 'q2_code_restart_required' });
  return { digest, files: structuredClone(loaded) };
}
