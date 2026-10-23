// Module-load byte closure. A changed cached module requires a fresh process.
import { readFileSync } from 'node:fs';
import { REVIEW_CODE_FILES } from './accountant-review-store.mjs';
import { hash, stable } from './offline-material-adapters.mjs';

const files = [...REVIEW_CODE_FILES, 'offline-vat-history-context.mjs', 'offline-vat-history-code.mjs', 'offline-vat-history-worker.mjs'];
const inventory = () => files.map(name => ({ name, sha256: hash(readFileSync(new URL(name, import.meta.url))) }));
const loaded = inventory(), loadedDigest = hash(stable(loaded));
let restartRequired = false;
// Fail-closed only: observing a foreign worker manifest cannot grant or reset authority.
export function markOfflineVatHistoryCodeRestartRequired() { restartRequired = true; }
export function assertOfflineVatHistoryCodeCurrent() {
  try { if (hash(stable(inventory())) !== loadedDigest) restartRequired = true; }
  catch { restartRequired = true; }
  if (restartRequired) throw Object.assign(new Error('prior_code_restart_required'), { code: 'prior_code_restart_required' });
  return { digest: loadedDigest, files: structuredClone(loaded) };
}
