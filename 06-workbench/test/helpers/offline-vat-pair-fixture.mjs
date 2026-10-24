// Synthetic originals -> public OFFLINE-03B formal posting -> an existing target DB.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHistoryFixture } from './offline-vat-history-fixture.mjs';
import { openOfflineActionInput } from '../../server/offline-action-input.mjs';
import { buildOfflineActionPlanFromFiles } from '../../server/offline-action-plan.mjs';
import { runOfflinePosting } from '../../server/offline-posting.mjs';
import { hash, stable } from '../../server/offline-material-adapters.mjs';
export const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
export const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
export async function createPairFixture(directory, options = {}) {
  directory = resolve(directory);
  const f = createHistoryFixture(directory, { amounts: [options.priorAmount ?? '407191.00'], post: false });
  const q2 = join(directory, 'q2'); mkdirSync(q2);
  // Derive independent raw evidence with actual April dates, never shift Q2 into Q1.
  const transform = value => Array.isArray(value) ? value.map(transform) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v)])) : typeof value === 'string' ? value.replaceAll('2026-Q1', '2026-Q2').replaceAll('2026-01-13', '2026-04-17').replaceAll('2026-03', '2026-06').replaceAll('2026-01', '2026-04').replaceAll('1001', '2001') : value;
  for (const name of readdirSync(f.dir).filter(n => /\.(json|csv)$/.test(n) && n !== 'request.json')) {
    if (name.endsWith('.json')) writeJson(join(q2, name), transform(readJson(join(f.dir, name))));
    else writeFileSync(join(q2, name), readFileSync(join(f.dir, name), 'utf8').replaceAll('2026-01-13', '2026-04-17').replaceAll('1001', '2001'));
  }
  const amount = options.targetAmount ?? '613427.00'; const net = BigInt(amount.replace('.', '')), vat = net / 100n;
  const fmt = n => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
  const sales = join(q2, 'sales.csv'); const header = readFileSync(sales, 'utf8').split('\n')[0];
  writeFileSync(sales, header + `\n2001,2026-04-17,${f.key},BUYER,${amount},${fmt(vat)},${fmt(net + vat)},blue`);
  const declaration = readJson(join(q2, 'declaration.json')); declaration.opening.state = 'balances_required'; declaration.history.state = 'prior_required'; writeJson(join(q2, 'declaration.json'), declaration);
  const tax = readJson(join(q2, 'tax.json')); tax.enterprise.establishedOn = '2026-01-01';
  for (const item of [tax.enterprise, tax.period, ...tax.period.exclusions, ...tax.invoices]) item.sourceRefs[0].fileSha256 = hash(stable(declaration));
  writeJson(join(q2, 'tax.json'), tax);
  if (options.priorDate) for (const name of ['sales.csv', 'business.json', 'accounting.json']) {
    const path = join(f.dir, name); writeFileSync(path, readFileSync(path, 'utf8').replaceAll('2026-01-13', options.priorDate));
  }
  if (options.establishedOn) {
    const path = join(f.dir, 'tax.json'), tax = readJson(path); tax.enterprise.establishedOn = options.establishedOn; writeJson(path, tax);
  }
  // Opening months must already exist before the read-only consumer runs.
  const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `process.env.WORKBENCH_DATA_DIR=process.argv[1];const {db}=await import(${JSON.stringify(new URL('../../server/db.mjs',import.meta.url).href)});const A=await import(${JSON.stringify(new URL('../../server/accounting.mjs',import.meta.url).href)});try{for(const p of ['2026-04','2026-05','2026-06'])A.ensurePeriod(Number(process.argv[2]),p);}finally{db.close();}`, dirname(f.dbPath), String(f.id)], {encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1',TEMP:directory,TMP:directory}});
  assert.equal(setup.status,0,setup.stderr);
  const db = new DatabaseSync(f.dbPath, {readOnly:true});
  try {
    f.instanceId = db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id;
  } finally { db.close(); }
  for (const dir of [f.dir, q2]) {
    const config = readJson(join(dir, 'input.json'));
    const action = { version: 'offline-action-input/1', scope: config.scope, profileId: config.profileId, materialsInput: config.materialsInput, declaration: config.declaration, accountingFacts: config.accountingFacts };
    const actionPath = join(dir, 'action.json'); writeJson(actionPath, action);
    const s = await openOfflineActionInput(actionPath);
    let plan; try { plan = await buildOfflineActionPlanFromFiles(s); } finally { s.close(); }
    for (const task of plan.tasks.filter(t => t.operation === 'prepare_candidate' && t.kind === 'service_sale')) {
      const r = { version: 'offline-posting-input/1', command: 'prepare', inputPath: actionPath, target: { dbPath: f.dbPath, databaseInstanceId: f.instanceId, accountSetId: f.id, enterpriseKey: f.key }, selected: { taskId: task.taskId, businessKey: task.businessKey } };
      const prepared = runOfflinePosting(r); assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
      const posted = runOfflinePosting({ ...r, command: 'execute', confirmation: { operationId: prepared.operationId, dependencyDigest: prepared.dependencyDigest, policyDigest: prepared.policyDigest, confirmNewSourceBinding: true } });
      assert.equal(posted.status, 'applied', JSON.stringify(posted));
    }
  }
  f.priorInputPath = f.inputPath; f.targetInputPath = join(q2, 'input.json'); f.targetDir = q2;
  f.request = { version: 'offline-vat-pair-request/1', priorInputPath: f.priorInputPath, targetInputPath: f.targetInputPath, target: { dbPath: f.dbPath, databaseInstanceId: f.instanceId, enterpriseKey: f.key, accountSetId: f.id } };
  f.requestPath = join(directory, 'pair-request.json'); writeJson(f.requestPath, f.request); return f;
}
