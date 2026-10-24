// Native-only closure. This module must not import application code or the DB.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const REVIEW_Q2_CODE_FILES = Object.freeze([
  "../scripts/accountant-review-q2.mjs",
  "accountant-review-export.mjs",
  "accountant-review-q2-bundle.mjs",
  "accountant-review-q2-code.mjs",
  "accountant-review-q2-worker.mjs",
  "accountant-review-q2.mjs",
  "accountant-review.mjs",
  "accounting-profiles.mjs",
  "auxiliary-storage.mjs",
  "bank-import.mjs",
  "bank-storage.mjs",
  "customer-data-request.mjs",
  "database-open-guard.mjs",
  "enterprise-identity.mjs",
  "import-storage.mjs",
  "local-audit-storage.mjs",
  "local-audit.mjs",
  "local-backup.mjs",
  "local-batch-storage.mjs",
  "local-restore-audit.mjs",
  "local-restore-control.mjs",
  "local-write-lock.mjs",
  "material-completeness.mjs",
  "money.mjs",
  "offline-accounting-readiness.mjs",
  "offline-bookkeeping.mjs",
  "offline-contracts.mjs",
  "offline-invoice-xlsx.mjs",
  "offline-ledger-snapshot.mjs",
  "offline-material-adapters.mjs",
  "offline-material-store.mjs",
  "offline-materials.mjs",
  "offline-task-planner.mjs",
  "offline-vat-input.mjs",
  "offline-voucher-rules.mjs",
  "tax-calculation.mjs",
  "tax-rule-registry.mjs"
]);
const inventory = () => REVIEW_Q2_CODE_FILES.map(name => ({ name, sha256: sha(readFileSync(new URL(name, import.meta.url))) }));
let loaded = [], serialized = '', digest = '', retired = false;
// Missing/unreadable initial bytes are also a permanent native-code failure.
// Keep module evaluation native and nonthrowing so the worker can report a safe
// restart diagnostic before it ever imports any financial application module.
try { loaded = inventory(); serialized = JSON.stringify(loaded); digest = sha(serialized); }
catch { retired = true; }
export function markAccountantReviewQ2CodeRestartRequired() { retired = true; }
export function assertAccountantReviewQ2CodeCurrent(expected) {
  try { if (JSON.stringify(inventory()) !== serialized || expected !== undefined && JSON.stringify(expected) !== JSON.stringify({ digest, files: loaded })) retired = true; }
  catch { retired = true; }
  if (retired) throw Object.assign(new Error('q2_code_restart_required'), { code: 'q2_code_restart_required' });
  return { digest, files: structuredClone(loaded) };
}
