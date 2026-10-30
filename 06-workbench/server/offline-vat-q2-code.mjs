// 只含原生依赖的闭包；本模块不得导入应用代码或数据库。
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
// 初始字节缺失或不可读，同样属于持久的原生代码故障。
// 保持模块求值仅使用原生依赖且不抛出异常，便于 worker 在导入任何
// 财务应用模块前返回安全的重启诊断。
try { loaded = inventory(); serialized = JSON.stringify(loaded); digest = sha(serialized); }
catch { retired = true; }
export function markOfflineVatQ2CodeRestartRequired() { retired = true; }
export function assertOfflineVatQ2CodeCurrent(expected) {
  try { if (JSON.stringify(inventory()) !== serialized || expected !== undefined && JSON.stringify(expected) !== JSON.stringify({ digest, files: loaded })) retired = true; }
  catch { retired = true; }
  if (retired) throw Object.assign(new Error('q2_code_restart_required'), { code: 'q2_code_restart_required' });
  return { digest, files: structuredClone(loaded) };
}
