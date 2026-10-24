#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalFile, checkedPath } from '../server/offline-material-store.mjs';
import { hash } from '../server/offline-material-adapters.mjs';
import { runOfflineVatQ2, checkOfflineVatQ2Current } from '../server/offline-vat-q2.mjs';
export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_VAT_Q2_USAGE_ERROR' };
  let handle;
  try {
    const request = await readLocalFile(resolve(args[1]));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.bytes).replace(/^\uFEFF/, ''));
    for (const key of ['priorInputPath', 'targetInputPath']) if (typeof value?.[key] === 'string') value[key] = resolve(dirname(request.canonicalPath), value[key]);
    if (typeof value?.target?.dbPath === 'string') value.target.dbPath = resolve(dirname(request.canonicalPath), value.target.dbPath);
    const result = await runOfflineVatQ2(value);
    const assertRequest = async () => { if (hash((await readLocalFile(request.canonicalPath)).bytes) !== hash(request.bytes)) throw new Error('request_changed'); };
    await assertRequest();
    const output = resolve(args[3]); await checkedPath(dirname(output), true);
    handle = await open(output, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ publicationStatus: 'diagnostic_only', ...result }, null, 2) + '\n');
    await handle.sync(); await assertRequest();
    // Fresh process, fresh actual pair, fresh Q1 and Q2 calculations after writing.
    if ((await checkOfflineVatQ2Current(value, result.contentDigest)).status !== 'current') throw new Error('publication_stale');
    await assertRequest();
    await handle.close(); handle = undefined;
    return { exitCode: result.q2CalculationReady ? 0 : 3, message: `OFFLINE_VAT_Q2_WRITTEN status=${result.status}` };
  } catch {
    if (handle) try {
      const failed = Buffer.from('{"publicationStatus":"failed","q2CalculationReady":false,"authorizesExecution":false,"submittable":false}\n');
      await handle.write(failed, 0, failed.length, 0); await handle.truncate(failed.length); await handle.sync();
    } catch { /* No partial output can carry authority. */ }
    return { exitCode: 4, message: 'OFFLINE_VAT_Q2_REJECTED' };
  } finally { try { await handle?.close(); } catch { /* Fixed public error. */ } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
