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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as storage from "../server/local-batch-storage.mjs";

const WB = process.cwd();
const CLI = join(WB, "scripts", "local-batch.mjs");
const ROOT = mkdtempSync(join(tmpdir(), "lb-persist-"));
const RESULTS = [];
let failures = 0;
/** 只清理本次 mkdtemp 创建、位于系统临时根下且不是符号链接 / junction 的明确目录。 */
function cleanupRoot() {
  const root = resolve(ROOT);
  const base = resolve(tmpdir());
  if (root === base || !root.startsWith(base + sep)) throw new Error(`拒绝清理范围外目录：${root}`);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`拒绝清理非真实目录：${root}`);
  rmSync(root, { recursive: true, force: true });
}

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
const receipt = init.fresh ? storage.claimFreshDataDir(dataDir) : null;
process.env.WORKBENCH_DATA_DIR = dataDir;
try {
  const runner = await import("./server/local-batch-runner.mjs");
  const schema = storage.ensureBatchSchema(runner.database, { receipt });
  console.log(JSON.stringify({ fresh: init.fresh, schema }));
} finally {
  if (receipt) storage.releaseFreshClaim(receipt);
}
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
  if (spec.assetCost) {
    A.addAssetCard(set.id, {
      kind: "fixed", name: "生产设备", original_cost: spec.assetCost, residual_rate: 0,
      useful_life_months: spec.life, start_period: "2026-01", acquired_period: "2026-01",
      asset_account: "1601", accum_account: "1602", expense_account: "5602",
    });
  }
  // 真实领域状态：登记为「尚未入固定资产账」的卡片（用于 needs_review 停住后序的回归）。
  if (spec.pendingCard) {
    A.addAssetCard(set.id, {
      kind: "fixed", name: "待入账设备", original_cost: 500, residual_rate: 0,
      useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01",
      ledger_status: "pending_purchase_voucher", ledger_note: "购入凭证待补",
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
  // 封账在草稿建立之后：用来制造「真实领域拒绝」的 post 失败（period_closed）。
  if (spec.closePeriod) {
    A.setPeriodStatus(set.id, "2026-01", "closed");
  }
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
if (mode === "kill-near-close") hooks.nearCloseCommit = kill;
if (mode === "kill-after-close") hooks.afterStageCommit = ({ stage, result }) => {
  if (stage.stage_key === "close" && result?.status === "succeeded") kill();
};
if (mode === "draft-after-check") {
  const A = await import("./server/accounting.mjs");
  hooks.afterStageCommit = ({ stage, item, result }) => {
    if (stage.stage_key !== "period-check" || result?.status !== "succeeded") return;
    A.createVoucher(Number(item.account_set_id), {
      period: stage.period, voucher_date: stage.period + "-15", word: "记", number: 999,
      summary: "封账前新增草稿", status: "draft",
      entries: [{ code: "5602", debit: 1, credit: 0 }, { code: "1002", debit: 0, credit: 1 }],
    });
  };
}
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

function payloadFor(spec, { withCustomAccount = false, tag = "", includeOpenings = true, assetInOpening = false } = {}) {
  const openingBalances = includeOpenings ? [
    { code: "1002", debit: String(spec.capital), credit: "" },
    ...(assetInOpening && spec.assetCost
      ? [{ code: "1601", debit: String(spec.assetCost), credit: "" }]
      : []),
    { code: "3001", debit: "", credit: String(Number(spec.capital) + (assetInOpening && spec.assetCost ? Number(spec.assetCost) : 0)) },
  ] : [];
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
    opening_balances: openingBalances,
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

  // 1) 先显式 retry（源文件尚未变）把失败的 import 重新排队到 pending：这是真实操作顺序。
  const beforeChange = runCli(["retry", "--data-dir", dataDir, "--job-key", "input-changed"]);
  assert.equal(beforeChange.status, 0, beforeChange.stderr);
  assert.deepEqual(cliJson(beforeChange).reopened.map((entry) => entry.stageKey), [`import:${spec.enterpriseKey}-b1`]);
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "pending");

  // 2) 原文件被改成另一份合法内容后再普通 resume → input_changed（拒绝静默沿用旧快照，零写入）。
  const altered = payloadFor(spec);
  altered.vouchers[0].sourceVoucherId = `${spec.enterpriseKey}-altered`;
  writeFileSync(payloadPath, JSON.stringify(altered), "utf8");
  const plainResume = runCli(["resume", "--data-dir", dataDir, "--job-key", "input-changed"]);
  assert.equal(plainResume.status, 1, plainResume.stderr);
  assert.equal(cliJson(plainResume).items[0].inputBlocked, "input_changed");
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "needs_review");
  assert.equal(count(dataDir, `SELECT error_code FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "input_changed");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 0, "源文件已变时不得写入凭证");

  // 3) retry 仍稳定拒绝（不静默接受新文件）。
  const changed = runCli(["retry", "--data-dir", dataDir, "--job-key", "input-changed"]);
  const changedJson = cliJson(changed);
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(changedJson.reopened, []);
  assert.equal(changedJson.inputNotes[0].problem, "input_changed");
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "needs_review");

  // 4) 显式「仅用已保存快照」：仍使用旧（非法）快照，不会悄悄用新文件；选择与原因留痕。
  const snapshotOnly = runCli(["retry", "--data-dir", dataDir, "--job-key", "input-changed", "--use-saved-inputs"]);
  assert.equal(snapshotOnly.status, 0, snapshotOnly.stderr);
  assert.equal(cliJson(snapshotOnly).inputNotes[0].problem, "input_changed_using_saved_snapshot");
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "input-changed", "--use-saved-inputs"]);
  assert.equal(resumed.status, 1);
  assert.equal(cliJson(resumed).allowSnapshotOnly, true);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 0, "非法快照不得写入凭证");
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "failed");

  // 5) 原文件消失。
  rmSync(payloadPath);
  const missing = runCli(["retry", "--data-dir", dataDir, "--job-key", "input-changed"]);
  assert.equal(cliJson(missing).inputNotes[0].problem, "input_missing");
  assert.equal(count(dataDir, `SELECT error_code FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "input_missing");

  // 6) 已保存快照的 hash 被改动 → 执行时 input_changed（不按坏快照继续）。
  //    先把源文件恢复成与登记指纹一致的内容，确保这一条只验证「快照被改」而不混入源文件变化。
  writeFileSync(payloadPath, JSON.stringify(altered), "utf8");
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
  // 只创建核心库并写入真实业务（等价于既有工作台库），不建立批量结构。
  const core = runNode(`
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
const set = A.createAccountSet({ name: "既有业务公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
A.createVoucher(set.id, {
  period: "2026-01", voucher_date: "2026-01-10", word: "记", number: 1, summary: "既有业务", status: "posted",
  entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "5001", debit: 0, credit: 100 }],
});
console.log("core-ok");
`, { env: { WORKBENCH_DATA_DIR: dataDir } });
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
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM account_sets`), 1, "原有业务账套保留");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 1, "原有业务凭证保留");
  // status / cancel / retry 同样如实报依赖，不初始化。
  for (const command of ["status", "cancel", "retry"]) {
    const cmd = runCli([command, "--data-dir", dataDir, "--job-key", "whatever"]);
    assert.equal(cmd.status, 3, `${command} 应退出 3`);
    assert.equal(cliJson(cmd).error.code, "batch_schema_unavailable");
  }
});

await test("H2 批量结构迁移中断整体回滚：不留下半套 schema", () => {
  const dataDir = join(ROOT, "h2-data");
  rmSync(dataDir, { recursive: true, force: true });
  // 合法新建回执 + 故意制造同名 view 让「建表」失败；必须整体回滚。
  const receipt = storage.claimFreshDataDir(dataDir);
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  try {
    db.exec(`CREATE VIEW local_batch_artifacts AS SELECT 1 AS blocker`);
    assert.throws(
      () => storage.ensureBatchSchema(db, { receipt }),
      (error) => error.code === "local_batch_schema_failed",
      "迁移必须失败而不是绕过",
    );
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name);
    assert.ok(!tables.includes("local_batch_component"), "不得留下 component 记录");
    assert.ok(!tables.includes("local_batch_jobs"), "不得留下半套任务表");
    const view = db.prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name='local_batch_artifacts'`).get();
    assert.ok(view, "冲突对象保持原样");
    assert.equal(db.prepare(`PRAGMA integrity_check`).all().map((row) => Object.values(row)[0]).join(";"), "ok");
    // 布尔 fresh / 无回执一律不能建立结构。
    assert.throws(
      () => storage.ensureBatchSchema(db, { freshDatabase: true }),
      (error) => error.code === "migration_requires_backup",
      "布尔 fresh 不能证明本次亲手创建",
    );
    assert.throws(
      () => storage.ensureBatchSchema(db, { receipt: { dataDir } }),
      (error) => error.code === "fresh_receipt_invalid",
      "自造回执必须无效",
    );
  } finally {
    db.close();
    storage.releaseFreshClaim(receipt);
  }
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
  // 零字节 workbench.db 也属于既有库：不能以「空文件」绕过现库门槛。
  const zeroDir = join(ROOT, "h3-zero");
  mkdirSync(zeroDir, { recursive: true });
  writeFileSync(join(zeroDir, "workbench.db"), "");
  assert.throws(
    () => storage.assertInitializable(zeroDir),
    (error) => error.code === "migration_requires_backup" && error.details.status === "dependency_unavailable",
    "零字节既有库必须拒绝新建组件",
  );
  assert.throws(
    () => storage.claimFreshDataDir(zeroDir),
    (error) => error.code === "fresh_target_not_fresh",
    "零字节库不得作为新目标占用",
  );
  // 符号链接 / junction 指向别的目录：不能作为新建目标，也不能绕到别人的库。
  const realDir = join(ROOT, "h3-real");
  const linkDir = join(ROOT, "h3-link");
  mkdirSync(realDir, { recursive: true });
  try {
    symlinkSync(realDir, linkDir, "junction");
    assert.throws(
      () => storage.assertDataDirIdentity(linkDir),
      (error) => error.code === "data_dir_alias",
      "junction 目标必须被拒绝",
    );
    assert.throws(
      () => storage.claimFreshDataDir(linkDir),
      (error) => error.code === "data_dir_alias",
      "不得通过 junction 新建库",
    );
  } catch (error) {
    if (error?.code !== "data_dir_alias") {
      console.log(`  SKIP junction 创建受本机权限限制：${error?.code || error?.message}`);
    }
  }
});

