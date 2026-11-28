import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'direct-batch-boundary-'));
const dataDir = join(root, 'data');
const outputDir = join(root, 'out');
mkdirSync(dataDir);
mkdirSync(outputDir);
process.env.WORKBENCH_DATA_DIR = dataDir;
const {db} = await import('../server/db.mjs');
const storage = await import('../server/local-batch-storage.mjs');

const raw = {schemaVersion: 1, jobKey: 'synthetic-old-job', items: [{itemKey: 'one',
  source: {system: 'synthetic', enterpriseKey: 'one', enterpriseName: '合成企业'},
  periods: [{period: '2026-01', imports: [{batchId: 'synthetic-import', mode: 'create', payload: {vouchers: []}}], periodCheck: true}]}]};
const {ok, manifest} = storage.validateManifest(raw);
assert.equal(ok, true);
raw.items[0].periods[0].harnessTasks = [];
const retiredInput = storage.validateManifest(raw);
assert.equal(retiredInput.ok, false);
assert.ok(retiredInput.errors.some(error => error.includes('harnessTasks')));

const plan = storage.buildPlan({manifest, manifestDir: root});
// 用现有持久化接口构造迁移前保存的阶段。隔离库只用于检查续跑和读回。
const spec = {taskId: 'synthetic-stage', storePath: join(root, 'old-store'),
  capabilityId: 'period.inspect', dependencyDigest: '1'.repeat(64)};
manifest.items[0].periods[0].harnessTasks = [spec];
const identity = {taskId: spec.taskId, storePath: process.platform === 'win32' ? spec.storePath.toLowerCase() : spec.storePath};
const stageKey = `harness:${spec.taskId}:${storage.sha256(storage.canonicalJson(identity))}`;
const period = '2026-01';
const inputHash = storage.sha256(storage.canonicalJson({jobKey: raw.jobKey, itemKey: 'one', period, stageKey, spec}));
for (const stage of plan.plans[0].stages) stage.order += 1;
plan.plans[0].stages.unshift({period, stageKey, spec, inputHash, order: 1});
const manifestJson = storage.canonicalJson(manifest);
storage.createJob(db, {manifest, manifestJson, manifestHash: storage.sha256(manifestJson), outputDir, ...plan});
const direct = storage.validateManifest({schemaVersion: 1, jobKey: 'synthetic-native-job', items: [{
  ...raw.items[0], periods: [{period, periodCheck: true}],
}]}).manifest;
const directJson = storage.canonicalJson(direct);
const nativePlan = storage.buildPlan({manifest: direct, manifestDir: root});
storage.createJob(db, {manifest: direct, manifestJson: directJson, manifestHash: storage.sha256(directJson), outputDir, ...nativePlan});
const snapshot = handle => ['jobs', 'items', 'stages', 'locks'].map(table =>
  handle.prepare(`SELECT * FROM local_batch_${table} ORDER BY rowid`).all());
const before = snapshot(db);
db.close();

const cli = (command, args = []) => spawnSync(process.execPath,
  ['scripts/local-batch.mjs', command, '--data-dir', dataDir, '--job-key', manifest.jobKey, ...args],
  {encoding: 'utf8', windowsHide: true, timeout: 30000});
assert.equal(JSON.parse(cli('status').stdout).jobKey, manifest.jobKey);
for (const [command, args] of [['resume', []], ['resume', ['--use-saved-inputs']], ['retry', []], ['cancel', []]]) {
  const result = cli(command, args);
  assert.notEqual(result.status, 0, command);
  assert.match(result.stdout, /legacy_harness_repository_required/, command);
}
const readback = new DatabaseSync(join(dataDir, 'workbench.db'), {readOnly: true});
try { assert.deepEqual(snapshot(readback), before); }
finally { readback.close(); }
console.log('旧批次可查询，续跑、重试和取消均拒绝且证据未改写');
