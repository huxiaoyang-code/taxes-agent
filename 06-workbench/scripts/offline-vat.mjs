#!/usr/bin/env node
// 每次调用均使用显式文件/存储及全新的私有读取能力。
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openVatInputFiles } from '../server/offline-vat-input.mjs';
import { calculateOfflineVat } from '../server/tax-calculation.mjs';

export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_VAT_USAGE_ERROR' };
  let session;
  try {
    session = await openVatInputFiles(args[1]);
    const result = calculateOfflineVat(session.rawInput, session.source, session.snapshot);
    await session.assertCurrent();
    const output = resolve(args[3]), handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(result, null, 2) + '\n', 'utf8'); }
    catch (e) { await handle.close(); await unlink(output); throw e; }
    await handle.close();
    return { exitCode: result.calculationReady ? 0 : 3, message: `OFFLINE_VAT_WRITTEN ready=${result.calculationReady ? 1 : 0} issues=${result.issues.length}` };
  } catch { return { exitCode: 4, message: 'OFFLINE_VAT_REJECTED' }; }
  finally { session?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