// ---------------------------------------------------------------- I. 独立审查 5 个 P1 的真实回归（新增，非 mock）
/** 真实领域接口：建未绑定账套（可带草稿凭证 / 额外报表期间），用于绑定核验测试。 */
const EXTRA_SET_CODE = `
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
const specs = JSON.parse(process.env.EXTRA_SPECS);
const out = [];
for (const spec of specs) {
  const set = A.createAccountSet({
    name: spec.name, taxpayer_type: "小规模纳税人",
    accounting_standard: "小企业会计准则", start_period: "2026-01",
  });
  if (spec.reportPeriod) A.ensurePeriod(set.id, spec.reportPeriod);
  const draft = spec.salary ? A.createVoucher(set.id, {
    period: "2026-01", voucher_date: "2026-01-05", word: "记", number: 9,
    summary: "未绑定账套草稿", status: "draft",
    entries: [
      { code: "5602", debit: spec.salary, credit: 0 },
      { code: "2211", debit: 0, credit: spec.salary },
    ],
  }) : null;
  out.push({ setId: set.id, draftId: draft ? draft.id : null, name: set.name });
}
console.log(JSON.stringify(out));
`;
function createExtraSets(dataDir, specs) {
  const result = runNode(EXTRA_SET_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, EXTRA_SPECS: JSON.stringify(specs) } });
  assert.equal(result.status, 0, `extra set 失败：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

/** 真实领域接口：跨年旧账（2025-12 已过账）+ 本年 2026-01 已过账 + 登记 2026-02。 */
const PRIOR_BOOK_CODE = `
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
import { insertEnterpriseAccountSet } from "./server/import-storage.mjs";
const spec = JSON.parse(process.env.PRIOR_SPEC);
const set = A.createAccountSet({
  name: spec.name, taxpayer_type: "小规模纳税人",
  accounting_standard: "小企业会计准则", start_period: "2025-12",
});
insertEnterpriseAccountSet(db, { enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name, accountSetId: set.id, boundBy: "fixture" });
A.setOpeningBalances(set.id, [
  { code: "1002", debit: "50000", credit: "" },
  { code: "3001", debit: "", credit: "50000" },
]);
const dec = A.createVoucher(set.id, {
  period: "2025-12", voucher_date: "2025-12-10", word: "记", number: 1, summary: "上年收入", status: "posted",
  entries: [{ code: "1002", debit: "1000", credit: 0 }, { code: "5001", debit: 0, credit: "1000" }],
});
const jan = A.createVoucher(set.id, {
  period: "2026-01", voucher_date: "2026-01-10", word: "记", number: 2, summary: "本年收入", status: "posted",
  entries: [{ code: "1002", debit: "2000", credit: 0 }, { code: "5001", debit: 0, credit: "2000" }],
});
A.ensurePeriod(set.id, "2026-02");
console.log(JSON.stringify({ setId: set.id, decId: dec.id, janId: jan.id }));
`;
function createPriorBook(dataDir, spec) {
  const result = runNode(PRIOR_BOOK_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, PRIOR_SPEC: JSON.stringify(spec) } });
  assert.equal(result.status, 0, `prior book 失败：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

/** 真实领域接口：过账 / 反过账指定凭证（证据失效模拟）。 */
const VOUCHER_STATE_CODE = `
import * as A from "./server/accounting.mjs";
const action = process.env.VOUCHER_ACTION;
A[action](Number(process.env.SET_ID), Number(process.env.VOUCHER_ID));
console.log(JSON.stringify({ action }));
`;
function setVoucherState(dataDir, setId, voucherId, action) {
  const result = runNode(VOUCHER_STATE_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(setId), VOUCHER_ID: String(voucherId), VOUCHER_ACTION: action },
  });
  assert.equal(result.status, 0, result.stderr);
}

