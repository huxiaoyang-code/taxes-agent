#!/usr/bin/env node
// 所有读取都使用显式本机快照；唯一写入是创建一个新输出文件。
import { readFile, realpath, stat, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fields, requireValue, hash, validateScope } from '../server/offline-material-adapters.mjs';
import { buildOfflineCandidates } from '../server/offline-bookkeeping.mjs';

async function readJson(path, limit = 64 * 1024 * 1024) {
  const canonical = await realpath(path), info = await stat(canonical);
  requireValue(info.isFile() && info.size <= limit);
  const bytes = await readFile(canonical); requireValue(bytes.length <= limit);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { canonical, text, fileSha256: hash(bytes), value: JSON.parse(text.replace(/^\uFEFF/, '')) };
}
const pathString = p => requireValue(typeof p === 'string' && p.length > 0);
export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_BOOKKEEPING_USAGE_ERROR' };
  try {
    const input = await readJson(resolve(args[1])), config = input.value;
    fields(config, ['version', 'planningInput', 'accountingFacts', 'profileId'], ['previousCandidates']);
    requireValue(config.version === 'offline-bookkeeping-input/1'); pathString(config.planningInput); pathString(config.accountingFacts);
    if ('previousCandidates' in config) pathString(config.previousCandidates);
    const base = dirname(input.canonical), planning = await readJson(resolve(base, config.planningInput)), p = planning.value;
    fields(p, ['version', 'scope', 'reports', 'declaration'], ['previousPlan']);
    requireValue(p.version === 'offline-planning-input/1'); validateScope(p.scope);
    requireValue(Array.isArray(p.reports) && p.reports.length <= 100); p.reports.forEach(pathString);
    if (p.declaration !== null) pathString(p.declaration);
    if ('previousPlan' in p) pathString(p.previousPlan);
    const planBase = dirname(planning.canonical), reports = [];
    for (const path of p.reports) { try { reports.push((await readJson(resolve(planBase, path))).value); } catch { reports.push(null); } }
    let declaration = null;
    if (p.declaration !== null) { try { declaration = (await readJson(resolve(planBase, p.declaration))).value; } catch { declaration = {}; } }
    // previousPlan 只是 #79 的比较提示，绝不使用上传的 ready/status。
    const facts = await readJson(resolve(base, config.accountingFacts), 5 * 1024 * 1024);
    const previous = config.previousCandidates ? (await readJson(resolve(base, config.previousCandidates))).value : null;
    const result = buildOfflineCandidates({ scope: p.scope, reports, declaration, profileId: config.profileId, accountingFacts: { text: facts.text, fileSha256: facts.fileSha256 }, previousCandidates: previous });
    const output = resolve(args[3]), handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(result, null, 2) + '\n', 'utf8'); }
    catch (error) { await handle.close(); await unlink(output); throw error; }
    await handle.close();
    return { exitCode: 0, message: `OFFLINE_BOOKKEEPING_WRITTEN candidates=${result.candidates.length} review=${result.decisions.filter(d => d.status === 'needs_review').length} conflicts=${result.decisions.filter(d => d.status === 'conflict').length}` };
  } catch { return { exitCode: 4, message: 'OFFLINE_BOOKKEEPING_INPUT_OR_OUTPUT_REJECTED' }; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
