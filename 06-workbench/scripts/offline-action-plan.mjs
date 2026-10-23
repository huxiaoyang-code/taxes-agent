#!/usr/bin/env node
import { open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedPath } from '../server/offline-material-store.mjs';
import { openOfflineActionInput, assertOfflineActionInputCurrent } from '../server/offline-action-input.mjs';
import { buildOfflineActionPlanFromFiles } from '../server/offline-action-plan.mjs';

export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_ACTION_PLAN_USAGE_ERROR' };
  let session, handle, created = false;
  const output = resolve(args[3]);
  try {
    await checkedPath(dirname(output), true);
    session = await openOfflineActionInput(resolve(args[1]));
    const result = await buildOfflineActionPlanFromFiles(session);
    await assertOfflineActionInputCurrent(session);
    handle = await open(output, 'wx', 0o600); created = true;
    await handle.writeFile(JSON.stringify(result, null, 2) + '\n', 'utf8'); await handle.sync();
    await assertOfflineActionInputCurrent(session); await handle.close(); handle = null;
    return { exitCode: 0, message: `OFFLINE_ACTION_PLAN_WRITTEN candidates=${result.candidates.length} tasks=${result.tasks.length} requests=${result.customerRequest.requests.length}` };
  } catch {
    if (handle) { await handle.close(); handle = null; }
    if (created) await unlink(output).catch(() => {});
    return { exitCode: 4, message: 'OFFLINE_ACTION_PLAN_INPUT_OR_OUTPUT_REJECTED' };
  } finally { session?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