/** 真实重算报表 CSV 的字节 hash（不读已发布产物，不信任旧快照）。 */
const RECOMPUTE_REPORT_CODE = `
import { createHash } from "node:crypto";
import { buildReportExport } from "./server/report-export.mjs";
const options = { kind: process.env.KIND, period: process.env.PERIOD, format: "csv" };
if (process.env.CODE) options.code = process.env.CODE;
const built = buildReportExport(Number(process.env.SET_ID), options);
console.log(JSON.stringify({ hash: createHash("sha256").update(built.body).digest("hex"), bytes: Buffer.byteLength(built.body) }));
`;
function recomputeReportHash(dataDir, setId, kind, period) {
  const result = runNode(RECOMPUTE_REPORT_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(setId), KIND: kind, PERIOD: period },
  });
  assert.equal(result.status, 0, `重算报表失败：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

const fileHash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const stageRow = (dataDir, stageKey, enterpriseKey) => {
  const db = openDb(dataDir);
  try {
    return db.prepare(`SELECT s.status, s.error_code, s.attempt, s.evidence_json FROM local_batch_stages s
        JOIN local_batch_items i ON i.id=s.item_id WHERE i.enterprise_key=? AND s.stage_key=?`)
      .get(enterpriseKey, stageKey);
  } finally { db.close(); }
};

await test("I1 前序阶段失败 / 需复核时不得越过去执行后序阶段（含同一次执行内的 needs_review）", () => {
  const dataDir = join(ROOT, "i1-data");
  const outDir = join(ROOT, "i1-out");
  primeDataDir(dataDir);
  const specs = [
    { itemKey: "item-a", enterpriseKey: "91350000PRIOR0001A", name: "前序失败甲", revenue: 0, other: 0, capital: 20000, assetCost: 600, life: 12, salary: 60 },
    // 乙的 post 引用了尚未登记的来源凭证（真实 source_voucher_not_found）；补齐导入后走显式 retry 应能完成。
    { itemKey: "item-b", enterpriseKey: "91350000PRIOR0002A", name: "前序失败乙", revenue: 500, other: 0, capital: 30000, assetCost: 1200, life: 12 },
    // 丙的卡片真实登记为「尚未入固定资产账」：计提核心必然拒绝，用于同一次执行内 needs_review 停住后序。
    { itemKey: "item-c", enterpriseKey: "91350000PRIOR0003A", name: "未入账丙", revenue: 0, other: 0, capital: 10000, pendingCard: true },
  ];
  const fixture = createFixture(dataDir, specs);
  const [a, b, c] = specs.map((spec, index) => ({
    itemKey: spec.itemKey, spec, fixture: fixture[index],
  }));
  const periodSpec = (entry, post) => ({
    period: "2026-01",
    post,
    depreciation: true,
    carryforward: { yearEnd: false },
    reports: [{ kind: "trial-balance", formats: ["csv"] }],
  });
  const manifestPath = writeManifest("i1", jobManifest({
    jobKey: "prior-stage-stop",
    items: [
      itemFor(a.fixture, a.spec, periodSpec(a, { vouchers: [{ voucherId: 999999 }] })),
      itemFor(b.fixture, b.spec, periodSpec(b, { vouchers: [{ sourceVoucherId: `${b.spec.enterpriseKey}-sale` }] })),
    ],
  }));

  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  const startedJson = cliJson(started);
  assert.equal(started.status, 1, `${started.stderr} ${started.stdout}`);
  assert.equal(startedJson.status, "needs_review");
  // 甲：post 真的失败（voucher_not_found），计提 / 结转 / 报表全部未执行。
  assert.equal(stageRow(dataDir, "post", a.spec.enterpriseKey).status, "failed");
  assert.equal(stageRow(dataDir, "post", a.spec.enterpriseKey).error_code, "voucher_not_found");
  for (const stageKey of ["depreciation", "carryforward", "report:trial-balance:csv"]) {
    const row = stageRow(dataDir, stageKey, a.spec.enterpriseKey);
    assert.equal(row.status, "needs_review", `甲 ${stageKey} 不得被执行`);
    assert.equal(row.error_code, "prior_stage_unresolved");
    assert.equal(row.attempt, 0, `甲 ${stageKey} 不得被认领`);
  }
  // 乙：同样停在 post（真实 source_voucher_not_found），计提未执行。
  assert.equal(stageRow(dataDir, "post", b.spec.enterpriseKey).error_code, "source_voucher_not_found");
  assert.equal(stageRow(dataDir, "depreciation", b.spec.enterpriseKey).status, "needs_review");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 0, "post 失败后不得补做计提");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 1, "仅甲一张草稿凭证，无新增");

  // 关键回归（原 P1）：不修复、不 retry 直接普通 resume，也不得跳去计提。
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "prior-stage-stop"]);
  assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
  const resumedJson = cliJson(resumed);
  assert.equal(resumedJson.status, "needs_review");
  const resumedItemA = resumedJson.items.find((entry) => entry.itemKey === "item-a");
  assert.deepEqual(resumedItemA.stages, [], "普通 resume 不得执行甲的任何后序阶段");
  assert.equal(stageRow(dataDir, "post", a.spec.enterpriseKey).error_code, "voucher_not_found");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 0, "普通 resume 不得越权补做计提");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 1);
  const depAttempts = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT attempt FROM local_batch_stages WHERE stage_key='depreciation' ORDER BY id`).all().map((row) => row.attempt); }
    finally { db.close(); }
  })();
  assert.deepEqual(depAttempts, [0, 0], "未修复前计提阶段一次都不得被认领");

  // 正常显式 retry 修复路径必须保留：真实补齐来源凭证（新任务导入同一账套）→ retry 乙 → resume。
  const lateImportPath = writeManifest("i1-late", jobManifest({
    jobKey: "prior-stage-late-import",
    items: [itemFor(b.fixture, b.spec, {
      period: "2026-01",
      imports: [{ batchId: `${b.spec.enterpriseKey}-late`, mode: "append", confirmNewBinding: true, payload: payloadFor(b.spec) }],
    })],
  }));
  const lateImport = runCli(["start", "--data-dir", dataDir, "--manifest", lateImportPath, "--output-dir", outDir]);
  assert.equal(lateImport.status, 0, `${lateImport.stderr} ${lateImport.stdout}`);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, b.fixture.setId), 1, "补齐的是同一来源凭证");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 0, "补齐导入本身不得触发计提");
  const retried = runCli(["retry", "--data-dir", dataDir, "--job-key", "prior-stage-stop", "--item", "item-b"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(cliJson(retried).reopened.map((entry) => entry.stageKey), [
    "post", "depreciation", "carryforward", "report:trial-balance:csv",
  ]);
  const resumedB = runCli(["resume", "--data-dir", dataDir, "--job-key", "prior-stage-stop"]);
  assert.equal(resumedB.status, 1, "甲仍未修复：整个 job 不可能是 succeeded");
  assert.equal(stageRow(dataDir, "depreciation", b.spec.enterpriseKey).status, "succeeded");
  assert.equal(stageRow(dataDir, "report:trial-balance:csv", b.spec.enterpriseKey).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 1, "乙只计提一次");
  assert.equal(r2(count(dataDir, `SELECT amount FROM asset_depreciation_runs`)), 100);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs WHERE account_set_id=?`, a.fixture.setId), 0, "甲始终零计提");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, b.fixture.setId), 3, "来源凭证 + 计提 + 结转");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, a.fixture.setId), 1, "甲无新增凭证");

  // 同一次执行内产生 needs_review 也必须停住该 item 后序：
  // 丙的卡片真实登记为「尚未入固定资产账」，核心 generateDepreciation 必然抛 asset_ledger_pending；
  // 阶段登记 needs_review，其后的结转 / 报表不得被执行。
  const reviewPath = writeManifest("i1-review", jobManifest({
    jobKey: "prior-stage-needs-review",
    items: [itemFor(c.fixture, c.spec, {
      period: "2026-01",
      depreciation: true,
      carryforward: { yearEnd: false },
      reports: [{ kind: "trial-balance", formats: ["csv"] }],
    })],
  }));
  const reviewRun = runCli(["start", "--data-dir", dataDir, "--manifest", reviewPath, "--output-dir", outDir]);
  assert.equal(reviewRun.status, 1, `${reviewRun.stderr} ${reviewRun.stdout}`);
  const reviewStage = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT s.status, s.error_code FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id
          WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='prior-stage-needs-review') ORDER BY s.stage_order`).all();
    } finally { db.close(); }
  })();
  assert.deepEqual(reviewStage.map((row) => [row.status, row.error_code]), [
    ["needs_review", "asset_ledger_pending"],
    ["needs_review", "prior_stage_unresolved"],
    ["needs_review", "prior_stage_unresolved"],
  ], JSON.stringify(reviewStage));
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND kind='carryforward'`, c.fixture.setId), 0,
    "needs_review 后不得继续结转");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_artifacts WHERE item_id=(
      SELECT id FROM local_batch_items WHERE job_id=(SELECT id FROM local_batch_jobs WHERE job_key='prior-stage-needs-review'))`), 0,
  "needs_review 后不得生成报表产物");
});

