#!/usr/bin/env node
// Local fixed entry; never online filing. Customer files are retained in place.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadAgencyMaterials, buildAgencyWorkpaper, prepareAgencyPosting, executeAgencyPosting, queryAgencyPosting } from '../server/agency-business.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = 'node scripts/agency-business.mjs workpaper <manifest> | prepare <manifest> <workbench.db> <batchId> <evidenceDir> [posting-options.json] | execute <manifest> <workbench.db> <batchId> <evidenceDir> <accountant-feedback.json> [posting-options.json] | query <identity.json>';
try {
  let result;
  if (command === 'workpaper' && args.length === 1) result = buildAgencyWorkpaper(loadAgencyMaterials(resolve(args[0])));
  else if (['prepare', 'execute'].includes(command) && [command==='prepare'?4:5,command==='prepare'?5:6].includes(args.length)) {
    const session = loadAgencyMaterials(resolve(args[0])), dbPath = resolve(args[1]); process.env.WORKBENCH_DATA_DIR = dirname(dbPath);
    const optionsPath=args[command==='prepare'?4:5],options=optionsPath?JSON.parse(readFileSync(resolve(optionsPath),'utf8')):{};
    if(!options||Array.isArray(options)||typeof options!=='object'||Object.keys(options).some(k=>!['correction','ledgerReconciliation'].includes(k)))throw Object.assign(new Error(usage),{code:'agency_cli_usage'});
    const proposal = await prepareAgencyPosting(session, { ...options,dbPath, batchId: args[2], evidenceDir: resolve(args[3]) });
    if (command === 'prepare') result = proposal;
    else { const feedback = JSON.parse(readFileSync(resolve(args[4]), 'utf8')); result = await executeAgencyPosting(session, { ...feedback, proposal }); }
  } else if (command === 'query' && args.length === 1) { const id = JSON.parse(readFileSync(resolve(args[0]), 'utf8')); process.env.WORKBENCH_DATA_DIR = dirname(id.dbPath); result = await queryAgencyPosting(id); }
  else throw Object.assign(new Error(usage), { code: 'agency_cli_usage' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(JSON.stringify({ code: error.code ?? 'agency_business_failed', ...(error.code === 'agency_cli_usage' ? { usage } : {}) }) + '\n'); process.exitCode = 1; }
