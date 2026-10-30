#!/usr/bin/env node
// 仅使用显式本机快照。输出始终为新创建的文件。
import { readFile, realpath, stat, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fields, requireValue, validateScope } from '../server/offline-material-adapters.mjs';
import { planOffline } from '../server/offline-task-planner.mjs';

async function readJson(path) {
  const canonical = await realpath(path), info = await stat(canonical);
  requireValue(info.isFile() && info.size <= 64 * 1024 * 1024);
  const bytes = await readFile(canonical); requireValue(bytes.length <= 64 * 1024 * 1024);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { canonical, value: JSON.parse(text.replace(/^\uFEFF/, '')) };
}
export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_PLAN_USAGE_ERROR' };
  try {
    const input = await readJson(resolve(args[1])), config = input.value;
    fields(config, ['version', 'scope', 'reports', 'declaration'], ['previousPlan']);
    requireValue(config.version === 'offline-planning-input/1'); validateScope(config.scope);
    requireValue(Array.isArray(config.reports) && config.reports.length <= 100 && config.reports.every(p => typeof p === 'string' && p.length > 0));
    requireValue(config.declaration === null || typeof config.declaration === 'string' && config.declaration.length > 0);
    requireValue(!('previousPlan' in config) || typeof config.previousPlan === 'string' && config.previousPlan.length > 0);
    const base = dirname(input.canonical), reports = [];
    for (const path of config.reports) {
      try { reports.push((await readJson(resolve(base, path))).value); }
      catch { reports.push(null); } // 一个损坏的快照不能抹掉其他独立有效来源。
    }
    let declaration = null;
    if (config.declaration !== null) { try { declaration = (await readJson(resolve(base, config.declaration))).value; } catch { declaration = {}; } }
    const previousPlan = config.previousPlan ? (await readJson(resolve(base, config.previousPlan))).value : null;
    const plan = planOffline({ scope: config.scope, reports, declaration, previousPlan });
    const output = resolve(args[3]), handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(plan, null, 2) + '\n', 'utf8'); }
    catch (error) { await handle.close(); await unlink(output); throw error; }
    await handle.close();
    return { exitCode: 0, message: `OFFLINE_PLAN_WRITTEN sources=${plan.normalization.sources} records=${plan.normalization.records} ready=${plan.tasks.filter(t => t.status === 'ready').length} requests=${plan.customerRequest.requests.length}` };
  } catch { return { exitCode: 4, message: 'OFFLINE_PLAN_INPUT_OR_OUTPUT_REJECTED' }; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