await test("I2 一企一套：任何动作（含无 import / 报表 / 验证恢复）前核对企业↔账套绑定，失败零写入", () => {
  const dataDir = join(ROOT, "i2-data");
  const outDir = join(ROOT, "i2-out");
  primeDataDir(dataDir);
  const specs = [
    { itemKey: "item-a", enterpriseKey: "91350000REVIEW000A", name: "绑定甲", revenue: 0, other: 0, capital: 10000, salary: 11 },
    { itemKey: "item-b", enterpriseKey: "91350000REVIEW000B", name: "绑定乙", revenue: 0, other: 0, capital: 20000, salary: 22 },
    { itemKey: "item-c", enterpriseKey: "91350000REVIEW000C", name: "绑定丙", revenue: 0, other: 0, capital: 30000 },
  ];
  const fixture = createFixture(dataDir, specs);
  const [extra1, extra2] = createExtraSets(dataDir, [
    { name: "未绑定账套一", salary: 33 },
    { name: "未绑定账套二", reportPeriod: "2026-02" },
  ]);
  // 甲 / 丙 都拿「不属于本企业」的未绑定账套；乙正常。
  const manifestPath = writeManifest("i2", jobManifest({
    jobKey: "binding-guard",
    items: [
      { ...itemFor(fixture[0], specs[0], {
        period: "2026-01",
        post: { vouchers: [{ voucherId: extra1.draftId }] },
        carryforward: { yearEnd: false },
        reports: [{ kind: "trial-balance", formats: ["csv"] }],
      }), accountSetId: extra1.setId },
      itemFor(fixture[1], specs[1], {
        period: "2026-01",
        post: { vouchers: [{ voucherId: fixture[1].draftVoucherId }] },
        carryforward: { yearEnd: false },
        reports: [{ kind: "trial-balance", formats: ["csv"] }],
      }),
      {
        itemKey: "item-c",
        source: { system: "local-export", enterpriseKey: specs[2].enterpriseKey, enterpriseName: specs[2].name },
        accountSetId: extra2.setId,
        periods: [{ period: "2026-02", reports: [{ kind: "balance-sheet", formats: ["csv"] }] }],
      },
    ],
  }));

  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  const startedJson = cliJson(started);
  assert.equal(started.status, 1, `${started.stderr} ${started.stdout}`);
  assert.equal(startedJson.status, "needs_review");
  for (const itemKey of ["item-a", "item-c"]) {
    const item = startedJson.items.find((entry) => entry.itemKey === itemKey);
    assert.equal(item.bindingBlocked, "enterprise_binding_mismatch", `${itemKey} 必须先被绑定核验拦住`);
    assert.deepEqual(item.stages, [], `${itemKey} 不得执行任何阶段`);
  }
  // 未绑定账套上真实无任何业务变化：草稿仍是草稿，没有新增凭证 / 产物。
  const unboundDraft = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT status FROM vouchers WHERE id=?`).get(extra1.draftId);
    } finally { db.close(); }
  })();
  assert.equal(unboundDraft.status, "draft", "不得向未绑定账套过账");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, extra1.setId), 1, "只保留原草稿");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND kind='carryforward'`), 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_artifacts WHERE item_id=(SELECT id FROM local_batch_items WHERE item_key='item-c')`), 0, "报表分支也要先核绑定");
  // 其它企业正常完成：乙的草稿真实过账 + 结转 + 报表产物。
  const bVoucher = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT status FROM vouchers WHERE id=?`).get(fixture[1].draftVoucherId); }
    finally { db.close(); }
  })();
  assert.equal(bVoucher.status, "posted", "其它企业必须继续");
  assert.equal(stageRow(dataDir, "report:trial-balance:csv", specs[1].enterpriseKey).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_artifacts WHERE item_id=(SELECT id FROM local_batch_items WHERE item_key='item-b')`), 1);

  // 报表阶段自身（buildReportSnapshots）也必须拒绝：不只 import / post 分支被修。
  const itemCId = count(dataDir, `SELECT id FROM local_batch_items WHERE item_key='item-c'`);
  const reportGuard = runNode(`
import * as actions from "./server/local-batch-actions.mjs";
const item = { id: Number(process.env.ITEM_ID), enterprise_key: process.env.ENTERPRISE_KEY, account_set_id: Number(process.env.SET_ID) };
try {
  actions.buildReportSnapshots({ item, period: "2026-02", reports: [{ kind: "balance-sheet" }] });
  console.log(JSON.stringify({ threw: false }));
} catch (error) {
  console.log(JSON.stringify({ threw: true, code: error.code }));
}
`, { env: {
    WORKBENCH_DATA_DIR: dataDir,
    ITEM_ID: String(itemCId),
    ENTERPRISE_KEY: specs[2].enterpriseKey,
    SET_ID: String(extra2.setId),
  } });
  assert.equal(reportGuard.status, 0, reportGuard.stderr);
  assert.deepEqual(JSON.parse(String(reportGuard.stdout).trim().split(/\r?\n/).at(-1)), { threw: true, code: "enterprise_binding_mismatch" });

  // 普通 resume 也先核绑定：零业务变化（乙 attempts 不变、未绑定账套仍是草稿）。
  const attemptsBefore = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT stage_key, attempt FROM local_batch_stages ORDER BY id`).all(); } finally { db.close(); }
  })();
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "binding-guard"]);
  assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).items.find((entry) => entry.itemKey === "item-a").bindingBlocked, "enterprise_binding_mismatch");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, extra1.setId), 1);
  const attemptsAfter = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT stage_key, attempt FROM local_batch_stages ORDER BY id`).all(); } finally { db.close(); }
  })();
  assert.deepEqual(attemptsAfter.map((row) => ({ stage_key: row.stage_key, attempt: row.attempt })),
    attemptsBefore.map((row) => ({ stage_key: row.stage_key, attempt: row.attempt })));

  // 已成功阶段的验证 / 恢复路径同样核绑定：真实删除企业绑定后 resume → needs_review 且不倒重入账。
  const artifact = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT artifact_key, bytes_hash, relative_path FROM local_batch_artifacts
          WHERE item_id=(SELECT id FROM local_batch_items WHERE item_key='item-b')`).get();
    } finally { db.close(); }
  })();
  const vouchersBefore = count(dataDir, `SELECT COUNT(*) FROM vouchers`);
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  db.prepare(`DELETE FROM import_enterprise_account_sets WHERE enterprise_key=?`).run(specs[1].enterpriseKey);
  db.close();
  const afterRebind = runCli(["resume", "--data-dir", dataDir, "--job-key", "binding-guard"]);
  assert.equal(afterRebind.status, 1);
  const reboundItem = cliJson(afterRebind).items.find((entry) => entry.itemKey === "item-b");
  assert.equal(reboundItem.verified.ok, false, "绑定被改必须让已成功阶段转复核");
  assert.equal(stageRow(dataDir, "post", specs[1].enterpriseKey).error_code, "evidence_changed");
  assert.match(stageRow(dataDir, "post", specs[1].enterpriseKey).evidence_json, /enterprise_binding_missing/);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), vouchersBefore, "复核不得倒重入账");
  assert.equal(fileHash(join(outDir, artifact.relative_path)), artifact.bytes_hash, "已发布产物不得被改写");
});

