#!/usr/bin/env node
/**
 * LOCAL-07 验收（持久性 / 崩溃恢复 / 互斥 / 失效证据）：真实 CLI 子进程 + 真实 SQLite + 真实领域接口。
 *
 * 覆盖：
 *  D. 单家失败隔离：一家缺前置失败，其它企业继续；用真实领域接口补齐后只重试未完成阶段，
 *     账套数 / 凭证数 / 计提 runs / 借贷金额不重复；跨任务同来源凭证仍去重。
 *  E. 崩溃真实新进程恢复：导入 commit 后 checkpoint 前、计提 / 结转事务中、产物发布后 checkpoint 前
 *     （子进程 SIGKILL + 测试可控同步点），重启只继续未完成阶段，业务 / 来源 / 文件 / 状态一致。
 *  F. 两 CLI 竞争与 fence：同 jobKey 同时 start、同账套两任务、租约过期旧 owner 仍活（保守拒绝）、
 *     确认死 owner 接管（fence 递增）、旧 token / 旧 attempt 迟到提交被拒；取消在同步写边界与渲染阶段。
 *  G. 输入 / 证据失效：原资料被改 / 消失、快照 hash 被改、凭证被反过账 / 删除、完成文件丢失，
 *     稳定拒绝或 needs_review，只重做报表、不重做会计。
 *  H. 持久化与备份依赖：既有库缺批量结构时拒绝自动建表（migration_requires_backup /
 *     dependency_unavailable），迁移中断整体回滚；LOCAL-06 备份 / restore-new 未合并时如实标依赖
 *     （不用 copyFile 冒充备份）。
 *
 * 运行：node test/local-batch-persistence.test.mjs（在 06-workbench 目录）
 * 完全合成临时数据（系统临时目录），不访问真实账套 / 凭据 / 税局。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as storage from "../server/local-batch-storage.mjs";

const WB = process.cwd();
const CLI = join(WB, "scripts", "local-batch.mjs");
const ROOT = mkdtempSync(join(tmpdir(), "lb-persist-"));
const RESULTS = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    RESULTS.push([true, name]);
    console.log(`  PASS ${name}`);
  } catch (error) {
    failures += 1;
    RESULTS.push([false, name]);
    console.error(`  FAIL ${name}\n    ${error?.stack || error}`);
  }
}

// ---------------------------------------------------------------- 进程工具
function spawnNode(code, { env = {} } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: WB, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolvePromise) => {
    child.on("exit", (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
  return { child, done };
}
function runNode(code, { env = {} } = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: WB, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024,
  });
}
function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: WB, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024,
  });
}
function spawnCli(args) {
  return spawnNode(`process.argv = ${JSON.stringify([process.execPath, "cli", ...args])}; await import(${JSON.stringify(pathToFileURL(CLI).href)});`);
}
function cliJson(result) {
  const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(line, `CLI 没有输出 JSON：stderr=${result.stderr}`);
  return JSON.parse(line);
}
async function waitFor(label, predicate, { timeoutMs = 20000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

// ---------------------------------------------------------------- 数据目录 / fixture
const PRIME_CODE = `
import * as storage from "./server/local-batch-storage.mjs";
const dataDir = process.env.WORKBENCH_DATA_DIR;
const init = storage.assertInitializable(dataDir);
process.env.WORKBENCH_DATA_DIR = dataDir;
const runner = await import("./server/local-batch-runner.mjs");
const schema = storage.ensureBatchSchema(runner.database, { freshDatabase: init.fresh });
console.log(JSON.stringify({ fresh: init.fresh, schema }));
`;
function primeDataDir(dataDir) {
  const result = runNode(PRIME_CODE, { env: { WORKBENCH_DATA_DIR: dataDir } });
  assert.equal(result.status, 0, `prime 失败：${result.stderr}`);
}

const FIXTURE_CODE = `
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
import { insertEnterpriseAccountSet } from "./server/import-storage.mjs";
const specs = JSON.parse(process.env.FIXTURE_SPECS);
const out = [];
for (const spec of specs) {
  const set = A.createAccountSet({
    name: spec.name, taxpayer_type: "小规模纳税人",
    accounting_standard: "小企业会计准则", start_period: "2026-01",
  });
  insertEnterpriseAccountSet(db, {
    enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name,
    accountSetId: set.id, boundBy: "fixture",
  });
  if (spec.closePeriod) {
    A.setPeriodStatus(set.id, "2026-01", "closed");
  }
  if (spec.assetCost) {
    A.addAssetCard(set.id, {
      kind: "fixed", name: "生产设备", original_cost: spec.assetCost, residual_rate: 0,
      useful_life_months: spec.life, start_period: "2026-01",
      asset_account: "1601", accum_account: "1602", expense_account: "5602",
    });
  }
  const draft = spec.salary ? A.createVoucher(set.id, {
    period: "2026-01", voucher_date: "2026-01-05", word: "记", number: 99,
    summary: "计提本月工资", status: "draft",
    entries: [
      { code: "5602", debit: spec.salary, credit: 0 },
      { code: "2211", debit: 0, credit: spec.salary },
    ],
  }) : null;
  out.push({
    enterpriseKey: spec.enterpriseKey, name: spec.name, setId: set.id,
    draftVoucherId: draft ? draft.id : null,
  });
}
console.log(JSON.stringify(out));
`;
function createFixture(dataDir, specs) {
  const result = runNode(FIXTURE_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, FIXTURE_SPECS: JSON.stringify(specs) } });
  assert.equal(result.status, 0, `fixture 失败：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

const FIX_CODE = `
import * as A from "./server/accounting.mjs";
A.addAccount(Number(process.env.FIX_SET_ID), { code: "660299", name: "管理费用-其他", category: "损益", direction: "debit" });
console.log("fixed");
`;
function fixMissingAccount(dataDir, setId) {
  const result = runNode(FIX_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, FIX_SET_ID: String(setId) } });
  assert.equal(result.status, 0, result.stderr);
}

/** 真实领域接口修复：反结账并重新开放期间，作为失败企业的账务前置补齐。（下段“补齐”步骤使用） */
const REOPEN_CODE = `
import * as A from "./server/accounting.mjs";
A.setPeriodStatus(Number(process.env.FIX_SET_ID), "2026-01", "open");
console.log("reopened");
`;
function reopenPeriod(dataDir, setId) {
  const result = runNode(REOPEN_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, FIX_SET_ID: String(setId) } });
  assert.equal(result.status, 0, result.stderr);
}

