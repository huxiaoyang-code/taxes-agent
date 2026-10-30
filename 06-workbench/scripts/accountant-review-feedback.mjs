#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalFile, checkedPath } from '../server/offline-material-store.mjs';
import { initReviewStore, registerReview, recordReviewFeedback, inspectReviewStore } from '../server/accountant-review-store.mjs';
const contracts = { init: ['store', 'scope', 'output'], register: ['store', 'input', 'expected-head', 'supersedes', 'output'], feedback: ['store', 'feedback', 'output'], inspect: ['store', 'output'] };
const decode = async path => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await readLocalFile(path)).bytes));
export async function runCli(args) {
  const action = args[0], keys = Object.hasOwn(contracts, action) ? contracts[action] : null, options = {}; let output;
  if (!keys || args.length !== keys.length * 2 + 1) return { exitCode: 2, message: 'ACCOUNTANT_FEEDBACK_USAGE_ERROR' };
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i].slice(2); if (!args[i].startsWith('--') || !keys.includes(k) || Object.hasOwn(options, k) || !args[i + 1]) return { exitCode: 2, message: 'ACCOUNTANT_FEEDBACK_USAGE_ERROR' };
    options[k] = args[i + 1];
  }
  try {
    const outputPath = resolve(options.output), storePath = resolve(options.store);
    // 规范化父目录拒绝别名；任何输出都不得在存储目录内创建锁、回执或产物。
    await checkedPath(dirname(outputPath), true);
    const r = relative(storePath, outputPath);
    if (r === '' || r.split(/[\\/]/)[0] !== '..' && !isAbsolute(r)) throw new Error('output_inside_store');
    try { await checkedPath(storePath, true); } catch (e) { if (e.code !== 'ENOENT') throw e; await checkedPath(dirname(storePath), true); }
    // 先预留输出：不能在变更已提交后才报 EEXIST。
    output = await open(outputPath, 'wx', 0o600);
    await output.writeFile('{"status":"operation_in_progress_or_interrupted","authorizesExecution":false}\n'); await output.sync();
    let result;
    if (action === 'init') result = await initReviewStore(options.store, await decode(options.scope));
    else if (action === 'register') result = await registerReview(options.store, options.input, { expectedJournalHead: options['expected-head'] === 'none' ? null : options['expected-head'], supersedes: options.supersedes === 'none' ? null : options.supersedes });
    else if (action === 'feedback') result = await recordReviewFeedback(options.store, await decode(options.feedback));
    else result = await inspectReviewStore(options.store);
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n'); await output.truncate(0); await output.write(bytes, 0, bytes.length, 0); await output.sync();
    const limited = ['stale', 'blocked', 'unsupported'].includes(result.status);
    return { exitCode: limited ? 3 : 0, message: `ACCOUNTANT_FEEDBACK_RESULT versions=${result.history?.length ?? 0} feedbacks=${result.feedbacks?.length ?? 0} effective=${result.current?.effectiveConfirmation ? 1 : 0}` };
  } catch {
    if (output) { try { const bytes = Buffer.from('{"status":"rejected_or_interrupted_inspect_before_retry","authorizesExecution":false}\n'); await output.truncate(0); await output.write(bytes, 0, bytes.length, 0); await output.sync(); } catch {} }
    return { exitCode: 4, message: 'ACCOUNTANT_FEEDBACK_REJECTED' };
  } finally { try { await output?.close(); } catch {} }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const r = await runCli(process.argv.slice(2)); process.stdout.write(r.message + '\n'); process.exitCode = r.exitCode; }