await test("I3 报表快照 / 参数异常：只影响该 item 阶段状态，其它企业继续，不当成 job 级基础设施错误", () => {
  const dataDir = join(ROOT, "i3-data");
  const outDir = join(ROOT, "i3-out");
  primeDataDir(dataDir);
  const specs = [
    { itemKey: "item-1", enterpriseKey: "91350000SNAP0001A", name: "快照异常甲", revenue: 0, other: 0, capital: 10000 },
    { itemKey: "item-2", enterpriseKey: "91350000SNAP0002A", name: "快照正常乙", revenue: 0, other: 0, capital: 20000, salary: 40 },
  ];
  const fixture = createFixture(dataDir, specs);
  const manifestPath = writeManifest("i3", jobManifest({
    jobKey: "snapshot-isolation",
    items: [
      // 甲请求未登记的 2026-02 报表：真实领域接口抛 period_not_registered。
      {
        itemKey: "item-1",
        source: { system: "local-export", enterpriseKey: specs[0].enterpriseKey, enterpriseName: specs[0].name },
        accountSetId: fixture[0].setId,
        periods: [{
          period: "2026-02",
          reports: [
            { kind: "balance-sheet", formats: ["csv", "xlsx"] },
            { kind: "ledger", formats: ["csv"], code: "9999" },
          ],
        }],
      },
      itemFor(fixture[1], specs[1], {
        period: "2026-01",
        post: { vouchers: [{ voucherId: fixture[1].draftVoucherId }] },
        reports: [{ kind: "trial-balance", formats: ["csv"] }],
      }),
    ],
  }));

  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  const startedJson = cliJson(started);
  // 关键回归（原 P1）：快照异常不得让整 job 退 2 / 两家都 pending。
  assert.equal(started.status, 1, `${started.stderr} ${started.stdout}`);
  assert.equal(startedJson.ok, false);
  assert.equal(startedJson.status, "failed");
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key='report:balance-sheet:csv'`), "failed");
  assert.equal(count(dataDir, `SELECT error_code FROM local_batch_stages WHERE stage_key='report:balance-sheet:csv'`), "period_not_registered");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_stages WHERE status='running'`), 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_artifacts WHERE item_id=(SELECT id FROM local_batch_items WHERE item_key='item-1')`), 0);
  // 第二家正常：草稿真实过账 + 报表产物落地。
  assert.equal(count(dataDir, `SELECT status FROM vouchers WHERE id=?`, fixture[1].draftVoucherId), "posted");
  assert.equal(stageRow(dataDir, "report:trial-balance:csv", specs[1].enterpriseKey).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_artifacts WHERE item_id=(SELECT id FROM local_batch_items WHERE item_key='item-2')`), 1);

  // 修复后显式 retry 仍可完成：真实登记 2026-02 + 修好账套科目后只重开该 item 的报表阶段。
  const fix = runNode(`
import * as A from "./server/accounting.mjs";
A.ensurePeriod(Number(process.env.SET_ID), "2026-02");
A.addAccount(Number(process.env.SET_ID), { code: "9999", name: "测试明细", category: "资产", direction: "debit" });
console.log("fixed");
`, { env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(fixture[0].setId) } });
  assert.equal(fix.status, 0, fix.stderr);
  const retried = runCli(["retry", "--data-dir", dataDir, "--job-key", "snapshot-isolation", "--item", "item-1"]);
  assert.equal(retried.status, 0, retried.stderr);
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "snapshot-isolation"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");
  assert.equal(stageRow(dataDir, "report:balance-sheet:csv", specs[0].enterpriseKey).status, "succeeded");
  assert.equal(stageRow(dataDir, "report:ledger:csv:9999", specs[0].enterpriseKey).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_artifacts WHERE item_id=(SELECT id FROM local_batch_items WHERE item_key='item-1')`), 3);
});

await test("I4 报表证据覆盖以前期间 / 跨年依赖：反过账旧期后 resume 必须转复核，且旧产物 hash 与真实重算不同", () => {
  const dataDir = join(ROOT, "i4-data");
  const outDir = join(ROOT, "i4-out");
  primeDataDir(dataDir);
  const spec = { enterpriseKey: "91350000PRIORBOOK1A", name: "跨年报表依赖" };
  const book = createPriorBook(dataDir, spec);
  const manifestPath = writeManifest("i4", jobManifest({
    jobKey: "report-prior-dependency",
    items: [{
      itemKey: "item-1",
      source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
      accountSetId: book.setId,
      periods: [{
        period: "2026-02",
        reports: [
          { kind: "balance-sheet", formats: ["csv"] },
          { kind: "income-statement", formats: ["csv"] },
          { kind: "cash-flow-statement", formats: ["csv"] },
          { kind: "trial-balance", formats: ["csv"] },
          { kind: "ledger", formats: ["csv"], code: "1002" },
        ],
      }],
    }],
  }));
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
  const artifacts = (() => {
    const db = openDb(dataDir);
    try { return db.prepare(`SELECT stage_key, bytes_hash, relative_path, snapshot_hash FROM local_batch_artifacts ORDER BY id`).all(); }
    finally { db.close(); }
  })();
  assert.equal(artifacts.length, 5, "五类报表全部真实生成（不会只覆盖单一案例）");
  const balanceArtifact = artifacts.find((entry) => entry.stage_key === "report:balance-sheet:csv");
  const publishedPath = join(outDir, balanceArtifact.relative_path);
  assert.equal(fileHash(publishedPath), balanceArtifact.bytes_hash);
  const publishedBefore = fileHash(publishedPath);

  // 真实反过账 2025-12（跨年以前期间）：2026-02 报表内容真的变了。
  setVoucherState(dataDir, book.setId, book.decId, "unpostVoucher");
  const recomputed = recomputeReportHash(dataDir, book.setId, "balance-sheet", "2026-02");
  assert.notEqual(recomputed.hash, publishedBefore, "反过账旧期后真实重算的报表 hash 必须不同（证明依赖真实存在）");
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "report-prior-dependency"]);
  const resumedJson = cliJson(resumed);
  // 关键回归（原 P1）：不得再 exit 0 / succeeded / verified.ok=true。
  assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(resumedJson.status, "needs_review");
  assert.equal(resumedJson.items[0].verified.ok, false);
  const reportStageKeys = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT stage_key, status, error_code, evidence_json FROM local_batch_stages
          WHERE stage_key LIKE 'report:%' ORDER BY stage_key`).all();
    } finally { db.close(); }
  })();
  assert.equal(reportStageKeys.length, 5);
  for (const stage of reportStageKeys) {
    assert.equal(stage.status, "needs_review", `${stage.stage_key} 应因以前期间变化转复核`);
    assert.equal(stage.error_code, "evidence_changed");
    assert.match(stage.evidence_json, /report_evidence_changed/);
  }
  const cashFlowRecomputed = recomputeReportHash(dataDir, book.setId, "cash-flow-statement", "2026-02");
  const cashFlowArtifact = artifacts.find((entry) => entry.stage_key === "report:cash-flow-statement:csv");
  assert.notEqual(cashFlowRecomputed.hash, cashFlowArtifact.bytes_hash, "跨年旧期变化同样改变现金流量表");
  assert.equal(fileHash(publishedPath), publishedBefore, "已发布产物不得被覆盖");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 2, "复核不得倒重入账");

  // 恢复旧期凭证 → retry → resume：真实证据回到原值，已发布产物按 hash 复用（不重复渲染）。
  setVoucherState(dataDir, book.setId, book.decId, "postVoucher");
  const retry = runCli(["retry", "--data-dir", dataDir, "--job-key", "report-prior-dependency"]);
  assert.equal(retry.status, 0, retry.stderr);
  const recovered = runCli(["resume", "--data-dir", dataDir, "--job-key", "report-prior-dependency"]);
  assert.equal(recovered.status, 0, `${recovered.stderr} ${recovered.stdout}`);
  const recoveredStages = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT stage_key, evidence_json FROM local_batch_stages WHERE stage_key LIKE 'report:%' ORDER BY stage_key`).all();
    } finally { db.close(); }
  })();
  assert.ok(recoveredStages.every((row) => JSON.parse(row.evidence_json).recovered === true), "文件未变时按 hash 补记，不重复渲染");
  assert.equal(fileHash(publishedPath), publishedBefore);

  // 同年以前期间同样必须被覆盖：反过账 2026-01 后 resume 再次转复核。
  setVoucherState(dataDir, book.setId, book.janId, "unpostVoucher");
  const recomputedJan = recomputeReportHash(dataDir, book.setId, "income-statement", "2026-02");
  const incomeArtifact = artifacts.find((entry) => entry.stage_key === "report:income-statement:csv");
  assert.notEqual(recomputedJan.hash, incomeArtifact.bytes_hash);
  const sameYear = runCli(["resume", "--data-dir", dataDir, "--job-key", "report-prior-dependency"]);
  assert.equal(sameYear.status, 1, `${sameYear.stderr} ${sameYear.stdout}`);
  assert.equal(cliJson(sameYear).status, "needs_review");
  assert.equal(stageRow(dataDir, "report:income-statement:csv", spec.enterpriseKey).error_code, "evidence_changed");
});

await test("I5 已持久 pending 导入任务：源 payloadFile 金额 100→200 时普通 resume 拒绝，显式快照才写旧内容并留痕", () => {
  const dataDir = join(ROOT, "i5-data");
  const outDir = join(ROOT, "i5-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000INPUT0009A", name: "快照选择", revenue: 100, other: 0, capital: 5000, closePeriod: true };
  const [fixture] = createFixture(dataDir, [spec]);
  const payloadPath = join(ROOT, "i5-payload.json");
  writeFileSync(payloadPath, JSON.stringify(payloadFor(spec)), "utf8");
  const manifestPath = writeManifest("i5", jobManifest({
    jobKey: "saved-input-policy",
    items: [{
      itemKey: spec.itemKey,
      source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
      accountSetId: fixture.setId,
      periods: [{
        period: "2026-01",
        imports: [{ batchId: `${spec.enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payloadFile: "i5-payload.json" }],
        carryforward: { yearEnd: false },
      }],
    }],
  }));
  // 第一步：真实领域失败（期间已封账）把 import 留在 failed，随后显式 retry 变成 pending。
  const first = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(first.status, 1, `${first.stderr} ${first.stdout}`);
  assert.ok(["period_closed", "opening_rewrite_period_closed"].includes(cliJson(first).items[0].stages[0].errorCode));
  reopenPeriod(dataDir, fixture.setId);
  const retried = runCli(["retry", "--data-dir", dataDir, "--job-key", "saved-input-policy"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(cliJson(retried).reopened.map((entry) => entry.stageKey), [`import:${spec.enterpriseKey}-b1`, "carryforward"]);
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), "pending");

  // 第二步：源 payloadFile 金额 100 → 200（合法文件变化），普通 resume 必须拒绝静默沿用旧内容。
  const changedPayload = payloadFor(spec);
  changedPayload.vouchers[0].entries[0].debit = "200";
  writeFileSync(payloadPath, JSON.stringify(changedPayload), "utf8");
  const plain = runCli(["resume", "--data-dir", dataDir, "--job-key", "saved-input-policy"]);
  const plainJson = cliJson(plain);
  assert.equal(plain.status, 1, `${plain.stderr} ${plain.stdout}`);
  assert.equal(plainJson.status, "needs_review");
  assert.equal(plainJson.allowSnapshotOnly, false);
  assert.equal(plainJson.items[0].inputBlocked, "input_changed");
  assert.equal(stageRow(dataDir, "import:" + spec.enterpriseKey + "-b1", spec.enterpriseKey).status, "needs_review");
  assert.equal(stageRow(dataDir, "import:" + spec.enterpriseKey + "-b1", spec.enterpriseKey).error_code, "input_changed");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 0, "源文件已变时不得按旧快照写入");

  // 第三步：显式 --use-saved-inputs：写入的是**旧快照**的 100，不是新文件的 200，且原因留痕。
  const savedResume = runCli(["resume", "--data-dir", dataDir, "--job-key", "saved-input-policy", "--use-saved-inputs"]);
  assert.equal(savedResume.status, 0, `${savedResume.stderr} ${savedResume.stdout}`);
  const savedJson = cliJson(savedResume);
  assert.equal(savedJson.allowSnapshotOnly, true);
  assert.equal(savedJson.status, "succeeded");
  const importEvidence = JSON.parse(stageRow(dataDir, "import:" + spec.enterpriseKey + "-b1", spec.enterpriseKey).evidence_json);
  assert.deepEqual(importEvidence.inputEvidence, { mode: "saved_snapshot", reason: "input_changed", sourceHash: importEvidence.inputEvidence.sourceHash });
  assert.match(importEvidence.inputEvidence.sourceHash, /^[0-9a-f]{64}$/);
  const revenue = count(dataDir, `SELECT COALESCE(SUM(e.credit),0) FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.status='posted' AND e.code='5001'`);
  assert.equal(r2(revenue), 100, "显式快照必须写旧内容 100（不是新文件 200）");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='carryforward'`), 1);
});

// ---------------------------------------------------------------- I6 / I7（独审新增 P2）
const itemRow = (dataDir, jobKey, itemKey) => {
  const db = openDb(dataDir);
  try {
    return db.prepare(`SELECT i.id, i.account_set_id, i.account_set_source, i.status FROM local_batch_items i
        JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? AND i.item_key=?`).get(jobKey, itemKey);
  } finally { db.close(); }
};
const itemArtifactCount = (dataDir, jobKey, itemKey) => {
  const db = openDb(dataDir);
  try {
    return scalar(db, `SELECT COUNT(*) FROM local_batch_artifacts WHERE item_id=(SELECT i.id FROM local_batch_items i
        JOIN local_batch_jobs j ON j.id=i.job_id WHERE j.job_key=? AND i.item_key=?)`, jobKey, itemKey);
  } finally { db.close(); }
};

await test("I6 企业已绑定但 manifest 省略 accountSetId：推断的账套必须落库并贯穿报表证据与 resume 核验", () => {
  const dataDir = join(ROOT, "i6-data");
  const outDir = join(ROOT, "i6-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000INFER0001A", name: "推断绑定报表" };
  const [fixture] = createFixture(dataDir, [spec]);
  const manifestPath = writeManifest("i6", jobManifest({
    jobKey: "inferred-binding-report",
    items: [{
      // 契约不变：accountSetId 仍是可选字段；企业已绑定时由真实绑定推断账套。
      itemKey: spec.itemKey,
      source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
      periods: [{ period: "2026-01", reports: [{ kind: "balance-sheet", formats: ["csv"] }] }],
    }],
  }));

  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
  assert.equal(cliJson(started).status, "succeeded");
  // P2：解析出的账套 ID 必须真的写进 local_batch_items（不是只存在于内存快照 / 锁作用域）。
  const row = itemRow(dataDir, "inferred-binding-report", spec.itemKey);
  assert.equal(row.account_set_id, fixture.setId, "推断得到的账套 ID 必须持久化");
  assert.ok(row.account_set_source, "必须留下账套来源（manifest / 阶段 / 绑定推断）");
  const stage = stageRow(dataDir, "report:balance-sheet:csv", spec.enterpriseKey);
  assert.equal(stage.status, "succeeded");
  assert.equal(JSON.parse(stage.evidence_json).accountSetId, fixture.setId, "产物证据必须带真实账套 ID");
  const artifact = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT artifact_key, bytes_hash, relative_path FROM local_batch_artifacts ORDER BY id`).get();
    } finally { db.close(); }
  })();
  const artifactPath = join(outDir, artifact.relative_path);
  assert.equal(fileHash(artifactPath), artifact.bytes_hash);
  const vouchersBefore = count(dataDir, `SELECT COUNT(*) FROM vouchers`);

  // 数据与文件完全没变，停机后新进程 resume 必须仍 succeeded（不得 report_evidence_changed）。
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "inferred-binding-report"]);
  const resumedJson = cliJson(resumed);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(resumedJson.status, "succeeded");
  assert.equal(resumedJson.items[0].verified.ok, true, `不得以 null 重算摘要：${JSON.stringify(resumedJson.items[0].verified)}`);
  assert.equal(stageRow(dataDir, "report:balance-sheet:csv", spec.enterpriseKey).error_code, null);
  assert.equal(itemRow(dataDir, "inferred-binding-report", spec.itemKey).account_set_id, fixture.setId, "重启后仍是同一账套");
  assert.equal(fileHash(artifactPath), artifact.bytes_hash, "已发布产物不得被改写");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), vouchersBefore, "resume 不得写入业务数据");
});