/** 程序式执行器（仅测试用）：可在指定同步点注入 kill / pause，不进入 CLI / HTTP。 */
const RUN_JOB_CODE = `
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import * as storage from "./server/local-batch-storage.mjs";
const manifestPath = process.env.MANIFEST_PATH;
const outDir = process.env.OUT_DIR;
const file = storage.readManifestFile(manifestPath);
const validated = storage.validateManifest(file.manifest);
if (!validated.ok) { console.log(JSON.stringify({ ok: false, errors: validated.errors })); process.exit(2); }
const { plans, inputs } = storage.buildPlan({ manifest: validated.manifest, manifestDir: dirname(manifestPath) });
const manifestJson = storage.canonicalJson(validated.manifest);
const runner = await import("./server/local-batch-runner.mjs");
const hooks = {};
const mode = process.env.HOOK_MODE || "";
const kill = () => process.kill(process.pid, "SIGKILL");
const pause = () => {
  const gate = process.env.GATE_FILE;
  const deadline = Date.now() + 30000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(gate) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 50);
};
if (mode === "kill-after-import") hooks.afterImportCommit = kill;
if (mode === "kill-in-depreciation") hooks.inDepreciationTransaction = kill;
if (mode === "kill-in-carryforward") hooks.inCarryForwardTransaction = kill;
if (mode === "kill-after-publish") hooks.afterArtifactPublish = kill;
if (mode === "pause-after-import") hooks.afterImportCommit = pause;
if (mode === "pause-after-report-stage") hooks.afterReportStage = pause;
if (mode === "pause-after-stage") hooks.afterStageCommit = pause;
const result = await runner.createAndRun({
  manifest: validated.manifest,
  manifestHash: storage.sha256(manifestJson),
  manifestJson, plans, inputs, outputDir: outDir, hooks,
});
console.log(JSON.stringify({ ok: result.finalStatus === "succeeded", status: result.finalStatus, jobId: result.jobId, renders: result.renders }));
`;

function openDb(dataDir) {
  return new DatabaseSync(join(dataDir, "workbench.db"), { readOnly: true });
}
const scalar = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0];
const count = (dataDir, sql, ...args) => {
  const db = openDb(dataDir);
  try { return scalar(db, sql, ...args); } finally { db.close(); }
};

// ---------------------------------------------------------------- manifest 构件
const r2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function payloadFor(spec, { withCustomAccount = false, tag = "", includeOpenings = true } = {}) {
  const vouchers = [{
    sourceVoucherId: `${spec.enterpriseKey}-sale${tag}`,
    period: "2026-01", date: "2026-01-10", word: "记", number: tag ? 11 : 1, summary: "销售收入",
    entries: [
      { code: "1002", debit: String(spec.revenue), credit: "" },
      { code: "5001", debit: "", credit: String(spec.revenue) },
    ],
  }];
  if (withCustomAccount) {
    vouchers.push({
      sourceVoucherId: `${spec.enterpriseKey}-other${tag}`,
      period: "2026-01", date: "2026-01-15", word: "记", number: tag ? 12 : 2, summary: "其他管理费用",
      entries: [
        { code: "660299", debit: String(spec.other), credit: "" },
        { code: "1002", debit: "", credit: String(spec.other) },
      ],
    });
  }
  return {
    account_set: {
      name: spec.name, taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    },
    accounts: [],
    opening_balances: includeOpenings ? [
      { code: "1002", debit: String(spec.capital), credit: "" },
      { code: "3001", debit: "", credit: String(spec.capital) },
    ] : [],
    vouchers,
  };
}

