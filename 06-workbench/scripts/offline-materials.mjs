#!/usr/bin/env node
// Explicit local-only read boundary. No DB connection, network or official import.
import { readFile, open, realpath, stat, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightMaterials } from '../server/offline-materials.mjs';
import { fields, requireValue, sourceText, hash } from '../server/offline-material-adapters.mjs';

const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
async function readLocal(path) {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath);
  requireValue(info.isFile() && info.size <= 5 * 1024 * 1024);
  const bytes = await readFile(canonicalPath);
  requireValue(bytes.length <= 5 * 1024 * 1024);
  return { canonicalPath, bytes };
}
export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'OFFLINE_MATERIALS_USAGE_ERROR' };
  let output;
  try {
    const configFile = await readLocal(resolve(args[1]));
    const config = JSON.parse(decode(configFile.bytes).replace(/^\uFEFF/, ''));
    fields(config, ['scope', 'sources']);
    requireValue(Array.isArray(config.sources) && config.sources.length > 0 && config.sources.length <= 100);
    const sources = [], paths = [];
    for (const source of config.sources) {
      fields(source, ['sourceId', 'kind', 'scope', 'path', 'mapping']);
      requireValue(typeof source.path === 'string' && source.path.length > 0);
      const file = await readLocal(resolve(dirname(configFile.canonicalPath), source.path));
      sources.push({ sourceId: source.sourceId, kind: source.kind, scope: source.scope, text: sourceText(source.kind, file.bytes), fileSha256: hash(file.bytes), mapping: source.mapping });
      paths.push({ sourceId: source.sourceId, path: file.canonicalPath });
    }
    const result = preflightMaterials({ scope: config.scope, sources });
    // Structural failures never create an output. Conflicts are valid local review reports.
    if (result.status === 'rejected') return { exitCode: 3, message: `OFFLINE_MATERIALS_REJECTED code=${result.errors[0].code}` };
    output = resolve(args[3]);
    // wx also rejects symlinks/hardlinks and input aliases because they already exist.
    const handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...result, localFiles: paths, configPath: configFile.canonicalPath }, null, 2) + '\n', 'utf8'); }
    catch (error) { await handle.close(); await unlink(output); throw error; }
    await handle.close();
    return { exitCode: result.ok ? 0 : 3, message: `OFFLINE_MATERIALS_${result.ok ? 'PREFLIGHT' : 'CONFLICT'} sources=${result.counts.sources} records=${result.counts.records}` };
  } catch {
    return { exitCode: 4, message: 'OFFLINE_MATERIALS_IO_OR_CONFIG_ERROR' };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.message + '\n'); process.exitCode = result.exitCode;
}