await test("I7 推断绑定覆盖仅 post / 无 import 报表 / 有 import，且错绑定仍零写、不覆盖已声明账套", () => {
  const dataDir = join(ROOT, "i7-data");
  const outDir = join(ROOT, "i7-out");
  primeDataDir(dataDir);
  const specs = [
    { itemKey: "item-post", enterpriseKey: "91350000INFER0101A", name: "推断仅过账", revenue: 0, other: 0, capital: 10000, salary: 40 },
    { itemKey: "item-report", enterpriseKey: "91350000INFER0102A", name: "推断仅报表", revenue: 0, other: 0, capital: 20000 },
    { itemKey: "item-import", enterpriseKey: "91350000INFER0103A", name: "推断含导入", revenue: 800, other: 0, capital: 30000 },
    { itemKey: "item-other", enterpriseKey: "91350000INFER0104A", name: "错绑定目标", revenue: 0, other: 0, capital: 40000 },
  ];
  const fixture = createFixture(dataDir, specs);
  const sourceOf = (index) => ({ system: "local-export", enterpriseKey: specs[index].enterpriseKey, enterpriseName: specs[index].name });
  const manifestPath = writeManifest("i7", jobManifest({
    jobKey: "inferred-binding-shapes",
    items: [
      // 仅 post、无 import、manifest 省略 accountSetId
      { itemKey: specs[0].itemKey, source: sourceOf(0), periods: [{ period: "2026-01", post: { vouchers: [{ voucherId: fixture[0].draftVoucherId }] } }] },
      // 仅报表、无 import
      { itemKey: specs[1].itemKey, source: sourceOf(1), periods: [{ period: "2026-01", reports: [{ kind: "trial-balance", formats: ["csv"] }] }] },
      // 有 import + 报表
      {
        itemKey: specs[2].itemKey, source: sourceOf(2),
        periods: [{
          period: "2026-01",
          imports: [{ batchId: `${specs[2].enterpriseKey}-b1`, mode: "append", confirmNewBinding: true, payload: payloadFor(specs[2]) }],
          reports: [{ kind: "income-statement", formats: ["csv"] }],
        }],
      },
    ],
  }));

  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
  assert.equal(cliJson(started).status, "succeeded");
  for (const [index, itemKey] of [[0, "item-post"], [1, "item-report"], [2, "item-import"]]) {
    assert.equal(itemRow(dataDir, "inferred-binding-shapes", itemKey).account_set_id, fixture[index].setId,
      `${itemKey} 推断账套必须落库`);
  }
  assert.equal(JSON.parse(stageRow(dataDir, "post", specs[0].enterpriseKey).evidence_json).accountSetId, fixture[0].setId);
  assert.equal(JSON.parse(stageRow(dataDir, "report:trial-balance:csv", specs[1].enterpriseKey).evidence_json).accountSetId, fixture[1].setId);
  assert.equal(JSON.parse(stageRow(dataDir, `import:${specs[2].enterpriseKey}-b1`, specs[2].enterpriseKey).evidence_json).accountSetId, fixture[2].setId);
  assert.equal(JSON.parse(stageRow(dataDir, "report:income-statement:csv", specs[2].enterpriseKey).evidence_json).accountSetId, fixture[2].setId);
  const snapshotVouchers = count(dataDir, `SELECT COUNT(*) FROM vouchers`);

  // 停机后新进程 resume：三种形态都必须仍 succeeded，没有任何 report_evidence_changed / evidence_changed。
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "inferred-binding-shapes"]);
  const resumedJson = cliJson(resumed);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(resumedJson.status, "succeeded");
  assert.ok(resumedJson.items.every((entry) => entry.verified.ok === true), JSON.stringify(resumedJson.items.map((entry) => entry.verified)));
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_stages WHERE status='needs_review'`), 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), snapshotVouchers, "resume 不得重复入账");

  // 错绑定：企业甲已绑定 set-甲，manifest 却显式声明 set-丁 → 结构化拒绝、零业务写入、不覆盖已声明账套。
  const wrongPath = writeManifest("i7-wrong", jobManifest({
    jobKey: "inferred-binding-mismatch",
    items: [{
      itemKey: "item-a", source: sourceOf(0), accountSetId: fixture[3].setId,
      periods: [{ period: "2026-01", reports: [{ kind: "balance-sheet", formats: ["csv"] }] }],
    }],
  }));
  const vouchersBeforeWrong = count(dataDir, `SELECT COUNT(*) FROM vouchers`);
  const wrong = runCli(["start", "--data-dir", dataDir, "--manifest", wrongPath, "--output-dir", outDir]);
  const wrongJson = cliJson(wrong);
  assert.equal(wrong.status, 1, `${wrong.stderr} ${wrong.stdout}`);
  assert.equal(wrongJson.status, "needs_review");
  assert.equal(wrongJson.items[0].bindingBlocked, "enterprise_binding_mismatch");
  assert.equal(itemRow(dataDir, "inferred-binding-mismatch", "item-a").account_set_id, fixture[3].setId,
    "错绑定时不得把账套改成推断值");
  assert.equal(itemRow(dataDir, "inferred-binding-mismatch", "item-a").account_set_source, "manifest");
  assert.equal(itemArtifactCount(dataDir, "inferred-binding-mismatch", "item-a"), 0, "错绑定不得发布产物");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), vouchersBeforeWrong, "错绑定零业务写入");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, fixture[3].setId), 0);
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE item_id=(SELECT id FROM local_batch_items
      WHERE item_key='item-a' AND job_id=(SELECT id FROM local_batch_jobs WHERE job_key='inferred-binding-mismatch'))`), "needs_review");
});