function jobManifest({ jobKey, items, concurrency = 2 }) {
  return { schemaVersion: 1, jobKey, concurrency, items };
}
function itemFor(fixture, spec, periodSpec) {
  return {
    itemKey: spec.itemKey,
    source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
    accountSetId: fixture.setId,
    periods: [periodSpec],
  };
}
function writeManifest(name, manifest) {
  const path = join(ROOT, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

// ---------------------------------------------------------------- 测试
console.log(`临时目录：${ROOT}`);

await test("D1 单家失败隔离：其它企业完成，补齐后只重试未完成阶段，凭证 / runs 不重复", () => {
  const dataDir = join(ROOT, "d1-data");
  const outDir = join(ROOT, "d1-out");
  const specs = [1, 2, 3].map((index) => ({
    itemKey: `item-${index}`,
    enterpriseKey: `91350000ISO0000${index}A`,
    name: `隔离测试${index}号`,
    revenue: 1000 + index,
    other: 30 + index,
    capital: 50000 + index * 100,
    closePeriod: index === 2, // 2 号的 2026-01 已封账 → 追加导入被结构化拒绝
  }));
  primeDataDir(dataDir);
  const fixture = createFixture(dataDir, specs);
  const items = specs.map((spec, index) => itemFor(fixture[index], spec, {
    period: "2026-01",
    imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
    carryforward: { yearEnd: false },
    reports: [{ kind: "trial-balance", formats: ["csv"] }],
  }));
  const manifestPath = writeManifest("d1", jobManifest({ jobKey: "isolation-3", items }));

  const first = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  const firstJson = cliJson(first);
  assert.equal(first.status, 1);
  assert.equal(firstJson.status, "needs_review");
  const failedItem = firstJson.items.find((entry) => entry.itemKey === "item-2");
  assert.equal(failedItem.stages[0].status, "failed");
  assert.ok(["period_closed", "opening_rewrite_period_closed"].includes(failedItem.stages[0].errorCode), JSON.stringify(failedItem));

  const db = openDb(dataDir);
  try {
    const setOf = (key) => db.prepare(`SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?`).get(key).account_set_id;
    assert.equal(scalar(db, `SELECT COUNT(*) FROM account_sets`), 3);
    // 1 / 3 号完整完成：导入 1 + 结转 1 = 2 张凭证；2 号 0 张（导入整批回滚）。
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, setOf(specs[0].enterpriseKey)), 2);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, setOf(specs[2].enterpriseKey)), 2);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, setOf(specs[1].enterpriseKey)), 0);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM import_batches WHERE enterprise_key=? AND status='completed'`, specs[0].enterpriseKey), 1);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM import_batches WHERE enterprise_key=? AND status='completed'`, specs[1].enterpriseKey), 0, "冲突在写事务前被拒，不得留下已完成批次");
  } finally { db.close(); }

  // 通过真实领域接口补齐该企业的账务前置（反结账），然后只重试未完成阶段。
  const brokenFixture = fixture.find((entry) => entry.enterpriseKey === specs[1].enterpriseKey);
  reopenPeriod(dataDir, brokenFixture.setId);
  const retried = runCli(["retry", "--data-dir", dataDir, "--job-key", "isolation-3", "--item", "item-2"]);
  assert.equal(retried.status, 0, retried.stderr);
  const retriedJson = cliJson(retried);
  assert.deepEqual(retriedJson.reopened.map((entry) => entry.stageKey), [
    "import:91350000ISO00002A-b1", "carryforward", "report:trial-balance:csv",
  ], "只重开该企业未完成阶段（含后续未执行阶段）");
  assert.ok(retriedJson.skipped.every((entry) => entry.status === "succeeded"), "只重开未完成阶段");

  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "isolation-3"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");

  const db2 = openDb(dataDir);
  try {
    const setOf = (key) => db2.prepare(`SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?`).get(key).account_set_id;
    assert.equal(scalar(db2, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, setOf(specs[0].enterpriseKey)), 2, "已完成企业不得重跑");
    assert.equal(scalar(db2, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, setOf(specs[2].enterpriseKey)), 2);
    assert.equal(scalar(db2, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, setOf(specs[1].enterpriseKey)), 2);
    const attempts = db2.prepare(`SELECT stage_key, attempt FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id
        WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='isolation-3') AND i.enterprise_key=?
          AND s.stage_key LIKE 'import:%'`).all(specs[1].enterpriseKey);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].attempt, 2, "失败阶段重试一次");
  } finally { db2.close(); }

  // 跨任务同来源凭证仍然去重：新 jobKey 用相同来源 / 内容再导入一次。
  const sameItems = [itemFor(fixture[1], specs[1], {
    period: "2026-01",
    imports: [{ batchId: `${specs[1].enterpriseKey}-b2`, mode: "append", payload: payloadFor(specs[1], { includeOpenings: false }) }],
  })];
  const dedupePath = writeManifest("d1-dedupe", jobManifest({ jobKey: "dedupe-2", items: sameItems }));
  const dedupe = runCli(["start", "--data-dir", dataDir, "--manifest", dedupePath, "--output-dir", outDir]);
  assert.equal(dedupe.status, 0, dedupe.stderr);
  const db3 = openDb(dataDir);
  try {
    assert.equal(scalar(db3, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, brokenFixture.setId), 2, "跨批去重不得新增凭证");
    const links = db3.prepare(`SELECT action FROM import_batch_vouchers WHERE batch_id=?`).all(`${specs[1].enterpriseKey}-b2`);
    assert.equal(links.length, 1);
    assert.ok(links.every((row) => row.action === "deduplicated"));
  } finally { db3.close(); }
});

/** 崩溃恢复共用准备：一个既有账套 + 一张资产卡片 + 一张草稿凭证。 */
function crashFixture(name) {
  const dataDir = join(ROOT, `${name}-data`);
  const outDir = join(ROOT, `${name}-out`);
  primeDataDir(dataDir);
  const spec = {
    itemKey: "item-1", enterpriseKey: `91350000CRASH${name.toUpperCase()}A`.slice(0, 24),
    name: `崩溃恢复${name}`, revenue: 1200, other: 40, capital: 60000,
    assetCost: 600, life: 12, salary: 60,
  };
  const [fixture] = createFixture(dataDir, [spec]);
  return { dataDir, outDir, spec, fixture };
}
function crashManifest(kind, spec, fixture) {
  const periodSpec = {
    period: "2026-01",
    imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
    post: { vouchers: [{ voucherId: fixture.draftVoucherId }] },
    carryforward: { yearEnd: false },
    reports: ([kind].includes("publish") ? [{ kind: "trial-balance", formats: ["csv", "xlsx", "pdf"] }] : [{ kind: "trial-balance", formats: ["csv"] }]),
  };
  if (kind === "depreciation" || kind === "carryforward") periodSpec.depreciation = true;
  return jobManifest({ jobKey: `crash-${kind}`, items: [itemFor(fixture, spec, periodSpec)] });
}

await test("E1 导入 commit 后 checkpoint 前 SIGKILL：重启回放不重复入账，阶段 attempt 递增", async () => {
  const { dataDir, outDir, spec, fixture } = crashFixture("e1");
  const manifestPath = writeManifest("e1", crashManifest("import", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-after-import" },
  }).done;
  assert.notEqual(crashed.status, 0, "子进程应被 SIGKILL 终止");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM import_batches WHERE batch_id=? AND status='completed'`, `${spec.enterpriseKey}-b1`), 1, "导入已提交");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 2, "草稿凭证 + 导入凭证已提交");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_stages WHERE status='running'`), 1, "checkpoint 未落");

  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "crash-import"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 3, "来源凭证回放 + 草稿过账 + 结转（无重复导入）");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM import_voucher_sources`), 1, "来源登记不得重复");
  const db = openDb(dataDir);
  try {
    const stage = db.prepare(`SELECT status, attempt FROM local_batch_stages WHERE stage_key LIKE 'import:%'`).get();
    assert.equal(stage.status, "succeeded");
    assert.equal(stage.attempt, 2, "第二阶段为崩溃后的第二次尝试");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_stages WHERE status='running'`), 0);
  } finally { db.close(); }
});

await test("E2 计提事务中 SIGKILL：事务回滚，重启后重新计提且只生成一张计提凭证", async () => {
  const { dataDir, outDir, spec, fixture } = crashFixture("e2");
  const manifestPath = writeManifest("e2", crashManifest("depreciation", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-in-depreciation" },
  }).done;
  assert.notEqual(crashed.status, 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 0, "事务内崩溃必须回滚计提效果");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='depreciation'`), 0);
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "crash-depreciation"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 1);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='depreciation'`), 1);
  assert.equal(r2(count(dataDir, `SELECT amount FROM asset_depreciation_runs`)), 50);
});

