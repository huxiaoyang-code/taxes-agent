#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fields } from '../server/offline-material-adapters.mjs';
import { initMaterialStore, receiveMaterials, inspectMaterialStore, recoverMaterialStoreLock, readLocalFile, checkedPath, safeStoreError } from '../server/offline-material-store.mjs';

export async function runCli(args) {
  const command = args[0], configNeeded = ['init', 'receive'].includes(command);
  const flags = configNeeded ? ['--store', '--config', '--output'] : ['--store', '--output'];
  if (!['init', 'receive', 'inspect', 'recover-lock'].includes(command) || args.length !== flags.length * 2 + 1 || flags.some((f, i) => args[i * 2 + 1] !== f || !args[i * 2 + 2])) return { exitCode: 2, message: 'OFFLINE_STORE_USAGE_ERROR' };
  let handle;
  try {
    const store = resolve(args[2]), output = resolve(args.at(-1));
    await checkedPath(dirname(output), true);
    const rel = relative(store, output);
    if (rel === '' || !rel.startsWith('..') && !isAbsolute(rel)) throw new Error('output_inside_store');
    // Reserve new output before mutations; never receive and then discover overwrite.
    handle = await open(output, 'wx', 0o600);
    let result;
    if (command === 'init') {
      const file = await readLocalFile(resolve(args[4]));
      const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes).replace(/^\uFEFF/, ''));
      fields(config, ['scope']); result = await initMaterialStore(store, config.scope);
    } else if (command === 'receive') result = await receiveMaterials(store, resolve(args[4]));
    else if (command === 'inspect') result = await inspectMaterialStore(store);
    else result = await recoverMaterialStoreLock(store);
    await handle.writeFile(JSON.stringify(result, null, 2) + '\n'); await handle.sync();
    if (result.status === 'blocked_origin_changed') return { exitCode: 4, message: 'OFFLINE_STORE_BLOCKED code=origin_changed' };
    return { exitCode: 0, message: `OFFLINE_STORE_${result.status.toUpperCase()} sources=${result.counts?.sources ?? 0} records=${result.counts?.records ?? 0} receipts=${result.counts?.receipts ?? 0}` };
  } catch (e) {
    // A reserved output can survive errors/response loss. It contains no usable reports.
    if (handle) { try { await handle.writeFile(JSON.stringify({ status: 'blocked', code: safeStoreError(e), authorizesExecution: false, reports: [] }) + '\n'); await handle.sync(); } catch {} }
    return { exitCode: 4, message: `OFFLINE_STORE_BLOCKED code=${safeStoreError(e)}` };
  } finally { if (handle) await handle.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runCli(process.argv.slice(2)); process.stdout.write(r.message + '\n'); process.exitCode = r.exitCode;
}
