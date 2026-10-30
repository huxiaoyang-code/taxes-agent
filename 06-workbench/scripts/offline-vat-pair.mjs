#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalFile, checkedPath } from '../server/offline-material-store.mjs';
import { hash } from '../server/offline-material-adapters.mjs';
import { openOfflineVatPairContext, assertOfflineVatPairContextCurrent, closeOfflineVatPairContext } from '../server/offline-vat-pair-context.mjs';

export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_VAT_PAIR_USAGE_ERROR' };
  let receipt, handle;
  try {
    const request = await readLocalFile(resolve(args[1]));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.bytes).replace(/^\uFEFF/, ''));
    // 保留未知字段，让 API 拒绝，而不是静默丢弃。
    for (const key of ['priorInputPath', 'targetInputPath']) if (typeof value?.[key] === 'string') value[key] = resolve(dirname(request.canonicalPath), value[key]);
    if (typeof value?.target?.dbPath === 'string') value.target.dbPath = resolve(dirname(request.canonicalPath), value.target.dbPath);
    const opened = await openOfflineVatPairContext(value); receipt = opened.receipt;
    let result = receipt ? await assertOfflineVatPairContextCurrent(receipt) : opened.diagnostic;
    if (hash((await readLocalFile(request.canonicalPath)).bytes) !== hash(request.bytes)) throw new Error('request_changed');
    const output = resolve(args[3]); await checkedPath(dirname(output), true);
    handle = await open(output, 'wx', 0o600);
    // 不序列化回执或授权依据。部分写入不能作为成功标记。
    await handle.writeFile(JSON.stringify({ publicationStatus: 'diagnostic_only', ...result }, null, 2) + '\n');
    await handle.sync();
    if (hash((await readLocalFile(request.canonicalPath)).bytes) !== hash(request.bytes)) throw new Error('request_changed');
    if (receipt && (await assertOfflineVatPairContextCurrent(receipt)).status !== 'pair_bound_prior_q1_recomputed') throw new Error('publication_stale');
    if (hash((await readLocalFile(request.canonicalPath)).bytes) !== hash(request.bytes)) throw new Error('request_changed');
    await handle.close(); handle = undefined;
    return { exitCode: result.status === 'pair_bound_prior_q1_recomputed' ? 0 : 3, message: `OFFLINE_VAT_PAIR_WRITTEN status=${result.status} issues=${result.targetDiagnostics?.issues.length ?? 1}` };
  } catch {
    if (handle) {
      try {
        const failure = Buffer.from('{"publicationStatus":"failed","targetBinding":"not_verified","q2CalculationReady":false,"authorizesExecution":false}\n');
        await handle.write(failure, 0, failure.length, 0); await handle.truncate(failure.length); await handle.sync();
      } catch { /* 部分输出不能作为授权依据消费。 */ }
    }
    return { exitCode: 4, message: 'OFFLINE_VAT_PAIR_REJECTED' };
  } finally { try { await handle?.close(); } catch { /* 只返回固定的公开错误。 */ } finally { if (receipt) await closeOfflineVatPairContext(receipt); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2)); process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