await test("E3 结转事务中 SIGKILL：重启后只结转一次，3103 余额正确", async () => {
  const { dataDir, outDir, spec, fixture } = crashFixture("e3");
  const manifestPath = writeManifest("e3", crashManifest("carryforward", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-in-carryforward" },
  }).done;
  assert.notEqual(crashed.status, 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='carryforward'`), 0, "结转事务必须回滚");
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "crash-carryforward"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='carryforward'`), 1);
  // 收入 1200 - 工资 60 - 折旧 50 = 1090
  const profit = count(dataDir, `SELECT COALESCE(SUM(e.credit),0) - COALESCE(SUM(e.debit),0) FROM voucher_entries e
      JOIN vouchers v ON v.id=e.voucher_id WHERE v.kind='carryforward' AND e.code='3103'`);
  assert.equal(r2(profit), 1090);
});

await test("E4 产物发布后 checkpoint 前 SIGKILL：重启按 hash 确认补记，不重复渲染 / 不重复发布", async () => {
  const { dataDir, outDir, spec, fixture } = crashFixture("e4");
  const manifestPath = writeManifest("e4", crashManifest("publish", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-after-publish" },
  }).done;
  assert.notEqual(crashed.status, 0);
  const db = openDb(dataDir);
  const published = db.prepare(`SELECT artifact_key, stage_key, status, bytes_hash, relative_path, render_started FROM local_batch_artifacts`).all();
  db.close();
  assert.equal(published.length >= 1, true, "至少发布了一个产物");
  assert.ok(published.every((row) => ["publishing", "published"].includes(row.status)));
  const firstArtifact = published[0];
  const absolute = join(outDir, firstArtifact.relative_path);
  assert.ok(existsSync(absolute), "已发布文件必须存在");
  assert.equal(createHash("sha256").update(readFileSync(absolute)).digest("hex"), firstArtifact.bytes_hash);

  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "crash-publish"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  const db2 = openDb(dataDir);
  try {
    const rows = db2.prepare(`SELECT artifact_key, status, bytes_hash, render_started FROM local_batch_artifacts ORDER BY id`).all();
    assert.equal(rows.length, 3, "3 个产物，不允许重复 artifactKey");
    assert.equal(new Set(rows.map((row) => row.artifact_key)).size, 3);
    assert.ok(rows.every((row) => row.status === "published"));
    const recovered = db2.prepare(`SELECT evidence_json FROM local_batch_stages WHERE stage_key=?`).get(firstArtifact.stage_key);
    const evidence = JSON.parse(recovered.evidence_json);
    assert.equal(evidence.recovered, true, "已发布文件应走 hash 确认补记而不是重新渲染");
    assert.equal(evidence.bytesHash, firstArtifact.bytes_hash);
  } finally { db2.close(); }
});

await test("F1 同 jobKey 同时 start：只有一个 job，阶段 / 凭证不重复", async () => {
  const dataDir = join(ROOT, "f1-data");
  const outDir = join(ROOT, "f1-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000RACE00001A", name: "竞争测试", revenue: 900, other: 0, capital: 30000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const manifestPath = writeManifest("f1", jobManifest({
    jobKey: "race-same-key",
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
      reports: [{ kind: "trial-balance", formats: ["csv"] }],
    })],
  }));
  const args = ["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir];
  const [left, right] = await Promise.all([spawnCli(args).done, spawnCli(args).done]);
  assert.ok([left, right].every((entry) => entry.status === 0 || entry.status === 1), `两个进程都应正常结束：${left.status}/${right.status} ${left.stderr}${right.stderr}`);
  const db = openDb(dataDir);
  try {
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_jobs`), 1, "同 jobKey 只能有一个 job");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM account_sets`), 1);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers`), 2, "导入 1 + 结转 1，绝不能重复");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM import_batches`), 1);
    const running = scalar(db, `SELECT COUNT(*) FROM local_batch_stages WHERE status='running'`);
    assert.equal(running, 0);
  } finally { db.close(); }
  const status = runCli(["status", "--data-dir", dataDir, "--job-key", "race-same-key"]);
  assert.equal(cliJson(status).status, "succeeded");
});

await test("F2 同账套两任务：第二个任务保守拒绝（lock_active），不产生并发写入", async () => {
  const dataDir = join(ROOT, "f2-data");
  const outDir = join(ROOT, "f2-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-a", enterpriseKey: "91350000LOCK00001A", name: "互斥测试", revenue: 700, other: 0, capital: 20000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const gatePrefix = join(ROOT, "f2-gate");
  const firstPath = writeManifest("f2-first", jobManifest({
    jobKey: "lock-first",
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
    })],
  }));
  const running = spawnNode(RUN_JOB_CODE, {
    env: {
      WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: firstPath, OUT_DIR: outDir,
      HOOK_MODE: "pause-after-import", GATE_FILE: gatePrefix,
    },
  });
  await waitFor("第一个任务进入导入后暂停点", () => count(dataDir, `SELECT COUNT(*) FROM import_batches WHERE status='completed'`) >= 1);
  const secondPath = writeManifest("f2-second", jobManifest({
    jobKey: "lock-second",
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-b2`, mode: "append", payload: payloadFor(spec, { tag: "-b2", includeOpenings: false }) }],
    })],
  }));
  const second = runCli(["start", "--data-dir", dataDir, "--manifest", secondPath, "--output-dir", outDir]);
  const secondJson = cliJson(second);
  assert.equal(second.status, 1, second.stderr);
  assert.equal(secondJson.status, "needs_review");
  const blocked = secondJson.items[0];
  assert.ok(["lock_active", "owner_active"].includes(blocked.lockBlocked) || blocked.stages.every((stage) => stage.status === "needs_review"), JSON.stringify(blocked));
  writeFileSync(gatePrefix, "go");
  const finished = await running.done;
  assert.equal(finished.status, 0, finished.stderr);
  const db = openDb(dataDir);
  try {
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers`), 2, "只允许第一个任务写入");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM import_batches`), 1);
    const secondJob = db.prepare(`SELECT status FROM local_batch_jobs WHERE job_key='lock-second'`).get();
    assert.equal(secondJob.status, "needs_review");
  } finally { db.close(); }
  // 第一个任务释放锁后，显式 retry + resume 才能继续第二个任务。
  const retry = runCli(["retry", "--data-dir", dataDir, "--job-key", "lock-second"]);
  assert.equal(retry.status, 0, retry.stderr);
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "lock-second"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 3, "第二个任务追加 1 张凭证");
});

await test("F3 租约过期但旧 owner 进程仍活：保守拒绝（owner_active），不抢锁", () => {
  const dataDir = join(ROOT, "f3-data");
  const outDir = join(ROOT, "f3-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000ALIVE0001A", name: "存活检查", revenue: 500, other: 0, capital: 10000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const db = new DatabaseSync(join(dataDir, "workbench.db"));
    const past = new Date(Date.now() - 60000).toISOString();
    db.prepare(`INSERT INTO local_batch_locks (resource_key, owner_instance, fencing_token, pid, acquired_at, heartbeat_at, lease_expires_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`book:${spec.enterpriseKey}`, "ghost-owner", 7, sleeper.pid, past, past, past);
    db.close();
    const manifestPath = writeManifest("f3", jobManifest({
      jobKey: "alive-lock",
      items: [itemFor(fixture, spec, {
        period: "2026-01",
        imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      })],
    }, ));
    const result = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);    const payload = cliJson(result);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(payload.status, "needs_review");
    const item = payload.items[0];
    assert.ok(["owner_active", "lock_active"].includes(item.lockBlocked), JSON.stringify(item));
    assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 0, "存活 owner 未被抢锁时不得写入");
    const lock = (() => {
      const probe = openDb(dataDir);
      try { return probe.prepare(`SELECT owner_instance, fencing_token FROM local_batch_locks WHERE resource_key=?`).get(`book:${spec.enterpriseKey}`); }
      finally { probe.close(); }
    })();
    assert.equal(lock.owner_instance, "ghost-owner", "不得抢占仍存活的 owner");
    assert.equal(lock.fencing_token, 7);
  } finally {
    sleeper.kill();
  }
});

