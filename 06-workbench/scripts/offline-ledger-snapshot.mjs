#!/usr/bin/env node
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReadonlyLedgerSource, captureLedgerSnapshot, validateLedgerSnapshot } from '../server/offline-ledger-snapshot.mjs';

export async function runCli(args) {
  const flags = ['--db', '--enterprise-key', '--account-set-id', '--from', '--to', '--output'];
  if (args.length !== 12 || flags.some((flag, i) => args[i * 2] !== flag || !args[i * 2 + 1]) || !/^[1-9]\d*$/.test(args[5])) return { exitCode: 2, message: 'OFFLINE_LEDGER_SNAPSHOT_USAGE_ERROR' };
  let source;
  try {
    source = openReadonlyLedgerSource(args[1]);
    const snapshot = captureLedgerSnapshot(source, { enterpriseKey: args[3], accountSetId: Number(args[5]), fromPeriod: args[7], toPeriod: args[9] });
    if (validateLedgerSnapshot(source, snapshot).status !== 'current') throw new Error('stale');
    const output = resolve(args[11]), handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(snapshot, null, 2) + '\n', 'utf8'); }
    catch (error) { await handle.close(); await unlink(output); throw error; }
    await handle.close();
    return { exitCode: 0, message: `OFFLINE_LEDGER_SNAPSHOT_WRITTEN posted=${snapshot.counts.posted} draft=${snapshot.counts.draft} missingPeriods=${snapshot.completeness.missingPeriods.length}` };
  } catch { return { exitCode: 4, message: 'OFFLINE_LEDGER_SNAPSHOT_REJECTED' }; }
  finally { source?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
