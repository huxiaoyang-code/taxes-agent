// 只含原生依赖的外观层，不导入默认数据库或缓存应用模块。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
export const PERIOD_PLAN_VERSION = 'offline-period-plan/1';
export const sha = x => createHash('sha256').update(x).digest('hex');
const fail = () => { throw Object.assign(new Error('period_plan_request_invalid'), { code: 'period_plan_request_invalid' }); };
function fields(o, keys) {
  if (!o || typeof o !== 'object' || types.isProxy(o) || Object.getPrototypeOf(o) !== Object.prototype) fail();
  const d = Object.getOwnPropertyDescriptors(o), actual = Reflect.ownKeys(d);
  if (actual.length !== keys.length || !keys.every(k => Object.hasOwn(d, k)) || actual.some(k => typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(d[k], 'value') || !d[k].enumerable)) fail();
}
export function validatePeriodPlanRequest(r) {
  fields(r, ['version','inputPath','target','month']);
  if (r.version !== 'offline-period-plan-input/1' || typeof r.inputPath !== 'string' || !isAbsolute(r.inputPath) || typeof r.month !== 'string' || !/^20\d\d-(0[1-9]|1[0-2])$/.test(r.month)) fail();
  fields(r.target, ['dbPath','databaseInstanceId','enterpriseKey','accountSetId']);
  const t = r.target;
  if (typeof t.dbPath !== 'string' || !isAbsolute(t.dbPath) || typeof t.databaseInstanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(t.databaseInstanceId) || typeof t.enterpriseKey !== 'string' || !t.enterpriseKey || t.enterpriseKey !== t.enterpriseKey.normalize('NFKC').trim() || !Number.isSafeInteger(t.accountSetId) || t.accountSetId <= 0) fail();
  return r;
}
export function capturePeriodPlanCode() {
  const found = new Map(), root = dirname(fileURLToPath(import.meta.url));
  function visit(url) {
    const p = fileURLToPath(url); if (found.has(p)) return;
    const b = readFileSync(p); found.set(p, sha(b));
    for (const m of b.toString('utf8').matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"\n]+\.mjs)['"]/g)) visit(new URL(m[1], url));
  }
  visit(new URL('./offline-period-plan-target.mjs', import.meta.url));
  // 固定子进程 URL 不属于 ES import，须显式纳入其完整应用依赖闭包。
  visit(new URL('./offline-posting-target.mjs', import.meta.url));
  visit(new URL('../scripts/offline-period-plan.mjs', import.meta.url));
  const files = [...found].map(([p, sha256]) => ({ path: relative(root,p).replaceAll('\\','/'), sha256 })).sort((a,b)=>a.path.localeCompare(b.path));
  return { version: 'offline-period-plan-code/1', files, digest: sha(JSON.stringify(files)) };
}
export const unavailable = code => ({ version: PERIOD_PLAN_VERSION, status: 'needs_local_review', code, authorizesExecution: false, periodComplete: false, submittable: false, manifest: null });
export function runOfflinePeriodPlan(request) {
  validatePeriodPlanRequest(request);
  let expectedCode; try { expectedCode = capturePeriodPlanCode(); } catch { return unavailable('period_plan_code_restart_required'); }
  const env = { ...process.env, NODE_NO_WARNINGS: '1' }; delete env.NODE_OPTIONS; delete env.WORKBENCH_DATA_DIR;
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./offline-period-plan-target.mjs', import.meta.url))], { input: JSON.stringify({ version:'offline-period-plan-private/1', expectedCode, request }), env, encoding:'utf8', windowsHide:true, timeout:60000, killSignal:'SIGKILL', maxBuffer:32*1024*1024 });
  try { if (JSON.stringify(capturePeriodPlanCode()) !== JSON.stringify(expectedCode)) return unavailable('period_plan_code_restart_required'); } catch { return unavailable('period_plan_code_restart_required'); }
  if (child.status !== 0 || child.signal || child.error || child.stderr) return unavailable('period_plan_process_unavailable');
  try { const r = JSON.parse(child.stdout); if (r.version !== PERIOD_PLAN_VERSION || r.authorizesExecution !== false || r.periodComplete !== false || r.submittable !== false) throw 0; return r; } catch { return unavailable('period_plan_response_unavailable'); }
}