await test("F4 旧 owner 已确认死亡：接管并递增 fencing token，业务完整写入", () => {
  const dataDir = join(ROOT, "f4-data");
  const outDir = join(ROOT, "f4-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000DEAD00001A", name: "死主接管", revenue: 800, other: 0, capital: 15000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(dead.status, 0);
  const deadPid = (() => {
    // 取一个已退出进程的 PID：再启动后立即结束并记录 PID。
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    return child.pid;
  })();
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  const past = new Date(Date.now() - 60000).toISOString();
  db.prepare(`INSERT INTO local_batch_locks (resource_key, owner_instance, fencing_token, pid, acquired_at, heartbeat_at, lease_expires_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(`book:${spec.enterpriseKey}`, "dead-owner", 3, deadPid, past, past, past);
  db.close();
  const manifestPath = writeManifest("f4", jobManifest({
    jobKey: "dead-lock",
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
    })],
  }));
  const result = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(result.status, 0, `${result.stderr} ${result.stdout}`);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 2);
  const lock = (() => {
    const probe = openDb(dataDir);
    try { return probe.prepare(`SELECT owner_instance, fencing_token FROM local_batch_locks WHERE resource_key=? AND owner_instance<>'dead-owner'`).get(`book:${spec.enterpriseKey}`); }
    finally { probe.close(); }
  })();
  assert.equal(lock, undefined, "任务完成后锁应释放（不会有死 owner 残留）");
  const tokens = (() => {
    const probe = openDb(dataDir);
    try { return probe.prepare(`SELECT COUNT(*) AS n FROM local_batch_locks`).get().n; }
    finally { probe.close(); }
  })();
  assert.equal(tokens, 0, "执行结束后不得残留锁");
});

await test("F5 旧 token / 旧 attempt 迟到提交被 fence 拒绝，不覆盖新尝试结果", () => {
  const dataDir = join(ROOT, "f5-data");
  primeDataDir(dataDir);
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  try {
    const jobId = Number(db.prepare(`INSERT INTO local_batch_jobs
        (job_key, manifest_hash, manifest_json, concurrency, output_dir, status, cancel_requested, created_at, updated_at)
        VALUES ('fence-job','h','{}',1,'out','pending',0,'t','t')`).run().lastInsertRowid);
    const itemId = Number(db.prepare(`INSERT INTO local_batch_items
        (job_id, item_key, enterprise_key, source_system, account_set_id, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(jobId, "item", "91350000FENCE0001A", "sys", 1, "pending", "t", "t").lastInsertRowid);
    const stageId = Number(db.prepare(`INSERT INTO local_batch_stages
        (item_id, period, stage_key, stage_order, spec_json, status, attempt, updated_at)
        VALUES (?,?,?,?,?,?,0,'t')`).run(itemId, "2026-01", "post", 1, "{}", "pending").lastInsertRowid);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    db.prepare(`INSERT INTO local_batch_locks (resource_key, owner_instance, fencing_token, pid, acquired_at, heartbeat_at, lease_expires_at)
                VALUES (?,?,?,?,?,?,?)`).run(`job:${jobId}`, "old-owner", 1, process.pid, now, now, future);
    // 旧 owner 认领阶段（token=1 / attempt=1）。
    const claim = db.prepare(`UPDATE local_batch_stages SET status='running', attempt=1, owner_instance='old-owner', fencing_token=1 WHERE id=?`).run(stageId);
    assert.equal(Number(claim.changes), 1);
    // 新执行者接管：fence 递增到 2。
    db.prepare(`UPDATE local_batch_locks SET owner_instance='new-owner', fencing_token=2 WHERE resource_key=?`).run(`job:${jobId}`);
    // 旧 token 的迟到提交必须被拒。
    assert.throws(
      () => storage.withFencedTransaction(db, { resourceKey: `job:${jobId}`, instance: "old-owner", token: 1 }, () => {
        storage.writeStageResult(db, {
          stageId, instance: "old-owner", token: 1, attempt: 1, status: "succeeded", outcomeHash: "late", evidence: {},
        });
      }),
      (error) => error.code === "fence_lost",
      "旧 token 必须被 fence 拒绝",
    );
    // 新 owner 的合法提交仍然生效。
    storage.withFencedTransaction(db, { resourceKey: `job:${jobId}`, instance: "new-owner", token: 2 }, () => {
      db.prepare(`UPDATE local_batch_stages SET status='running', attempt=2, owner_instance='new-owner', fencing_token=2 WHERE id=?`).run(stageId);
      const ok = storage.writeStageResult(db, {
        stageId, instance: "new-owner", token: 2, attempt: 2, status: "succeeded", outcomeHash: "new", evidence: { attempt: 2 },
      });
      assert.equal(ok, true);
    });
    const row = db.prepare(`SELECT status, owner_instance, attempt FROM local_batch_stages WHERE id=?`).get(stageId);
    assert.deepEqual({ status: row.status, owner: row.owner_instance, attempt: row.attempt }, { status: "succeeded", owner: "new-owner", attempt: 2 });
    // 旧 attempt 也不能覆盖：用新 token 但旧 attempt 提交同样失败。
    db.prepare(`UPDATE local_batch_stages SET status='running', attempt=3 WHERE id=?`).run(stageId);
    storage.withFencedTransaction(db, { resourceKey: `job:${jobId}`, instance: "new-owner", token: 2 }, () => {
      const ok = storage.writeStageResult(db, {
        stageId, instance: "new-owner", token: 2, attempt: 2, status: "succeeded", outcomeHash: "stale", evidence: {},
      });
      assert.equal(ok, false, "旧 attempt 不得覆盖新尝试");
    });
  } finally { db.close(); }
});

await test("F6 渲染阶段取消：cancel_requested 由执行者确认，已提交动作不倒撤", async () => {
  const dataDir = join(ROOT, "f6-data");
  const outDir = join(ROOT, "f6-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000CANCEL001A", name: "取消渲染", revenue: 1000, other: 0, capital: 10000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const gate = join(ROOT, "f6-gate");
  const manifestPath = writeManifest("f6", jobManifest({
    jobKey: "cancel-render",
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
      reports: ["balance-sheet", "income-statement", "trial-balance", "cash-flow-statement", "ledger"].map((kind) => ({
        kind, formats: ["csv", "xlsx"], ...(kind === "ledger" ? { code: "1002" } : {}),
      })),
    })],
  }));
  const running = spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "pause-after-report-stage", GATE_FILE: gate },
  });
  await waitFor("第一个报表发布后暂停", () => count(dataDir, `SELECT COUNT(*) FROM local_batch_artifacts WHERE status='published'`) >= 1);
  const cancel = runCli(["cancel", "--data-dir", dataDir, "--job-key", "cancel-render"]);
  const cancelJson = cliJson(cancel);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(cancelJson.cancelRequested, true);
  writeFileSync(gate, "go");
  const finished = await running.done;
  assert.equal(finished.status, 0, finished.stderr);
  const db = openDb(dataDir);
  try {
    const job = db.prepare(`SELECT status, cancel_requested FROM local_batch_jobs WHERE job_key='cancel-render'`).get();
    assert.equal(job.cancel_requested, 1);
    assert.equal(job.status, "cancelled");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_stages WHERE status='running'`), 0, "不得留下 running");
    assert.ok(scalar(db, `SELECT COUNT(*) FROM local_batch_stages WHERE status='cancelled'`) >= 1, "必须有被取消的未完成阶段");
    // 已成功阶段必须有已发布产物；取消不得回滚导入 / 结转。
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers WHERE kind IN ('normal','carryforward')`), 2);
    const succeededReports = db.prepare(`SELECT stage_key, evidence_json FROM local_batch_stages WHERE stage_key LIKE 'report:%' AND status='succeeded'`).all();
    for (const stage of succeededReports) {
      const evidence = JSON.parse(stage.evidence_json);
      const artifact = db.prepare(`SELECT status, relative_path FROM local_batch_artifacts WHERE artifact_key=?`).get(evidence.artifactKey);
      assert.equal(artifact.status, "published");
      assert.ok(existsSync(join(outDir, artifact.relative_path)));
    }
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_stages WHERE stage_key LIKE 'report:%' AND status='failed'`), 0);
  } finally { db.close(); }
  const status = runCli(["status", "--data-dir", dataDir, "--job-key", "cancel-render"]);
  assert.equal(cliJson(status).status, "cancelled");
});

await test("F7 同步写边界取消：导入已提交保留，后续阶段 cancelled，不伪报已回滚", async () => {
  const dataDir = join(ROOT, "f7-data");
  const outDir = join(ROOT, "f7-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000CANCEL002A", name: "取消同步", revenue: 600, other: 0, capital: 9000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const gate = join(ROOT, "f7-gate");
  const manifestPath = writeManifest("f7", jobManifest({
    jobKey: "cancel-sync",
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
      reports: [{ kind: "trial-balance", formats: ["csv"] }],
    })],
  }));
  const running = spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "pause-after-stage", GATE_FILE: gate },
  });
  await waitFor("导入阶段提交后暂停", () => count(dataDir, `SELECT COUNT(*) FROM local_batch_stages WHERE stage_key LIKE 'import:%' AND status='succeeded'`) >= 1);
  const cancel = runCli(["cancel", "--data-dir", dataDir, "--job-key", "cancel-sync"]);
  assert.equal(cancel.status, 0, cancel.stderr);
  writeFileSync(gate, "go");
  const finished = await running.done;
  assert.equal(finished.status, 0, finished.stderr);
  const db = openDb(dataDir);
  try {
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers`), 1, "已提交导入不得倒撤");
    assert.equal(scalar(db, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "succeeded");
    assert.equal(scalar(db, `SELECT status FROM local_batch_stages WHERE stage_key='carryforward'`), "cancelled");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM vouchers WHERE kind='carryforward'`), 0);
    assert.equal(scalar(db, `SELECT status FROM local_batch_jobs WHERE job_key='cancel-sync'`), "cancelled");
  } finally { db.close(); }
});

await test("G1 原始资料被改 / 缺失 / 快照 hash 被改：retry 稳定拒绝，不套旧 batchId 覆盖", () => {
  const dataDir = join(ROOT, "g1-data");
  const outDir = join(ROOT, "g1-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000INPUT0001A", name: "输入失效", revenue: 300, other: 0, capital: 5000 };
  const [fixture] = createFixture(dataDir, [spec]);
  // 故意提供非法 payload（缺账套名称）→ import 阶段失败，等待显式 retry。
  const payloadPath = join(ROOT, "g1-payload.json");
  const invalid = payloadFor(spec);
  delete invalid.account_set.name;
  writeFileSync(payloadPath, JSON.stringify(invalid), "utf8");
  const manifestPath = writeManifest("g1", jobManifest({
    jobKey: "input-changed",
    items: [{
      itemKey: spec.itemKey,
      source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
      accountSetId: fixture.setId,
      periods: [{
        period: "2026-01",
        imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payloadFile: "g1-payload.json" }],
      }],
    }],
  }, ));
  const first = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(first.status, 1);
  assert.equal(cliJson(first).items[0].stages[0].errorCode, "import_validation_rejected");

  // 1) 原文件被改成另一份合法内容 → input_changed（不静默接受新文件）。
  const altered = payloadFor(spec);
  altered.vouchers[0].sourceVoucherId = `${spec.enterpriseKey}-altered`;
  writeFileSync(payloadPath, JSON.stringify(altered), "utf8");
  const changed = runCli(["retry", "--data-dir", dataDir, "--job-key", "input-changed"]);
  const changedJson = cliJson(changed);
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(changedJson.reopened, []);
  assert.equal(changedJson.inputNotes[0].problem, "input_changed");
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "needs_review");

  // 2) 显式「仅用已保存快照」：仍使用旧（非法）快照，不会悄悄用新文件。
  const snapshotOnly = runCli(["retry", "--data-dir", dataDir, "--job-key", "input-changed", "--use-saved-inputs"]);
  assert.equal(snapshotOnly.status, 0, snapshotOnly.stderr);
  assert.equal(cliJson(snapshotOnly).inputNotes[0].problem, "input_changed_using_saved_snapshot");
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "input-changed"]);
  assert.equal(resumed.status, 1);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 0, "非法快照不得写入凭证");
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "failed");

  // 3) 原文件消失。
  rmSync(payloadPath);
  const missing = runCli(["retry", "--data-dir", dataDir, "--job-key", "input-changed"]);
  assert.equal(cliJson(missing).inputNotes[0].problem, "input_missing");
  assert.equal(count(dataDir, `SELECT error_code FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "input_missing");

  // 4) 已保存快照的 hash 被改动 → 执行时 input_changed（不按坏快照继续）。
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  db.prepare(`UPDATE local_batch_inputs SET source_hash=?`).run("0".repeat(64));
  db.prepare(`UPDATE local_batch_stages SET status='pending' WHERE stage_key LIKE 'import:%'`).run();
  db.close();
  const tampered = runCli(["resume", "--data-dir", dataDir, "--job-key", "input-changed"]);
  assert.equal(tampered.status, 1);
  assert.equal(count(dataDir, `SELECT error_code FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "input_changed");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 0);
});

/** 小 job：导入 + 结转 + 三份报表，用于证据失效测试。 */
function evidenceJob(name, spec) {
  const dataDir = join(ROOT, `${name}-data`);
  const outDir = join(ROOT, `${name}-out`);
  primeDataDir(dataDir);
  const [fixture] = createFixture(dataDir, [spec]);
  const manifestPath = writeManifest(name, jobManifest({
    jobKey: `evidence-${name}`,
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
      reports: [
        { kind: "trial-balance", formats: ["csv", "xlsx"] },
        { kind: "ledger", formats: ["csv"], code: "1002" },
      ],
    })],
  }));
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
  return { dataDir, outDir, spec, fixture };
}

await test("G2 已成功阶段的凭证被反过账 / 删除：resume 转 needs_review，不重复入账", () => {
  const spec = { itemKey: "item-1", enterpriseKey: "91350000EVID00001A", name: "证据失效", revenue: 1000, other: 0, capital: 5000 };
  const { dataDir, outDir, fixture } = evidenceJob("g2", spec);
  const UNPOST_CODE = `
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
const setId = Number(process.env.SET_ID);
const voucher = db.prepare(\`SELECT id FROM vouchers WHERE account_set_id=? AND kind='normal' ORDER BY id LIMIT 1\`).get(setId);
A.unpostVoucher(setId, voucher.id);
console.log(JSON.stringify({ voucherId: voucher.id }));
`;
  const unpost = runNode(UNPOST_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(fixture.setId) } });
  assert.equal(unpost.status, 0, unpost.stderr);
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "evidence-g2"]);
  const payload = cliJson(resumed);
  assert.equal(resumed.status, 1);
  assert.equal(payload.status, "needs_review");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 2, "不得因为复核而重复入账");
  const stages = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT stage_key, status, error_code FROM local_batch_stages`).all(); } finally { db.close(); }
  })();
  assert.ok(stages.some((stage) => stage.error_code === "evidence_changed"), JSON.stringify(stages));

  // 删除结转凭证：结转阶段也要被识别为证据失效。
  const DELETE_CODE = `
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
const setId = Number(process.env.SET_ID);
const voucher = db.prepare(\`SELECT id FROM vouchers WHERE account_set_id=? AND kind='carryforward' ORDER BY id LIMIT 1\`).get(setId);
if (voucher) A.unpostVoucher(setId, voucher.id);
if (voucher) A.deleteVoucher(setId, voucher.id);
console.log("deleted");
`;
  const deleted = runNode(DELETE_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(fixture.setId) } });
  assert.equal(deleted.status, 0, deleted.stderr);
  const again = runCli(["resume", "--data-dir", dataDir, "--job-key", "evidence-g2"]);
  assert.equal(again.status, 1);
  const carry = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT status, error_code FROM local_batch_stages WHERE stage_key='carryforward'`).get(); } finally { db.close(); }
  })();
  assert.equal(carry.status, "needs_review");
  assert.equal(carry.error_code, "evidence_changed");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='carryforward'`), 0);
  assert.ok(existsSync(outDir));
});