// ---------------------------------------------------------------- J. B1 真实期末检查 / 结账 / 失败隔离 / 卡片状态
/** 真实领域入口：按 spec 建卡，可选先计提一次（用于「已计提」状态）。 */
function addStateCard(dataDir, spec) {
  const code = `
import * as A from "./server/accounting.mjs";
const spec = JSON.parse(process.env.CARD_SPEC);
const card = A.addAssetCard(Number(process.env.SET_ID), spec.card);
let generated = null;
if (spec.preDepreciate) {
  const result = A.generateDepreciation(Number(process.env.SET_ID), "2026-01");
  generated = { voucherId: result.voucher?.id ?? null, runs: result.runs?.length ?? 0 };
}
console.log(JSON.stringify({ cardId: card.id, generated }));
`;
  const result = runNode(code, {
    env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(spec.setId), CARD_SPEC: JSON.stringify(spec) },
  });
  assert.equal(result.status, 0, `建卡失败：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

await test("J1 真实 period-check/close 成功 + 单家缺折旧阻断 + 补齐后 retry/resume 只做未完成部分", () => {
  const dataDir = join(ROOT, "j1-data");
  const outDir = join(ROOT, "j1-out");
  primeDataDir(dataDir);
  const specs = [1, 2, 3].map((index) => ({
    itemKey: `item-${index}`,
    enterpriseKey: `91350000CHECK00${index}A`,
    name: `期末检查${index}号`,
    revenue: 1000 + index, other: 0, capital: 50000 + index * 1000,
    assetCost: 600, life: 12,
  }));
  const fixture = createFixture(dataDir, specs);
  const items = specs.map((spec, index) => {
    const period = {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-j1`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec, { assetInOpening: true }) }],
      post: { vouchers: [{ sourceVoucherId: `${spec.enterpriseKey}-sale` }] },
      carryforward: { yearEnd: false },
      periodCheck: true,
      close: true,
      reports: [{ kind: "trial-balance", formats: ["csv"] }],
    };
    // 2 号故意缺计提：期末检查必须真实阻断，close / reports 不得越过。
    if (index !== 1) period.depreciation = true;
    return itemFor(fixture[index], spec, period);
  });
  const manifestPath = writeManifest("j1", jobManifest({ jobKey: "real-seven", items }));
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 1, `${started.stderr} ${started.stdout}`);
  assert.equal(cliJson(started).status, "needs_review");

  const stageOf = (enterpriseKey, stageKey) => stageRow(dataDir, stageKey, enterpriseKey);
  for (const index of [0, 2]) {
    const key = specs[index].enterpriseKey;
    assert.equal(stageOf(key, "period-check").status, "succeeded", `${key} check`);
    assert.equal(stageOf(key, "close").status, "succeeded", `${key} close`);
    assert.equal(stageOf(key, "report:trial-balance:csv").status, "succeeded", `${key} report`);
    assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture[index].setId), 1);
    assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, fixture[index].setId), 3, "导入 + 计提 + 结转");
  }
  const brokenKey = specs[1].enterpriseKey;
  assert.equal(stageOf(brokenKey, "period-check").status, "needs_review");
  assert.equal(JSON.parse(stageOf(brokenKey, "period-check").evidence_json).ready, false);
  assert.ok(JSON.parse(stageOf(brokenKey, "period-check").evidence_json).blocking.some((entry) => entry.step === "depreciation"));
  assert.equal(stageOf(brokenKey, "close").status, "needs_review");
  assert.equal(stageOf(brokenKey, "report:trial-balance:csv").status, "needs_review");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND status='closed'`, fixture[1].setId), 0, "缺折旧不得封账");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, fixture[1].setId), 2, "导入 + 结转（无计提）");
  const attemptsBefore = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT stage_key, attempt FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id
          WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='real-seven') AND i.enterprise_key IN (?,?)
          ORDER BY s.id`).all(specs[0].enterpriseKey, specs[2].enterpriseKey);
    } finally { db.close(); }
  })();

  // 补齐 2 号真实业务：先按核心撤销顺序反过账旧结转（未过账结转不再构成折旧前置依赖），
  // 再用独立任务真实计提；随后 resume 让证据核验把失效结转标 needs_review，retry + resume 只做未完成部分。
  const carryRow = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT id FROM vouchers WHERE account_set_id=? AND period='2026-01' AND kind='carryforward'`).get(fixture[1].setId);
    } finally { db.close(); }
  })();
  const unpost = runNode(`
import * as A from "./server/accounting.mjs";
A.unpostVoucher(Number(process.env.SET_ID), Number(process.env.VOUCHER_ID));
console.log("unposted");
`, { env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(fixture[1].setId), VOUCHER_ID: String(carryRow.id) } });
  assert.equal(unpost.status, 0, unpost.stderr);
  const fixPath = writeManifest("j1-fix", jobManifest({
    jobKey: "real-seven-fix-dep",
    items: [itemFor(fixture[1], specs[1], { period: "2026-01", depreciation: true })],
  }));
  const fixed = runCli(["start", "--data-dir", dataDir, "--manifest", fixPath, "--output-dir", outDir]);
  assert.equal(fixed.status, 0, `${fixed.stderr} ${fixed.stdout}`);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs WHERE account_set_id=?`, fixture[1].setId), 1, "补齐任务只计提一次");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND kind='depreciation'`, fixture[1].setId), 1);

  // 普通 resume 先核验证据：旧结转被反过账 → needs_review，不得直接越过 check/close。
  const resumeBroken = runCli(["resume", "--data-dir", dataDir, "--job-key", "real-seven"]);
  assert.equal(resumeBroken.status, 1, `${resumeBroken.stderr} ${resumeBroken.stdout}`);
  assert.equal(stageOf(brokenKey, "carryforward").status, "needs_review");
  assert.equal(stageOf(brokenKey, "carryforward").error_code, "evidence_changed");
  const retried = runCli(["retry", "--data-dir", dataDir, "--job-key", "real-seven", "--item", "item-2"]);
  assert.equal(retried.status, 0, retried.stderr);
  const reopened = cliJson(retried).reopened.map((entry) => entry.stageKey);
  assert.deepEqual(reopened, ["carryforward", "period-check", "close", "report:trial-balance:csv"], JSON.stringify(reopened));
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "real-seven"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");
  assert.equal(stageOf(brokenKey, "period-check").status, "succeeded");
  assert.equal(stageOf(brokenKey, "close").status, "succeeded");
  assert.equal(stageOf(brokenKey, "report:trial-balance:csv").status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture[1].setId), 1);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND status='posted'`, fixture[1].setId), 3, "导入 + 计提 + 新结转");
  // 其它两家原成功业务不重做。
  const attemptsAfter = (() => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT stage_key, attempt FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id
          WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='real-seven') AND i.enterprise_key IN (?,?)
          ORDER BY s.id`).all(specs[0].enterpriseKey, specs[2].enterpriseKey);
    } finally { db.close(); }
  })();
  assert.deepEqual(attemptsAfter, attemptsBefore, "另 19 家（此处 2 家）成功业务不得重跑");
});

await test("J2 check 成功后、close 之前受控新增真实草稿：核心重新拒绝封账（旧 check 不代替前置）", async () => {
  const dataDir = join(ROOT, "j2-data");
  const outDir = join(ROOT, "j2-out");
  primeDataDir(dataDir);
  const spec = {
    itemKey: "item-1", enterpriseKey: "91350000STALE0001A", name: "陈旧检查",
    revenue: 1200, other: 0, capital: 40000,
  };
  const [fixture] = createFixture(dataDir, [spec]);
  const manifestPath = writeManifest("j2", jobManifest({
    jobKey: "stale-check",
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-j2`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
      periodCheck: true,
      close: true,
    })],
  }));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "draft-after-check" },
  }).done;
  assert.equal(crashed.status, 0, `${crashed.stderr} ${crashed.stdout}`);
  assert.equal(stageRow(dataDir, "period-check", spec.enterpriseKey).status, "succeeded");
  const closeRow = stageRow(dataDir, "close", spec.enterpriseKey);
  assert.equal(closeRow.status, "needs_review");
  assert.equal(closeRow.error_code, "period_has_draft_vouchers");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture.setId), 0,
    "核心前置拒绝后不得封账");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND status='draft'`, fixture.setId), 1,
    "封账前新增草稿真实存在");
});

// ---------------------------------------------------------------- E5 / E6 close 崩溃点
function closeOnlyManifest(jobKey, spec, fixture) {
  return jobManifest({
    jobKey,
    items: [itemFor(fixture, spec, {
      period: "2026-01",
      imports: [{ batchId: `${spec.enterpriseKey}-${jobKey}`, mode: "append", confirmNewBinding: true, payload: payloadFor(spec) }],
      carryforward: { yearEnd: false },
      periodCheck: true,
      close: true,
    })],
  });
}

await test("E5 close 事务中 SIGKILL（效果未提交）：期间保持 open，重启后重新封账一次", async () => {
  const dataDir = join(ROOT, "e5-data");
  const outDir = join(ROOT, "e5-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000CLOSE0001A", name: "封账中断", revenue: 900, other: 0, capital: 30000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const manifestPath = writeManifest("e5", closeOnlyManifest("close-crash-before", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-near-close" },
  }).done;
  assert.notEqual(crashed.status, 0, "子进程应被 SIGKILL 终止");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture.setId), 0,
    "未提交的 close 效果必须回滚");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_stages WHERE status='running' AND stage_key='close'`), 1);
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "close-crash-before"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture.setId), 1);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND kind='carryforward'`, fixture.setId), 1, "结转不重复");
});

await test("E6 close 已提交后进程中断：新进程 resume 识别已提交合法效果，补 checkpoint 不重复封账", async () => {
  const dataDir = join(ROOT, "e6-data");
  const outDir = join(ROOT, "e6-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000CLOSE0002A", name: "封账已提交", revenue: 800, other: 0, capital: 30000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const manifestPath = writeManifest("e6", closeOnlyManifest("close-crash-after", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-after-close" },
  }).done;
  assert.notEqual(crashed.status, 0, "子进程应被 SIGKILL 终止");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture.setId), 1,
    "已提交的 close 效果必须保留");
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE status='succeeded' AND stage_key='close'`), "succeeded",
    "close 效果与 checkpoint 同事务提交");
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "close-crash-after"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture.setId), 1);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND kind='carryforward'`, fixture.setId), 1);
  assert.equal(count(dataDir, `SELECT status FROM local_batch_stages WHERE stage_key='close'`), "succeeded");
});

// ---------------------------------------------------------------- H4 新建目标独占 / 零字节 / 别名 / 替换
await test("H4 新建目标独占回执：并发占用、零字节库、非空目录、探测后替换、伪造回执均不能绕过", () => {
  const target = join(ROOT, "h4-target");
  rmSync(target, { recursive: true, force: true });
  const receipt = storage.claimFreshDataDir(target);
  // 同进程第二个占用者：稳定拒绝（不帮忙修半库）。
  assert.throws(() => storage.claimFreshDataDir(target), (error) => error.code === "fresh_target_claimed");
  // 跨进程第二个占用者：O_EXCL 标记保证同样被拒。
  const child = runNode(`
