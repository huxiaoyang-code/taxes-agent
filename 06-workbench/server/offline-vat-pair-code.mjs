// 只含原生依赖的字节闭包，在 worker 加载应用代码前捕获。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const PAIR_CODE_FILES = Object.freeze([
  'accountant-review-store.mjs', 'accountant-review-feedback.mjs', 'accountant-review.mjs', 'accountant-review-export.mjs',
  'offline-vat-input.mjs', 'offline-ledger-snapshot.mjs', 'offline-accounting-readiness.mjs',
  'offline-materials.mjs', 'offline-material-adapters.mjs', 'offline-material-store.mjs', 'offline-invoice-xlsx.mjs',
  'offline-contracts.mjs', 'offline-bookkeeping.mjs', 'offline-voucher-rules.mjs', 'offline-task-planner.mjs',
  'material-completeness.mjs', 'customer-data-request.mjs', 'tax-calculation.mjs', 'tax-rule-registry.mjs',
  'enterprise-identity.mjs', 'import-storage.mjs', 'bank-import.mjs', 'money.mjs', 'accounting-profiles.mjs',
  'local-audit-storage.mjs', 'local-audit.mjs', 'local-batch-storage.mjs', 'database-open-guard.mjs',
  'offline-vat-pair-context.mjs', 'offline-vat-pair-code.mjs', 'offline-vat-pair-worker.mjs', '../scripts/offline-vat-pair.mjs',
]);
const inventory = () => PAIR_CODE_FILES.map(name => ({ name, sha256: sha(readFileSync(new URL(name, import.meta.url))) }));
const loaded = inventory(), serialized = JSON.stringify(loaded), digest = sha(serialized);
let retired = false;
export function markOfflineVatPairCodeRestartRequired() { retired = true; }
export function assertOfflineVatPairCodeCurrent(expected) {
  try { if (JSON.stringify(inventory()) !== serialized || expected !== undefined && JSON.stringify(expected) !== JSON.stringify({ digest, files: loaded })) retired = true; }
  catch { retired = true; }
  if (retired) throw Object.assign(new Error('pair_code_restart_required'), { code: 'pair_code_restart_required' });
  return { digest, files: structuredClone(loaded) };
}