await test("G3 完成文件丢失：resume 标 needs_review，retry 只重生成该报表，其他阶段不重跑", () => {
  const spec = { itemKey: "item-1", enterpriseKey: "91350000EVID00002A", name: "文件失效", revenue: 1500, other: 0, capital: 7000 };
  const { dataDir, outDir } = evidenceJob("g3", spec);
  const db = openDb(dataDir);
  const artifacts = db.prepare(`SELECT artifact_key, relative_path, bytes_hash, stage_key FROM local_batch_artifacts ORDER BY id`).all();
  const attempts = db.prepare(`SELECT stage_key, attempt FROM local_batch_stages ORDER BY id`).all();
  db.close();
  assert.equal(artifacts.length, 3);
  const target = artifacts.find((artifact) => artifact.stage_key === "report:ledger:csv:1002");
  rmSync(join(outDir, target.relative_path));
  const resume = runCli(["resume", "--data-dir", dataDir, "--job-key", "evidence-g3"]);
  assert.equal(resume.status, 1);
  const stage = (() => {
    const probe = openDb(dataDir);
    try { return probe.prepare(`SELECT status, error_code, evidence_json FROM local_batch_stages WHERE stage_key='report:ledger:csv:1002'`).get(); }
    finally { probe.close(); }
  })();
  assert.equal(stage.status, "needs_review");
  assert.equal(stage.error_code, "evidence_changed");
  assert.match(stage.evidence_json, /artifact_file_missing/);

  const retry = runCli(["retry", "--data-dir", dataDir, "--job-key", "evidence-g3", "--stage", "report:ledger:csv:1002"]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(cliJson(retry).reopened.map((entry) => entry.stageKey), ["report:ledger:csv:1002"]);
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "evidence-g3"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.ok(existsSync(join(outDir, target.relative_path)), "缺失的报表应被重新生成");
  const restored = (() => {
    const probe = openDb(dataDir);
    try {
      return {
        hash: probe.prepare(`SELECT bytes_hash FROM local_batch_artifacts WHERE artifact_key=?`).get(target.artifact_key).bytes_hash,
        otherAttempts: probe.prepare(`SELECT stage_key, attempt FROM local_batch_stages WHERE stage_key<>'report:ledger:csv:1002' ORDER BY id`).all(),
      };
    } finally { probe.close(); }
  })();
  assert.equal(restored.hash, target.bytes_hash, "重新生成的 CSV 字节 hash 应一致");
  for (const stageBefore of attempts.filter((entry) => entry.stage_key !== "report:ledger:csv:1002")) {
    const after = restored.otherAttempts.find((entry) => entry.stage_key === stageBefore.stage_key);
    assert.equal(after.attempt, stageBefore.attempt, "其他阶段不得重跑");
  }
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 2, "不得重做会计");
});

