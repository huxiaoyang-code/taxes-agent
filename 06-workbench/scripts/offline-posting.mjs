#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedPath, readLocalFile } from '../server/offline-material-store.mjs';
import { runOfflinePosting } from '../server/offline-posting.mjs';

export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_POSTING_USAGE_ERROR' };
  let handle, result, started = false;
  try {
    const input = await readLocalFile(resolve(args[1]));
    const request = JSON.parse(input.bytes.toString('utf8').replace(/^\uFEFF/, ''));
    request.inputPath = resolve(dirname(input.canonicalPath), request.inputPath);
    await checkedPath(dirname(resolve(args[3])), true);
    // Reserve the output before any operation: an existing output never executes a write.
    handle = await open(resolve(args[3]), 'wx', 0o600);
    started = true; result = runOfflinePosting(request);
    await handle.writeFile(JSON.stringify(result, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = null;
    return { exitCode: ['applied','recovered','prepared','not_applied'].includes(result.status) ? 0 : 4, message: `OFFLINE_POSTING_RESULT status=${result.status} applied=${result.applied}` };
  } catch {
    return { exitCode: 4, message: started ? `OFFLINE_POSTING_OUTPUT_UNAVAILABLE applied=${result?.applied === true ? 'true' : 'unknown'} query_required=true` : 'OFFLINE_POSTING_INPUT_OR_OUTPUT_REJECTED' };
  } finally { await handle?.close().catch(() => {}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