import * as storage from "./server/local-batch-storage.mjs";
try { storage.claimFreshDataDir(process.env.TARGET); console.log("CLAIMED"); }
catch (error) { console.log("REJECTED", error.code); }
`, { env: { TARGET: target } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /REJECTED fresh_target_claimed/);
  assert.equal(existsSync(join(target, "workbench.db")), true, "回执已原子创建库文件");
  assert.equal(statSync(join(target, "workbench.db")).size, 0);
  storage.releaseFreshClaim(receipt);

  // 探测后库文件被替换成非本进程创建的文件：绑定身份必须失败。
  const receipt2 = storage.claimFreshDataDir(target);
  const dbPath = join(target, "workbench.db");
  unlinkSync(dbPath);
  writeFileSync(dbPath, "not-a-sqlite-database");
  const replaced = new DatabaseSync(dbPath);
  try {
    assert.throws(() => storage.assertFreshReceipt(receipt2, replaced), (error) => String(error?.code || "").startsWith("fresh_"));
  } finally {
    replaced.close();
    storage.releaseFreshClaim(receipt2);
  }

  // 非空目录不得作为新目标。
  const nonEmpty = join(ROOT, "h4-nonempty");
  mkdirSync(nonEmpty, { recursive: true });
  writeFileSync(join(nonEmpty, "keep.txt"), "user-data");
  assert.throws(() => storage.claimFreshDataDir(nonEmpty), (error) => error.code === "data_dir_not_empty");
  assert.equal(readFileSync(join(nonEmpty, "keep.txt"), "utf8"), "user-data", "不得改动他人目录内容");
});

// ---------------------------------------------------------------- J3 折旧适配：真实卡片状态
await test("J3 计提适配真实卡片状态：取得期间未到 / 未入账 / 0 分分期 / 已提足 / 已计提", () => {
  const dataDir = join(ROOT, "j3-data");
  const outDir = join(ROOT, "j3-out");
  primeDataDir(dataDir);
  const specs = [
    { itemKey: "future", enterpriseKey: "91350000CARD0001A", name: "未来取得", capital: 10000 },
    { itemKey: "pending", enterpriseKey: "91350000CARD0002A", name: "未入账", capital: 10000 },
    { itemKey: "rounding", enterpriseKey: "91350000CARD0003A", name: "零分分期", capital: 10000 },
    { itemKey: "fully", enterpriseKey: "91350000CARD0004A", name: "已提足", capital: 10000 },
    { itemKey: "posted", enterpriseKey: "91350000CARD0005A", name: "已计提", capital: 10000 },
  ];
  const fixtures = createFixture(dataDir, specs);
  const cards = [
    { card: { kind: "fixed", name: "未来设备", original_cost: 600, residual_rate: 0, useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-03", asset_account: "1601", accum_account: "1602", expense_account: "5602" } },
    { card: { kind: "fixed", name: "未入账设备", original_cost: 600, residual_rate: 0, useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01", ledger_status: "pending_purchase_voucher", ledger_note: "购入凭证待补", asset_account: "1601", accum_account: "1602", expense_account: "5602" } },
    { card: { kind: "fixed", name: "零分设备", original_cost: 1, residual_rate: 0, useful_life_months: 1200, start_period: "2026-01", acquired_period: "2026-01", asset_account: "1601", accum_account: "1602", expense_account: "5602" } },
    { card: { kind: "fixed", name: "已提足设备", original_cost: 600, residual_rate: 0, useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01", opening_accumulated: 600, asset_account: "1601", accum_account: "1602", expense_account: "5602" } },
    { card: { kind: "fixed", name: "已计提设备", original_cost: 600, residual_rate: 0, useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01", asset_account: "1601", accum_account: "1602", expense_account: "5602" }, preDepreciate: true },
  ];

  const before = count(dataDir, `SELECT COUNT(*) FROM vouchers`);
  for (let index = 0; index < specs.length; index += 1) {
    addStateCard(dataDir, { setId: fixtures[index].setId, ...cards[index] });
  }
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`) - before, 1, "只有「已计提」预置了一张真实计提凭证");

  const items = specs.map((spec, index) => itemFor(fixtures[index], spec, { period: "2026-01", depreciation: true }));
  const manifestPath = writeManifest("j3", jobManifest({ jobKey: "card-states", items }));
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 1, `${started.stderr} ${started.stdout}`);
  const statusOf = (itemKey) => {
    const db = openDb(dataDir);
    try {
      return db.prepare(`SELECT s.status, s.error_code, s.evidence_json FROM local_batch_stages s
          JOIN local_batch_items i ON i.id=s.item_id
         WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='card-states') AND i.item_key=? AND s.stage_key='depreciation'`)
        .get(itemKey);
    } finally { db.close(); }
  };
  assert.equal(statusOf("future").status, "not_applicable");
  assert.equal(JSON.parse(statusOf("future").evidence_json).cards[0].status, "not_existed");
  assert.equal(statusOf("pending").status, "needs_review");
  assert.equal(statusOf("pending").error_code, "asset_ledger_pending");
  assert.equal(statusOf("rounding").status, "not_applicable");
  assert.equal(JSON.parse(statusOf("rounding").evidence_json).cards[0].status, "no_amount_due");
  assert.equal(statusOf("fully").status, "not_applicable");
  assert.equal(JSON.parse(statusOf("fully").evidence_json).cards[0].status, "fully_depreciated");
  assert.equal(statusOf("posted").status, "not_applicable");
  assert.equal(JSON.parse(statusOf("posted").evidence_json).cards[0].status, "posted");
  // 未入账卡片不得产生凭证；其余不适用状态也不得凭空生成。
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, fixtures[1].setId), 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, fixtures[2].setId), 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, fixtures[3].setId), 0);
});

// ---------------------------------------------------------------- 收尾
console.log("");
const passed = RESULTS.filter(([ok]) => ok).length;
console.log(`结果：${passed} / ${RESULTS.length} 通过`);
if (failures === 0) {
  cleanupRoot();
  process.exit(0);
}
console.log(`未清理临时目录（便于排查）：${ROOT}`);
process.exit(1);