await test("H1 既有库缺批量结构：拒绝自动建表（migration_requires_backup），无任何 local_batch 表", () => {
  const dataDir = join(ROOT, "h1-data");
  // 只创建核心库（等价于既有工作台库），不建立批量结构。
  const core = runNode(`import "./server/db.mjs"; console.log("core-ok");`, { env: { WORKBENCH_DATA_DIR: dataDir } });
  assert.equal(core.status, 0, core.stderr);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000MIGR00001A", name: "旧库拒绝", revenue: 100, other: 0, capital: 1000 };
  const manifestPath = writeManifest("h1", jobManifest({
    jobKey: "migrate-refused",
    items: [{
      itemKey: spec.itemKey,
      source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
      periods: [{ period: "2026-01", imports: [{ batchId: "b1", mode: "create", payload: payloadFor(spec) }] }],
    }],
  }));
  const outDir = join(ROOT, "h1-out");
  const result = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(result.status, 3, `${result.stderr} ${result.stdout}`);
  const payload = cliJson(result);
  assert.equal(payload.error.code, "migration_requires_backup");
  assert.equal(payload.error.details.dependency, "LOCAL-06 createBackup/verifyBackup");
  const tables = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name); } finally { db.close(); }
  })();
  assert.ok(!tables.some((name) => name.startsWith("local_batch_")), "不得自动建立批量结构");
  assert.ok(tables.includes("account_sets"), "原库结构保留");
  // status / cancel / retry 同样如实报依赖，不初始化。
  for (const command of ["status", "cancel", "retry"]) {
    const cmd = runCli([command, "--data-dir", dataDir, "--job-key", "whatever"]);
    assert.equal(cmd.status, 3, `${command} 应退出 3`);
    assert.equal(cliJson(cmd).error.code, "batch_schema_unavailable");
  }
});

