// 公开桥接：每次调用运行于全新固定 Node 进程，不导入默认数据库。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const requireValue = (condition, code = 'posting_request_invalid') => { if (!condition) throw Object.assign(new Error(code), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// 共享的原生依赖扫描器；公开调用者不能提供自定义 manifest。
export function capturePostingCode() {
  const found = new Map(), moduleRoot = dirname(fileURLToPath(import.meta.url));
  const visit = url => {
    const path = fileURLToPath(url); if (found.has(path)) return;
    const bytes = readFileSync(path), text = bytes.toString('utf8'); found.set(path, digest(bytes));
    for (const m of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"\n]+\.mjs)['"]/g)) visit(new URL(m[1], url));
  };
  visit(new URL('./offline-posting-target.mjs', import.meta.url));
  const files = [...found].map(([path, sha256]) => ({ path: relative(moduleRoot, path).replaceAll('\\', '/'), sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return { version: 'offline-posting-code/1', files, digest: digest(JSON.stringify(files)) };
}

export const POSTING_VERSION = 'offline-posting/1';
function fields(value, required, optional = []) {
  requireValue(value && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'posting_request_invalid');
  const d = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(d);
  requireValue(required.every(k => Object.hasOwn(d, k)) && keys.every(k => typeof k === 'string' && [...required, ...optional].includes(k) && Object.hasOwn(d[k], 'value') && d[k].enumerable), 'posting_request_invalid');
}
export function validatePostingRequest(r) {
  fields(r, ['version', 'command', 'inputPath', 'target', 'selected'], ['confirmation']);
  requireValue(r.version === 'offline-posting-input/1' && ['prepare', 'query', 'execute'].includes(r.command), 'posting_request_invalid');
  requireValue(typeof r.inputPath === 'string' && r.inputPath.length > 0, 'posting_request_invalid');
  fields(r.target, ['dbPath', 'databaseInstanceId', 'accountSetId', 'enterpriseKey']);
  requireValue(typeof r.target.dbPath === 'string' && r.target.dbPath.length > 0 && typeof r.target.databaseInstanceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(r.target.databaseInstanceId) && Number.isSafeInteger(r.target.accountSetId) && r.target.accountSetId > 0 && typeof r.target.enterpriseKey === 'string' && r.target.enterpriseKey.length > 0 && r.target.enterpriseKey === r.target.enterpriseKey.normalize('NFKC').trim(), 'posting_target_invalid');
  fields(r.selected, ['taskId', 'businessKey']);
  requireValue(typeof r.selected.businessKey === 'string' && /^(invoice|prepayment):[a-f0-9]{64}$/.test(r.selected.businessKey) && r.selected.taskId === `prepare:${r.selected.businessKey}`, 'posting_selection_invalid');
  if (r.command === 'execute') {
    fields(r.confirmation, ['operationId', 'dependencyDigest', 'policyDigest'], ['confirmNewSourceBinding']);
    requireValue(typeof r.confirmation.operationId === 'string' && typeof r.confirmation.dependencyDigest === 'string' && /^[a-f0-9]{64}$/.test(r.confirmation.dependencyDigest) && typeof r.confirmation.policyDigest === 'string' && /^[a-f0-9]{64}$/.test(r.confirmation.policyDigest) && (!('confirmNewSourceBinding' in r.confirmation) || typeof r.confirmation.confirmNewSourceBinding === 'boolean'), 'posting_confirmation_invalid');
  } else requireValue(!('confirmation' in r), 'posting_request_invalid');
  return r;
}
export function runOfflinePosting(request) {
  validatePostingRequest(request);
  const identity = digest(JSON.stringify(['offline-posting/1', request.target.databaseInstanceId, request.target.enterpriseKey, request.target.accountSetId, request.selected.businessKey]));
  const ids = { operationId: identity, batchId: identity, businessKey: request.selected.businessKey, taskId: request.selected.taskId };
  const unknown = code => ({ version: POSTING_VERSION, ...ids, status: 'needs_local_review', code, applied: 'unknown', periodComplete: false, submittable: false });
  let expectedCode;
  try { expectedCode = capturePostingCode(); } catch { return unknown('posting_code_restart_required'); }
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.NODE_OPTIONS; delete env.WORKBENCH_DATA_DIR;
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./offline-posting-target.mjs', import.meta.url))], { input: JSON.stringify({ version: 'offline-posting-private/1', expectedCode, request }), encoding: 'utf8', env, windowsHide: true, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  let current = false;
  try { current = JSON.stringify(capturePostingCode()) === JSON.stringify(expectedCode); } catch {}
  if (!current) return unknown('posting_code_restart_required');
  if (child.status !== 0 || child.signal || child.error || child.stderr) return unknown('posting_process_unavailable');
  try { const result = JSON.parse(child.stdout); requireValue(result.version === POSTING_VERSION && result.periodComplete === false && result.submittable === false); return result; }
  catch { return unknown('posting_response_unavailable'); }
}
