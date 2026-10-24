#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalFile, checkedPath } from '../server/offline-material-store.mjs';
import { hash } from '../server/offline-material-adapters.mjs';
import { openOfflineVatPriorContext, assertOfflineVatPriorContextCurrent, closeOfflineVatPriorContext } from '../server/offline-vat-history-context.mjs';

export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_VAT_HISTORY_USAGE_ERROR' };
  let receipt, handle;
  try {
    const request = await readLocalFile(resolve(args[1]));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.bytes).replace(/^\uFEFF/, ''));
    // Preserve unknown fields so the API rejects them instead of silently dropping them.
    if (typeof value?.priorInputPath === 'string') value.priorInputPath = resolve(dirname(request.canonicalPath), value.priorInputPath);
    const opened = await openOfflineVatPriorContext(value); receipt = opened.receipt;
    let result = receipt ? await assertOfflineVatPriorContextCurrent(receipt) : opened.diagnostic;
    if (hash((await readLocalFile(request.canonicalPath)).bytes) !== hash(request.bytes)) throw new Error('request_changed');
    const output = resolve(args[3]); await checkedPath(dirname(output), true);
    handle = await open(output, 'wx', 0o600);
    // No serialized receipt/authority. A partial write is not a success marker.
    await handle.writeFile(JSON.stringify({ publicationStatus: 'diagnostic_only', ...result }, null, 2) + '\n');
    await handle.sync();
    if (hash((await readLocalFile(request.canonicalPath)).bytes) !== hash(request.bytes)) throw new Error('request_changed');
    if (receipt && (await assertOfflineVatPriorContextCurrent(receipt)).status !== 'prior_q1_recomputed') throw new Error('publication_stale');
    if (hash((await readLocalFile(request.canonicalPath)).bytes) !== hash(request.bytes)) throw new Error('request_changed');
    await handle.close(); handle = undefined;
    return { exitCode: result.status === 'prior_q1_recomputed' ? 0 : 3, message: `OFFLINE_VAT_HISTORY_WRITTEN status=${result.status} issues=${result.computation?.issues.length ?? 1}` };
  } catch {
    if (handle) {
      try {
        const failure = Buffer.from('{"publicationStatus":"failed","authorizesExecution":false}\n');
        await handle.write(failure, 0, failure.length, 0); await handle.truncate(failure.length); await handle.sync();
      } catch { /* Partial output cannot be consumed as authority. */ }
    }
    return { exitCode: 4, message: 'OFFLINE_VAT_HISTORY_REJECTED' };
  } finally { try { await handle?.close(); } catch { /* Fixed public errors only. */ } finally { if (receipt) await closeOfflineVatPriorContext(receipt); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