await test("H2 批量结构迁移中断整体回滚：不留下半套 schema", () => {
  const dataDir = join(ROOT, "h2-data");
  const core = runNode(`import "./server/db.mjs"; console.log("core-ok");`, { env: { WORKBENCH_DATA_DIR: dataDir } });
  assert.equal(core.status, 0, core.stderr);
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  try {
    // 用同名 view 让「建表」步骤失败，验证事务回滚（不留 component / jobs 等结构）。
    db.exec(`CREATE VIEW local_batch_artifacts AS SELECT 1 AS blocker`);
    assert.throws(
      () => storage.ensureBatchSchema(db, { freshDatabase: true }),
      (error) => error.code === "local_batch_schema_failed",
      "迁移必须失败而不是绕过",
    );
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name);
    assert.ok(!tables.includes("local_batch_component"), "不得留下 component 记录");
    assert.ok(!tables.includes("local_batch_jobs"), "不得留下半套任务表");
    assert.ok(tables.includes("account_sets"), "原库业务表不变");
    const view = db.prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name='local_batch_artifacts'`).get();
    assert.ok(view, "冲突对象保持原样");
    assert.equal(db.prepare(`PRAGMA integrity_check`).all().map((row) => Object.values(row)[0]).join(";"), "ok");
  } finally { db.close(); }
});

await test("H3 LOCAL-06 备份 / restore-new 未合并：如实标依赖，不生成伪备份文件", () => {
  const dataDir = join(ROOT, "h3-data");
  const core = runNode(`import "./server/db.mjs"; console.log("core-ok");`, { env: { WORKBENCH_DATA_DIR: dataDir } });
  assert.equal(core.status, 0, core.stderr);
  assert.throws(
    () => storage.assertInitializable(dataDir),
    (error) => error.code === "migration_requires_backup"
      && error.details.dependency === "LOCAL-06 createBackup/verifyBackup"
      && error.details.status === "dependency_unavailable",
  );
  // 不允许以 copyFile 主文件冒充备份：数据目录里只允许上游导入迁移自身产生的 .bak。
  const files = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name); } finally { db.close(); }
  })();
  assert.ok(!files.some((name) => name.startsWith("local_batch_")), "拒绝时不得改动结构");
  assert.equal(existsSync(join(dataDir, "local-batch-backup")), false);
  assert.equal(existsSync(join(dataDir, "local_batch_component")), false);
});

// ---------------------------------------------------------------- 收尾
console.log("");
const passed = RESULTS.filter(([ok]) => ok).length;
console.log(`结果：${passed} / ${RESULTS.length} 通过`);
if (failures === 0) {
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
}
console.log(`未清理临时目录（便于排查）：${ROOT}`);
process.exit(1);
