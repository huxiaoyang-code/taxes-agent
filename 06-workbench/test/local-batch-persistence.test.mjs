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
 *     H4–H8 独占新建安全：回执不可变 / 写目标绑定真实对象 / 失败清理只认不可变事实（H6）/ 跨路径与
 *     别名在活动创建事实下必须在任何写之前拒绝（H7）/ 所有权标记只认创建时身份，同 nonce 的替换对象不误删（H8）。
 *
 * 运行：node test/local-batch-persistence.test.mjs（在 06-workbench 目录）
 * 完全合成临时数据（系统临时目录），不访问真实账套 / 凭据 / 税局。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as storage from "../server/local-batch-storage.mjs";
import * as guard from "../server/database-open-guard.mjs";

const WB = process.cwd();
const CLI = join(WB, "scripts", "local-batch.mjs");
const ROOT = mkdtempSync(join(tmpdir(), "lb-persist-"));
const RESULTS = [];
let failures = 0;
/** 只清理本次 mkdtemp 创建、位于系统临时根下且不是符号链接 / junction 的明确目录。 */
function cleanupRoot() {
  if(process.env.KEEP_FIXTURES === "1" || process.env.WORKBENCH_TEST_KEEP_FIXTURES === "1") { console.log(`保留本次合成夹具：${ROOT}`); return; }
  const root = resolve(ROOT);
  const base = resolve(tmpdir());
  if (root === base || !root.startsWith(base + sep)) throw new Error(`拒绝清理范围外目录：${root}`);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`拒绝清理非真实目录：${root}`);
  rmSync(root, { recursive: true, force: true });
}

const SELECT_CASES=process.env.BATCH_PERSIST_TEST_CASES?new Set(process.env.BATCH_PERSIST_TEST_CASES.split(',')):null;
async function test(name, fn) {
  if(SELECT_CASES&&!SELECT_CASES.has(name.split(' ')[0]))return;
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
  let observedExit;child.on("exit",(status,signal)=>observedExit={status,signal});
  const done = new Promise((resolvePromise) => {
    child.on("close", (status, signal) => {assert.deepEqual(observedExit,{status,signal});console.log("owned child actual exit+close",status,signal);resolvePromise({ status, signal, stdout, stderr });});
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
let runner;try {
  runner = await import("./server/local-batch-runner.mjs");
  const schema = storage.ensureBatchSchema(runner.database, { receipt });
  console.log(JSON.stringify({ fresh: init.fresh, schema }));
} finally {
  if (receipt) storage.releaseFreshClaim(receipt);
  runner?.database.close();
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
try{for (const spec of specs) {
  const set = A.createAccountSet({ enterprise: { enterpriseKey: spec.enterpriseKey },
    name: spec.name, taxpayer_type: "小规模纳税人",
    accounting_standard: "小企业会计准则", start_period: "2026-01",
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
console.log(JSON.stringify(out));}finally{db.close();}
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
if (mode === "kill-after-import") hooks.afterStageCommit = ({stage,result})=>{if(stage.stage_key.startsWith('import:')&&result?.status==='succeeded')kill();};
if (mode === "kill-in-import") hooks.afterImportCommit=kill;
if (mode === "kill-in-depreciation") hooks.inDepreciationTransaction = kill;
if (mode === "kill-in-carryforward") hooks.inCarryForwardTransaction = kill;
if (mode === "kill-near-close") hooks.nearCloseCommit = kill;
if (mode === "kill-after-close") hooks.afterStageCommit = ({ stage, result }) => {
  if (stage.stage_key === "close" && result?.status === "succeeded") kill();
};
if (mode === "draft-after-check") {
  const A = await import("./server/accounting.mjs");
  const awaitImportAssert=await import('node:assert');
  hooks.afterStageCommit = ({ stage, item, result }) => {
    if (stage.stage_key !== "period-check" || result?.status !== "succeeded") return;
    const {strict:assert}=awaitImportAssert; // synchronous hook: no await or public capability bypass
    const request={period:stage.period,voucher_date:stage.period+'-15',word:'记',number:999,summary:'封账前新增草稿',entries:[{code:'5602',debit:1},{code:'1002',credit:1}]};
    const before=runner.database.prepare('SELECT total_changes() n').get().n;
    assert.throws(()=>A.createVoucher(Number(item.account_set_id),request),e=>e.code==='lock_active');
    assert.equal(runner.database.prepare('SELECT total_changes() n').get().n,before,'public write refusal allocates no epoch');
    // Explicit fault injection into this synthetic DB, not domain authorization:
    // insert a real, balanced draft after the saved check, before close rereads it.
    const db=runner.database;db.exec('BEGIN IMMEDIATE');try{
      const id=Number(db.prepare("INSERT INTO vouchers(account_set_id,period,voucher_date,word,number,summary,status,created_at) VALUES(?,?,?,'记',999,?,'draft',?)").run(Number(item.account_set_id),stage.period,stage.period+'-15','封账前新增草稿',new Date().toISOString()).lastInsertRowid);
      const ins=db.prepare('INSERT INTO voucher_entries(voucher_id,line_no,code,summary,debit,credit) VALUES(?,?,?,?,?,?)');ins.run(id,1,'5602','受控故障注入',1,0);ins.run(id,2,'1002','受控故障注入',0,1);db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    console.log('public create locked; controlled real balanced draft injected');
  };
}
if (mode === "kill-after-publish") hooks.afterArtifactPublish = kill;
if (mode === "pause-after-import") hooks.afterStageCommit=({stage,result})=>{if(stage.stage_key.startsWith('import:')&&result?.status==='succeeded')pause();};
if (mode === "pause-after-report-stage") hooks.afterReportStage = pause;
if (mode === "pause-after-stage") hooks.afterStageCommit = pause;
try{const result = await runner.createAndRun({
  manifest: validated.manifest,
  manifestHash: storage.sha256(manifestJson),
  manifestJson, plans, inputs, outputDir: outDir, hooks,
});
console.log(JSON.stringify({ ok: result.finalStatus === "succeeded", status: result.finalStatus, jobId: result.jobId, renders: result.renders }));
}finally{runner.database.close();console.log('RUN_JOB_DB_ACTUAL_CLOSE');}
`;

function openDb(dataDir) {
  return new DatabaseSync(join(dataDir, "workbench.db"), { readOnly: true });
}
const scalar = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0];
const count = (dataDir, sql, ...args) => {
  const db = openDb(dataDir);
  try { return scalar(db, sql, ...args); } finally { db.close(); }
};

function assertPendingQuarantine(dataDir,jobKey,stageKey) {
 const snapshot=()=>{const db=openDb(dataDir);try{
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const mutable=['local_batch_jobs','local_batch_items','local_batch_stages','local_batch_locks','local_batch_lock_epochs'];
  const job=db.prepare('SELECT id FROM local_batch_jobs WHERE job_key=?').get(jobKey),items=db.prepare('SELECT * FROM local_batch_items WHERE job_id=? ORDER BY id').all(job.id),resources=[['job:'+job.id]];
  for(const item of items){const keys=new Set(['book:'+item.enterprise_key]);if(item.account_set_id)keys.add('account-set:'+item.account_set_id);const bound=db.prepare('SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?').get(item.enterprise_key);if(bound)keys.add('account-set:'+bound.account_set_id);resources.push([...keys]);}
  return {resources,epochs:db.prepare('SELECT * FROM local_batch_lock_epochs ORDER BY resource_key').all(),locks:db.prepare('SELECT * FROM local_batch_locks ORDER BY resource_key').all(),schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
   stage:db.prepare('SELECT s.* FROM local_batch_stages s JOIN local_batch_items i ON s.item_id=i.id JOIN local_batch_jobs j ON i.job_id=j.id WHERE j.job_key=? AND s.stage_key=?').get(jobKey,stageKey),
   pending:db.prepare("SELECT * FROM audit_operations WHERE state='pending' ORDER BY database_instance_id,operation_id,attempt").all(),
   business:JSON.stringify(tables.filter(r=>!mutable.includes(r.name)).map(({name})=>[name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(r=>JSON.stringify(r)).sort()]))};
 }finally{db.close();}};
 const before=snapshot();assert.ok(before.pending.length);const parent=storage.stageAuditOperationId(before.stage);assert.ok(before.pending.some(r=>r.operation_id===parent));
 for(const command of ['resume','retry','resume']) {
  const previous=snapshot();const args=[command,'--data-dir',dataDir,'--job-key',jobKey];
  const observed=runNode(`import {DatabaseSync} from 'node:sqlite';const original=DatabaseSync.prototype.setAuthorizer;let admissions=0;DatabaseSync.prototype.setAuthorizer=function(fn){if(fn!==null)admissions++;return original.call(this,fn);};process.once('exit',()=>{DatabaseSync.prototype.setAuthorizer=original;console.log(JSON.stringify({auditCallbackAdmissions:admissions}));});process.argv=${JSON.stringify([process.execPath,'cli'])}.concat(JSON.parse(process.env.OBSERVED_ARGS));await import(${JSON.stringify(pathToFileURL(CLI).href)});`,{env:{WORKBENCH_DATA_DIR:dataDir,OBSERVED_ARGS:JSON.stringify(args)}});
  const lines=String(observed.stdout).trim().split(/\r?\n/);const measured=JSON.parse(lines.pop());assert.equal(measured.auditCallbackAdmissions,0,'no real audited callback may be admitted for old pending');console.log('measured audit callback admissions',jobKey,command,measured.auditCallbackAdmissions);
  assert.equal(observed.status,command==='retry'?0:1,observed.stdout+observed.stderr);if(command!=='retry')assert.equal(JSON.parse(lines.pop()).status,'needs_review');
  const after=snapshot();assert.equal(after.stage.attempt,before.stage.attempt);assert.equal(after.stage.status,'needs_review');assert.deepEqual(after.schema,before.schema);const fixed=['id','item_id','period','stage_key','stage_order','input_hash','spec_json','attempt','outcome_hash','evidence_json'];assert.deepEqual(fixed.map(k=>after.stage[k]),fixed.map(k=>before.stage[k]));assert.deepEqual(after.pending,before.pending);assert.equal(after.business,before.business);
  const expected=new Map(previous.epochs.map(r=>[r.resource_key,r.last_token]));if(command==='resume')for(const resources of previous.resources)for(const key of resources)expected.set(key,(expected.get(key)??0)+1);
  assert.deepEqual(after.epochs.map(r=>({...r})),[...expected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([resource_key,last_token])=>({resource_key,last_token})),command+' exact job/book/set epoch allocation, all other epochs unchanged');
  assert.equal(after.locks.length,0,'quarantined request releases all temporary active owners');console.log('exact quarantine epochs',command,JSON.stringify(after.epochs));
 }
}

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

await test("E1 导入与 checkpoint/父子审计同 commit 后 SIGKILL：重启不重复入账、原 attempt 保持", async () => {
  const { dataDir, outDir, spec, fixture } = crashFixture("e1");
  const manifestPath = writeManifest("e1", crashManifest("import", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-after-import" },
  }).done;
  assert.notEqual(crashed.status, 0, "子进程应被 SIGKILL 终止");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM import_batches WHERE batch_id=? AND status='completed'`, `${spec.enterpriseKey}-b1`), 1, "导入已提交");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 2, "草稿凭证 + 导入凭证已提交");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM local_batch_stages WHERE status='succeeded' AND stage_key LIKE 'import:%'`),1,'checkpoint与导入同commit');
  const committed=openDb(dataDir);try{const stage=committed.prepare("SELECT * FROM local_batch_stages WHERE stage_key LIKE 'import:%'").get();const id=storage.stageAuditOperationId(stage);const rows=committed.prepare('SELECT * FROM audit_operations WHERE operation_id=? OR parent_operation_id=?').all(id,id);assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='succeeded'&&r.receipt_json));}finally{committed.close();}

  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "crash-import"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), 3, "来源凭证回放 + 草稿过账 + 结转（无重复导入）");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM import_voucher_sources`), 1, "来源登记不得重复");
  const db = openDb(dataDir);
  try {
    const stage = db.prepare(`SELECT status, attempt FROM local_batch_stages WHERE stage_key LIKE 'import:%'`).get();
    assert.equal(stage.status, "succeeded");
    assert.equal(stage.attempt, 1, "已提交checkpoint不重新执行/增attempt");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_stages WHERE status='running'`), 0);
  } finally { db.close(); }
});

await test("E1b 导入outer事务内 SIGKILL：来源/业务/checkpoint零提交、pending禁止自动重执",async()=>{
 const {dataDir,outDir,spec,fixture}=crashFixture('e1b');const manifestPath=writeManifest('e1b',crashManifest('import',spec,fixture));
 const crashed=await spawnNode(RUN_JOB_CODE,{env:{WORKBENCH_DATA_DIR:dataDir,MANIFEST_PATH:manifestPath,OUT_DIR:outDir,HOOK_MODE:'kill-in-import'}}).done;assert.notEqual(crashed.status,0);
 assert.equal(count(dataDir,'SELECT COUNT(*) FROM import_batches'),0);assert.equal(count(dataDir,'SELECT COUNT(*) FROM import_voucher_sources'),0);assert.equal(count(dataDir,'SELECT COUNT(*) FROM vouchers'),1);
 const handle=openDb(dataDir);let stage;try{stage=handle.prepare("SELECT stage_key FROM local_batch_stages WHERE stage_key LIKE 'import:%'").get().stage_key;}finally{handle.close();}assertPendingQuarantine(dataDir,'crash-import',stage);
});

await test("E2 计提事务中 SIGKILL：pending待核零重执，独立成功仅计提50一次", async () => {
  const { dataDir, outDir, spec, fixture } = crashFixture("e2");
  const manifestPath = writeManifest("e2", crashManifest("depreciation", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-in-depreciation" },
  }).done;
  assert.notEqual(crashed.status, 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 0, "事务内崩溃必须回滚计提效果");
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='depreciation'`), 0);
  assertPendingQuarantine(dataDir,'crash-depreciation','depreciation');
  const normal=crashFixture('e2-normal');const normalPath=writeManifest('e2-normal',crashManifest('depreciation',normal.spec,normal.fixture));
  const resumed=runCli(['start','--data-dir',normal.dataDir,'--manifest',normalPath,'--output-dir',normal.outDir]);assert.equal(resumed.status,0,resumed.stderr+resumed.stdout);
  assert.equal(count(normal.dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs`), 1);
  assert.equal(count(normal.dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='depreciation'`), 1);
  assert.equal(r2(count(normal.dataDir, `SELECT amount FROM asset_depreciation_runs`)), 50);
});

await test("E3 结转事务中 SIGKILL：pending待核零重执，独立成功利润1090", async () => {
  const { dataDir, outDir, spec, fixture } = crashFixture("e3");
  const manifestPath = writeManifest("e3", crashManifest("carryforward", spec, fixture));
  const crashed = await spawnNode(RUN_JOB_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, MANIFEST_PATH: manifestPath, OUT_DIR: outDir, HOOK_MODE: "kill-in-carryforward" },
  }).done;
  assert.notEqual(crashed.status, 0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='carryforward'`), 0, "结转事务必须回滚");
  assertPendingQuarantine(dataDir,'crash-carryforward','carryforward');
  const normal=crashFixture('e3-normal');const normalPath=writeManifest('e3-normal',crashManifest('carryforward',normal.spec,normal.fixture));
  const resumed=runCli(['start','--data-dir',normal.dataDir,'--manifest',normalPath,'--output-dir',normal.outDir]);assert.equal(resumed.status,0,resumed.stderr+resumed.stdout);
  assert.equal(count(normal.dataDir, `SELECT COUNT(*) FROM vouchers WHERE kind='carryforward'`), 1);
  // 收入 1200 - 工资 60 - 折旧 50 = 1090
  const profit = count(normal.dataDir, `SELECT COALESCE(SUM(e.credit),0) - COALESCE(SUM(e.debit),0) FROM voucher_entries e
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
  let finished;
  try {
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

  } finally {writeFileSync(gatePrefix,"go");finished=await running.done;}
  assert.equal(finished.status,0,finished.stderr);
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

await test("F3 租约过期但旧 owner 进程仍活：保守拒绝（owner_active），不抢锁", async () => {
  const dataDir = join(ROOT, "f3-data");
  const outDir = join(ROOT, "f3-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000ALIVE0001A", name: "存活检查", revenue: 500, other: 0, capital: 10000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore",env:{...process.env},windowsHide:true });let sleeperExit;const sleeperClosed=new Promise(resolve=>{sleeper.on("exit",(code,signal)=>sleeperExit={code,signal});sleeper.on("close",(code,signal)=>{assert.deepEqual(sleeperExit,{code,signal});console.log("sleeper exit+close "+code+"/"+signal);resolve();});});
  try {
    const db = new DatabaseSync(join(dataDir, "workbench.db"));
    try{db.exec("BEGIN IMMEDIATE");const past = new Date(Date.now() - 60000).toISOString();
    db.prepare(`INSERT INTO local_batch_locks (resource_key, owner_instance, fencing_token, pid, acquired_at, heartbeat_at, lease_expires_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`book:${spec.enterpriseKey}`, "ghost-owner", 7, sleeper.pid, past, past, past);
    const priorEpoch=db.prepare("SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?").get(`book:${spec.enterpriseKey}`)?.last_token??0;assert.ok(priorEpoch<=7);db.prepare("INSERT INTO local_batch_lock_epochs VALUES(?,7) ON CONFLICT(resource_key) DO UPDATE SET last_token=excluded.last_token").run(`book:${spec.enterpriseKey}`);
    db.exec("COMMIT");}finally{if(db.isTransaction)db.exec("ROLLBACK");db.close();}
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
    sleeper.kill();await sleeperClosed;
  }
});

await test("F4 旧 owner 已确认死亡：接管并递增 fencing token，业务完整写入", async () => {
  const dataDir = join(ROOT, "f4-data");
  const outDir = join(ROOT, "f4-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "item-1", enterpriseKey: "91350000DEAD00001A", name: "死主接管", revenue: 800, other: 0, capital: 15000 };
  const [fixture] = createFixture(dataDir, [spec]);
  const deadChild=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',env:{...process.env},windowsHide:true});const deadPid=deadChild.pid;let deadExit;const deadClosed=await new Promise(resolve=>{deadChild.on('exit',(code,signal)=>deadExit={code,signal});deadChild.on('close',(code,signal)=>resolve({code,signal}));});assert.deepEqual(deadClosed,deadExit);assert.equal(deadClosed.code,0);assert.equal(storage.isProcessAlive(deadPid),false);console.log('dead child actual exit+close '+JSON.stringify(deadClosed));
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  try{db.exec("BEGIN IMMEDIATE");const past = new Date(Date.now() - 60000).toISOString();
  db.prepare(`INSERT INTO local_batch_locks (resource_key, owner_instance, fencing_token, pid, acquired_at, heartbeat_at, lease_expires_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(`book:${spec.enterpriseKey}`, "dead-owner", 3, deadPid, past, past, past);
  const priorEpoch=db.prepare("SELECT last_token FROM local_batch_lock_epochs WHERE resource_key=?").get(`book:${spec.enterpriseKey}`)?.last_token??0;assert.ok(priorEpoch<=3);db.prepare("INSERT INTO local_batch_lock_epochs VALUES(?,3) ON CONFLICT(resource_key) DO UPDATE SET last_token=excluded.last_token").run(`book:${spec.enterpriseKey}`);
  db.exec("COMMIT");}finally{if(db.isTransaction)db.exec("ROLLBACK");db.close();}
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
    db.prepare("INSERT INTO local_batch_lock_epochs VALUES(?,1)").run(`job:${jobId}`);
    // 旧 owner 认领阶段（token=1 / attempt=1）。
    const claim = db.prepare(`UPDATE local_batch_stages SET status='running', attempt=1, owner_instance='old-owner', fencing_token=1 WHERE id=?`).run(stageId);
    assert.equal(Number(claim.changes), 1);
    // 新执行者接管：fence 递增到 2。
    db.exec("BEGIN IMMEDIATE");db.prepare(`UPDATE local_batch_locks SET owner_instance='new-owner', fencing_token=2 WHERE resource_key=?`).run(`job:${jobId}`);db.prepare("UPDATE local_batch_lock_epochs SET last_token=2 WHERE resource_key=?").run(`job:${jobId}`);db.exec("COMMIT");
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
  const tamperedHash = storage.sha256(readFileSync(join(dataDir,'workbench.db')));
  const previousError = count(dataDir, `SELECT error_code FROM local_batch_stages WHERE stage_key LIKE 'import:%'`);
  const tampered = runCli(["resume", "--data-dir", dataDir, "--job-key", "input-changed"]);
  assert.equal(tampered.status, 2);
  assert.equal(cliJson(tampered).error.code, 'batch_schema_invalid', '严格保存内容校验早于runner源文件读取');
  assert.equal(storage.sha256(readFileSync(join(dataDir,'workbench.db'))),tamperedHash,'篡改后的原库逐字节不变');
  assert.equal(count(dataDir, `SELECT error_code FROM local_batch_stages WHERE stage_key LIKE 'import:%'`), previousError);
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
const set = A.createAccountSet({ enterprise: { enterpriseKey: "SYNTHETIC-local-batch-persistence-2" }, name: "既有业务公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" });
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
      (error) => error.code === "batch_schema_invalid",
      "冲突对象必须在严格预检早拒，不得绕过",
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
      (error) => error.code === "batch_schema_invalid",
      "布尔 fresh 不能豁免已存在冲突对象的严格校验",
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
  const set = A.createAccountSet({ enterprise: { enterpriseKey: "SYNTHETIC-EXTRA-" + out.length },
    name: spec.name, taxpayer_type: "小规模纳税人",
    accounting_standard: "小企业会计准则", start_period: "2026-01",
  });
  db.prepare("DELETE FROM import_enterprise_account_sets WHERE account_set_id=?").run(set.id);
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
const set = A.createAccountSet({ enterprise: { enterpriseKey: spec.enterpriseKey },
  name: spec.name, taxpayer_type: "小规模纳税人",
  accounting_standard: "小企业会计准则", start_period: "2025-12",
});
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

await test("E5 close 事务中 SIGKILL（效果未提交）：期间保持open，pending待核零重执", async () => {
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
  assertPendingQuarantine(dataDir,'close-crash-before','close');
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND period='2026-01' AND status='closed'`, fixture.setId),0);
  assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND kind='carryforward'`, fixture.setId),1,'结转不重复');
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
  const claimedDb = join(target, "workbench.db");
  assert.equal(existsSync(claimedDb), true, "回执已原子创建库文件");
  // claim 完成时库文件已经是「经真实 SQLite 验证的页 1 种子」（不再拿零字节 / 路径相同当所有权证据）：
  // 4096 字节空库 + application_id 魔数 + 本进程随机 nonce；没有任何 schema 对象。
  const seed = guard.describeFreshClaim(receipt);
  assert.equal(statSync(claimedDb).size, 4096, "claim 必须用创建 fd 写入页 1 种子");
  const seedProbe = new DatabaseSync(claimedDb, { readOnly: true });
  try {
    assert.equal(Number(seedProbe.prepare(`PRAGMA application_id`).get().application_id), guard.CLAIM_APPLICATION_ID);
    assert.equal(Number(seedProbe.prepare(`PRAGMA user_version`).get().user_version), seed.nonce);
    assert.equal(Number(seedProbe.prepare(`PRAGMA page_count`).get().page_count), 1);
    assert.equal(Number(seedProbe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get().n), 0);
  } finally { seedProbe.close(); }
  storage.releaseFreshClaim(receipt);

  // 探测后库文件被替换成非本进程创建的文件：绑定身份必须失败，且不得删改外部文件。
  assert.equal(existsSync(claimedDb),true,"释放回执保留空种子供诊断，不自动清空");
  const replacementTarget=join(ROOT,"h4-replacement-target");
  const receipt2 = storage.claimFreshDataDir(replacementTarget);
  const dbPath = join(replacementTarget, "workbench.db");
  unlinkSync(dbPath);
  const foreignText = "not-a-sqlite-database";
  writeFileSync(dbPath, foreignText);
  const replaced = new DatabaseSync(dbPath);
  try {
    assert.throws(() => storage.assertFreshReceipt(receipt2, replaced), (error) => String(error?.code || "").startsWith("fresh_"));
  } finally {
    replaced.close();
    storage.releaseFreshClaim(receipt2);
  }
  assert.equal(readFileSync(dbPath, "utf8"), foreignText, "失败清理不得删除 / 改写被替换的外部文件");

  // 非空目录不得作为新目标。
  const nonEmpty = join(ROOT, "h4-nonempty");
  mkdirSync(nonEmpty, { recursive: true });
  writeFileSync(join(nonEmpty, "keep.txt"), "user-data");
  assert.throws(() => storage.claimFreshDataDir(nonEmpty), (error) => error.code === "data_dir_not_empty");
  assert.equal(readFileSync(join(nonEmpty, "keep.txt"), "utf8"), "user-data", "不得改动他人目录内容");
});

// ---------------------------------------------------------------- H5 独占新建：写目标绑定真实对象
/**
 * 真实负例（子进程，与 CLI `start` 相同的加载顺序）：claim 之后把库文件换成
 *   外部零字节文件 / 真实外部旧库 / 同路径同对象就地改写 / 整个删掉，
 * 再真实 import `db.mjs`（初始化钩子）——必须在任何核心 DDL / WAL 之前拒绝。
 * 同时用字节 hash + dev/ino + 真实 SQLite schema/行数断言外部对象完全没被写入。
 */
const CLAIM_ATTACK_CODE = `
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as storage from "./server/local-batch-storage.mjs";
const dataDir = process.env.WORKBENCH_DATA_DIR;
const mode = process.env.ATTACK_MODE;
const dbPath = dataDir + "/workbench.db";
const markerPath = dataDir + "/.local-batch-create";
const fingerprint = () => {
  try {
    const stat = fs.statSync(dbPath);
    const bytes = fs.readFileSync(dbPath);
    return {
      exists: true, size: stat.size, dev: String(stat.dev), ino: String(stat.ino),
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch { return { exists: false }; }
};
const token = storage.claimFreshDataDir(dataDir);
const facts = (await import("./server/database-open-guard.mjs")).describeFreshClaim(token);
const seeded = fingerprint();
if (mode === "zero-byte") {
  fs.unlinkSync(dbPath);
  fs.writeFileSync(dbPath, "");
} else if (mode === "foreign-db") {
  fs.unlinkSync(dbPath);
  fs.copyFileSync(process.env.FOREIGN_DB, dbPath);
} else if (mode === "in-place-foreign") {
  fs.writeFileSync(dbPath, fs.readFileSync(process.env.FOREIGN_DB));
} else if (mode === "in-place-garbage") {
  fs.writeFileSync(dbPath, "not-a-sqlite-database");
} else if (mode === "missing") {
  fs.unlinkSync(dbPath);
}
const before = fingerprint();
let errorCode = null;
let opened = false;
try { await import("./server/db.mjs"); opened = true; }
catch (error) { errorCode = (error && error.code) ? error.code : "import_failed"; }
const after = fingerprint();
const wal = fs.existsSync(dbPath + "-wal");
const shm = fs.existsSync(dbPath + "-shm");
const released = storage.releaseFreshClaim(token);
console.log(JSON.stringify({
  mode, nonce: facts.nonce, seeded, before, after, errorCode, opened, wal, shm, released,
  markerAfter: fs.existsSync(markerPath),
}));
`;
function runClaimAttack(dataDir, mode, foreignDb = null) {
  const result = runNode(CLAIM_ATTACK_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, ATTACK_MODE: mode, ...(foreignDb ? { FOREIGN_DB: foreignDb } : {}) },
  });
  assert.equal(result.status, 0, `${mode} 子进程应正常结束：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

await test("H5 独占新建写目标绑定真实对象：外部零字节 / 外部旧库 / 同对象就地改写 / 缺文件 均零写入拒绝", () => {
  // 真实外部旧库（带同名核心表与数据），用真实 SQLite 生成。
  const foreignSource = join(ROOT, "h5-foreign-source.db");
  rmSync(foreignSource, { force: true });
  const foreign = new DatabaseSync(foreignSource);
  try {
    foreign.exec(`CREATE TABLE account_sets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE vouchers (id INTEGER PRIMARY KEY, summary TEXT);
      INSERT INTO account_sets (id, name) VALUES (1, '外部旧库');
      INSERT INTO vouchers (id, summary) VALUES (1, '外部凭证');`);
  } finally { foreign.close(); }
  const foreignHash = fileHash(foreignSource);

  // 1) 单次替换成外部零字节文件：身份不同 → 拒绝；外部文件仍 0 字节、同一 dev/ino、无 WAL / -shm。
  const zeroDir = join(ROOT, "h5-zero");
  const zero = runClaimAttack(zeroDir, "zero-byte");
  assert.equal(zero.errorCode, "fresh_database_replaced", JSON.stringify(zero));
  assert.equal(zero.opened, false, "初始化钩子必须先拒绝，不能完成 DDL");
  assert.equal(zero.seeded.size, 4096, "claim 时已用创建 fd 写入页 1 种子");
  assert.equal(zero.before.exists, true);
  assert.equal(zero.before.size, 0, "被换入的外部文件是零字节");
  assert.deepEqual(zero.after, zero.before, "初始化钩子不得向外部零字节文件写入任何字节 / 不得替换对象");
  assert.equal(zero.wal, false, "不得持久设置 WAL");
  assert.equal(zero.shm, false);
  assert.equal(zero.markerAfter, false, "失败清理只删除本进程标记");
  assert.equal(statSync(join(zeroDir, "workbench.db")).size, 0, "外部零字节文件保留在现场");

  // 2) 单次替换成外部非空旧库：拒绝；字节 hash / 表 / 行数完全不变。
  const foreignDir = join(ROOT, "h5-foreign");
  const foreignRun = runClaimAttack(foreignDir, "foreign-db", foreignSource);
  assert.equal(foreignRun.errorCode, "fresh_database_replaced", JSON.stringify(foreignRun));
  assert.equal(foreignRun.opened, false);
  assert.equal(foreignRun.before.hash, foreignHash);
  assert.deepEqual(foreignRun.after, foreignRun.before, "外部旧库字节不得被改写");
  assert.equal(foreignRun.wal, false);
  assert.equal(foreignRun.shm, false);
  assert.equal(fileHash(join(foreignDir, "workbench.db")), foreignHash, "外部旧库仍是原始字节");
  const foreignProbe = new DatabaseSync(join(foreignDir, "workbench.db"), { readOnly: true });
  try {
    assert.deepEqual(foreignProbe.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((row) => row.name),
      ["account_sets", "vouchers"], "外部库没有多出任何表");
    assert.equal(Number(foreignProbe.prepare(`SELECT COUNT(*) AS n FROM vouchers`).get().n), 1);
  } finally { foreignProbe.close(); }

  // 3) 同路径 + 同文件对象（dev/ino 未变）被就地改写为外部库：路径与身份检查都会通过，
  //    只有「连接页 1 的 nonce」能拒绝；拒绝前不得写入任何字节。
  const inPlaceDir = join(ROOT, "h5-inplace");
  const inPlace = runClaimAttack(inPlaceDir, "in-place-foreign", foreignSource);
  assert.equal(inPlace.errorCode, "fresh_database_foreign_content", JSON.stringify(inPlace));
  assert.equal(inPlace.opened, false);
  assert.equal(inPlace.before.dev, inPlace.seeded.dev);
  assert.equal(inPlace.before.ino, inPlace.seeded.ino, "仍是同一个文件对象（dev/ino 未变）");
  assert.equal(inPlace.after.hash, foreignHash, "拒绝前后外部内容字节完全一致");
  assert.deepEqual(inPlace.after, inPlace.before);
  assert.equal(inPlace.wal, false);
  assert.equal(inPlace.shm, false);
  const inPlaceProbe = new DatabaseSync(join(inPlaceDir, "workbench.db"), { readOnly: true });
  try {
    assert.deepEqual(inPlaceProbe.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((row) => row.name),
      ["account_sets", "vouchers"], "外部库逻辑 schema 不变（没有先建表再拒绝）");
    assert.equal(Number(inPlaceProbe.prepare(`SELECT COUNT(*) AS n FROM vouchers`).get().n), 1);
    assert.equal(Number(inPlaceProbe.prepare(`PRAGMA user_version`).get().user_version), 0, "仍是外部库自己的 user_version");
  } finally { inPlaceProbe.close(); }

  // 3b) 同路径 / 同文件对象被就地改写成**非 SQLite** 内容：仍必须在 DDL 前拒绝（不允许把原生死错误当成功）。
  const garbageDir = join(ROOT, "h5-garbage");
  const garbage = runClaimAttack(garbageDir, "in-place-garbage");
  assert.equal(garbage.errorCode, "fresh_database_foreign_content", JSON.stringify(garbage));
  assert.equal(garbage.opened, false);
  assert.equal(garbage.before.dev, garbage.seeded.dev);
  assert.equal(garbage.before.ino, garbage.seeded.ino, "仍是同一个文件对象（dev/ino 未变）");
  assert.deepEqual(garbage.after, garbage.before, "拒绝前后字节完全一致");
  assert.equal(garbage.wal, false);
  assert.equal(readFileSync(join(garbageDir, "workbench.db"), "utf8"), "not-a-sqlite-database");

  // 4) 目标文件被整个删掉：钩子拒绝。（node:sqlite 打开时自身可能补出 0 字节文件——
  //    断言它仍是 0 字节、无 schema、无 WAL，即没有任何核心结构被建立。）
  const missingDir = join(ROOT, "h5-missing");
  const missing = runClaimAttack(missingDir, "missing");
  assert.equal(missing.errorCode, "fresh_database_replaced", JSON.stringify(missing));
  assert.equal(missing.opened, false);
  if (missing.after.exists) {
    assert.equal(missing.after.size, 0, "不得写入任何字节");
    const missingProbe = new DatabaseSync(join(missingDir, "workbench.db"), { readOnly: true });
    try { assert.equal(Number(missingProbe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get().n), 0); }
    finally { missingProbe.close(); }
  }
  assert.equal(missing.wal, false);

  // 5) 正常路径（无替换）：钩子通过、页 1 nonce 保留、核心表建立；随后无回执的普通业务入口照常打开。
  const okDir = join(ROOT, "h5-ok");
  const okRun = runClaimAttack(okDir, "ours");
  assert.equal(okRun.errorCode, null, JSON.stringify(okRun));
  assert.equal(okRun.opened, true);
  assert.deepEqual(okRun.before, okRun.seeded, "正常路径下 claim 种子在初始化前未被改动");
  assert.equal(existsSync(join(okDir, "workbench.db")), true, "结构已建立，release 不删除库文件");
  assert.equal(okRun.markerAfter, false);
  const normal = runNode(`
import { db } from "./server/db.mjs";
const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
const uv = Number(db.prepare("PRAGMA user_version").get().user_version);
const hasBatch = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='local_batch_jobs'").get().n;
const batch=(await import('./server/local-batch-storage.mjs')).assertBatchSchema(db);console.log(JSON.stringify({tables,uv,hasBatch,batchVersion:batch.version,batchTables:batch.present}));db.close();console.log('H5_NORMAL_DB_ACTUAL_CLOSE');
`, { env: { WORKBENCH_DATA_DIR: okDir } });
  assert.equal(normal.status, 0, normal.stderr);
  const normalInfo = JSON.parse(String(normal.stdout).trim().split(/\r?\n/).find(line=>line.startsWith('{')));
  assert.ok(normalInfo.tables >= 10, "普通业务入口照常打开核心库");
  assert.equal(normalInfo.uv, okRun.nonce, "页 1 nonce 保留在本次创建的库里");
  assert.equal(normalInfo.hasBatch,1,'normal default db installs current official batch readiness');assert.equal(normalInfo.batchVersion,3);assert.deepEqual(normalInfo.batchTables,storage.LOCAL_BATCH_TABLES);assert.equal(normalInfo.batchTables.length,12);

  // 6) 回执不可变：改字段 / 嵌套改值 / 复制 / 伪造 / 删字段都不能改变授权目标；
  //    失败清理必须保留被替换的外部对象。
  const receiptDir = join(ROOT, "h5-receipt");
  const token = storage.claimFreshDataDir(receiptDir);
  const facts = guard.describeFreshClaim(token);
  const receiptDb = join(receiptDir, "workbench.db");
  const receiptMarker = join(receiptDir, ".local-batch-create");
  token.identity = null;
  token.identity = { dev: "0", ino: "0" };
  token.dbPath = join(ROOT, "h5-elsewhere.db");
  token.markerPath = join(ROOT, "h5-elsewhere-marker");
  token.dataDir = ROOT;
  delete token.identity;
  token.nonce = 1;
  const receiptConn = new DatabaseSync(receiptDb, { readOnly: true });
  try {
    const bound = storage.assertFreshReceipt(token, receiptConn);
    assert.equal(String(bound.dev), facts.identity.dev, "绑定仍指向内部不可变事实");
    assert.equal(String(bound.ino), facts.identity.ino);
  } finally { receiptConn.close(); }
  assert.equal(storage.releaseFreshClaim({ ...token }), false, "复制 / 伪造的回执无效");
  assert.equal(storage.releaseFreshClaim({}), false);
  assert.equal(existsSync(receiptMarker), true);
  assert.equal(existsSync(receiptDb), true);
  unlinkSync(receiptDb);
  writeFileSync(receiptDb, "");
  assert.equal(storage.releaseFreshClaim(token), true, "真回执仍可释放本进程标记");
  assert.equal(existsSync(receiptMarker), false);
  assert.equal(existsSync(receiptDb), true, "失败清理必须保留被替换的外部零字节文件");
  assert.equal(statSync(receiptDb).size, 0);
  assert.equal(storage.releaseFreshClaim(token), false, "重复 release 是无副作用 no-op");
});

// ---------------------------------------------------------------- H6 独占新建失败清理：只按不可变创建事实
/**
 * 故障注入（子进程 + 打补丁 Node 内置 `node:fs` + `syncBuiltinESMExports`，必须在 import 存储层之前完成）：
 *  - `fstat-eio-zero` / `fstat-eio-foreign`：O_EXCL 创建库文件之后、**创建句柄** `fstat` 失败之前，把路径换成
 *    外部零字节文件 / 真实合成旧库，然后让创建句柄的 `fstat` 真实抛 EIO。
 *    清理不得删除外部对象（必须保留其字节与存在性）。
 *  - `registration-mismatch`：guard 登记时的第二次对**库创建句柄**的 `fstat` 返回被篡改身份 → 登记失败
 *    （拿不到 token）；同时可把所有权标记换成别的内容 / 同 nonce 的新对象，失败清理不得删这个被替换的标记。
 *  - `open-eexist` / `open-eacces`：库文件 O_EXCL 打开失败（同进程也能先把标记换成外部内容）。
 * 故障只落在指定 fd 上（存储层也会对标记创建句柄 `fstat`），不按全局调用序号猜测。
 * 每种失败都不掩盖原始异常（返回稳定错误码），并真实核对残留对象的字节 / hash；
 * 另加资源定向断言：子进程捕获**标记 O_EXCL 创建 fd**，claim 失败后再 `fstat` 必须 `EBADF`（自有标记与
 * 被替换标记两种收尾都不得泄漏句柄）。
 */
const CLAIM_FAILURE_CODE = `
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
const mode = process.env.FAULT_MODE;
const dataDir = process.env.TARGET;
const dbPath = dataDir + "/workbench.db";
const markerPath = dataDir + "/.local-batch-create";
const FOREIGN_MARKER = JSON.stringify({ nonce: 987654321, pid: 1, at: "外部替换的标记内容", note: "not-ours" });
const realFstat = fs.fstatSync;
const realOpen = fs.openSync;
// Windows 下 join 与手写 "/" 的路径字符串不完全相等；按分隔符归一再比较。
const normalize = (value) => String(value).split(String.fromCharCode(92)).join("/").toLowerCase();
const isDbPath = (value) => typeof value === "string" && normalize(value).endsWith("/workbench.db");
const isMarkerPath = (value) => typeof value === "string" && normalize(value).endsWith("/.local-batch-create");
// 标记替换形态：foreign（不同 nonce 的外部内容）/ same-bytes（同一 nonce、字节完全相同的新文件对象）/
// same-nonce-extra（同一 nonce 但追加了外部字段）。nonce 不是秘密，后两种也只能靠创建时身份识别。
const markerKind = () => (process.env.REPLACE_MARKER === "1" ? "foreign" : (process.env.REPLACE_MARKER || null));
const replaceMarker = (kind) => {
  if (kind === "same-bytes") {
    const bytes = fs.readFileSync(markerPath);
    fs.unlinkSync(markerPath);
    fs.writeFileSync(markerPath, bytes);
  } else if (kind === "same-nonce-extra") {
    const current = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    fs.unlinkSync(markerPath);
    fs.writeFileSync(markerPath, JSON.stringify({ ...current, note: "external-extension" }));
  } else {
    fs.writeFileSync(markerPath, FOREIGN_MARKER);
  }
};
const replaceDb = (kind) => {
  if (kind === "zero") { fs.unlinkSync(dbPath); fs.writeFileSync(dbPath, ""); }
  else { fs.unlinkSync(dbPath); fs.copyFileSync(process.env.FOREIGN_DB, dbPath); }
};
// 故障只落在**指定 fd** 上（存储层现在也会 fstat 标记创建句柄），不再按全局调用序号猜测。
const fds = { db: null, marker: null };
const fstatCalls = { db: 0, marker: 0 };
let eioFired = false;
fs.openSync = (path, flags, ...rest) => {
  if ((mode === "open-eexist" || mode === "open-eacces") && isDbPath(path)) {
    const kind = markerKind();
    if (kind) replaceMarker(kind);
    const error = new Error("injected open failure");
    error.code = mode === "open-eexist" ? "EEXIST" : "EACCES";
    throw error;
  }
  const fd = realOpen(path, flags, ...rest);
  if (isDbPath(path)) fds.db = fd;
  else if (isMarkerPath(path)) fds.marker = fd;
  return fd;
};
if (mode === "fstat-eio-zero" || mode === "fstat-eio-foreign") {
  fs.fstatSync = (fd, ...rest) => {
    if (fd === fds.db) {
      if (!eioFired) {
        eioFired = true;
        replaceDb(mode === "fstat-eio-zero" ? "zero" : "foreign");
        const error = new Error("injected fstat EIO");
        error.code = "EIO";
        throw error;
      }
      fstatCalls.db += 1;
    } else if (fd === fds.marker) {
      fstatCalls.marker += 1;
    }
    return realFstat(fd, ...rest);
  };
} else if (mode === "registration-mismatch") {
  fs.fstatSync = (fd, ...rest) => {
    const real = realFstat(fd, ...rest);
    if (fd !== fds.db) {
      if (fd === fds.marker) fstatCalls.marker += 1;
      return real;
    }
    fstatCalls.db += 1;
    // 第 1 次是存储层对创建句柄的 fstat（返回真实身份），第 2 次是 guard 登记时的复核点。
    if (fstatCalls.db !== 2) return real;
    const kind = markerKind();
    if (kind) replaceMarker(kind);
    // 保留 Stats 原型（方法在原型上，展开字面量会丢 isFile / isDirectory），只篡改 ino。
    const tampered = Object.assign(Object.create(Object.getPrototypeOf(real)), real);
    tampered.ino = Number(real.ino) + 1;
    return tampered;
  };
}
syncBuiltinESMExports();
const storage = await import("./server/local-batch-storage.mjs");
const fingerprint = (path) => {
  try {
    const stat = fs.statSync(path);
    const bytes = fs.readFileSync(path);
    return {
      exists: true, size: stat.size, dev: String(stat.dev), ino: String(stat.ino),
      hash: createHash("sha256").update(bytes).digest("hex"),
      text: bytes.length <= 200 ? bytes.toString("utf8") : null,
    };
  } catch { return { exists: false }; }
};
let errorCode = null;
let details = null;
try { storage.claimFreshDataDir(dataDir); } catch (error) { errorCode = error.code; details = error.details || null; }
// 定向资源断言：O_EXCL 创建标记时捕获的创建 fd，在 claim 失败后必须已经被关闭（fstat → EBADF）。
// 无论标记是否被本进程删除（自有标记 / 被替换标记），fd 都不能泄漏。
let markerFdAfterFailure = "not-created";
if (fds.marker !== null) {
  try { fs.fstatSync(fds.marker); markerFdAfterFailure = "still-open"; }
  catch (error) { markerFdAfterFailure = error?.code || String(error); }
}
console.log(JSON.stringify({
  mode, errorCode, details, fstatCalls, markerFdAfterFailure,
  db: fingerprint(dbPath), marker: fingerprint(markerPath),
  wal: fs.existsSync(dbPath + "-wal"), shm: fs.existsSync(dbPath + "-shm"),
}));
`;
function runClaimFailure(dataDir, mode, { foreignDb = null, replaceMarker = null } = {}) {
  // replaceMarker：null | true / "foreign" | "same-bytes" | "same-nonce-extra"
  const markerKind = replaceMarker === true ? "foreign" : replaceMarker;
  const result = runNode(CLAIM_FAILURE_CODE, {
    env: {
      TARGET: dataDir, FAULT_MODE: mode,
      ...(foreignDb ? { FOREIGN_DB: foreignDb } : {}),
      ...(markerKind ? { REPLACE_MARKER: markerKind } : {}),
    },
  });
  assert.equal(result.status, 0, `${mode} 子进程应正常结束（不掩盖原始异常）：${result.stderr}`);
  const parsed = JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
  assert.equal(parsed.markerFdAfterFailure, "EBADF",
    `${mode}：标记创建 fd 在失败清理后必须已关闭（fstat 应为 EBADF），实际 ${parsed.markerFdAfterFailure}`);
  return parsed;
}

await test("H6 独占新建失败清理只认不可变事实：fstat 失败 / 标记被换 / 登记失败 不误删外部对象", () => {
  // 真实外部旧库（含同名核心表与数据），用于「合成旧库替换」负例。
  const foreignSource = join(ROOT, "h6-foreign-source.db");
  rmSync(foreignSource, { force: true });
  const foreign = new DatabaseSync(foreignSource);
  try {
    foreign.exec(`CREATE TABLE account_sets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO account_sets (id, name) VALUES (1, '外部旧库'), (2, '第二家');`);
  } finally { foreign.close(); }
  const foreignHash = fileHash(foreignSource);

  // 1) fstat 真实抛 EIO + 路径已被换成外部零字节文件：拿不到任何身份证明，库文件与标记都必须保留现场。
  const zeroDir = join(ROOT, "h6-fstat-zero");
  const zero = runClaimFailure(zeroDir, "fstat-eio-zero");
  assert.equal(zero.errorCode, "fresh_claim_cleanup_required", JSON.stringify(zero));
  assert.equal(zero.details?.status, "manual_review_required", "必须返回明确需人工核对的状态");
  assert.equal(zero.details?.reason, "EIO", "不掩盖原始异常原因");
  assert.equal(zero.db.exists, true, "身份未知时不得删除路径上的库文件");
  assert.equal(zero.db.size, 0, "外部零字节替换对象保留原样");
  assert.equal(zero.db.hash, createHash("sha256").update(Buffer.alloc(0)).digest("hex"), "外部零字节文件仍是空字节（未被写入任何头）");
  assert.equal(zero.marker.exists, true, "身份未知时也不得删除所有权标记（保留现场供人工核对）");
  assert.match(String(zero.marker.text), /"nonce":\s*\d+/, "留下的标记仍是本进程写的那份");
  assert.equal(zero.wal, false);
  assert.equal(zero.shm, false);

  // 2) fstat EIO + 路径已被换成外部合成旧库：不删、不写，逻辑 schema / 行数不变。
  const foreignDir = join(ROOT, "h6-fstat-foreign");
  const foreignRun = runClaimFailure(foreignDir, "fstat-eio-foreign", { foreignDb: foreignSource });
  assert.equal(foreignRun.errorCode, "fresh_claim_cleanup_required", JSON.stringify(foreignRun));
  assert.equal(foreignRun.db.exists, true);
  assert.equal(foreignRun.db.hash, foreignHash, "外部旧库字节完全不变");
  const foreignProbe = new DatabaseSync(join(foreignDir, "workbench.db"), { readOnly: true });
  try {
    assert.deepEqual(foreignProbe.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((row) => row.name),
      ["account_sets"], "外部库没有多出任何表");
    assert.equal(Number(foreignProbe.prepare(`SELECT COUNT(*) AS n FROM account_sets`).get().n), 2);
    assert.equal(Number(foreignProbe.prepare(`PRAGMA user_version`).get().user_version), 0, "外部库自己的 user_version 未被改写");
  } finally { foreignProbe.close(); }
  assert.equal(foreignRun.wal, false);
  assert.equal(foreignRun.shm, false);

  // 3) guard 登记失败（fstat 身份被篡改）+ 所有权标记已被换成外部内容：
  //    本次零字节库文件也必须保留，外部标记必须原样保留。
  const mismatchDir = join(ROOT, "h6-registration-foreign-marker");
  const mismatch = runClaimFailure(mismatchDir, "registration-mismatch", { replaceMarker: true });
  assert.equal(mismatch.errorCode, "fresh_receipt_invalid", JSON.stringify(mismatch));
  assert.equal(mismatch.db.exists, true, "登记失败也固定保留本次零字节库");
  assert.equal(mismatch.db.size,0);
  assert.equal(mismatch.db.hash,createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  assert.equal(mismatch.marker.exists, true, "标记内容已被替换时不得删除");
  assert.equal(mismatch.marker.text, JSON.stringify({ nonce: 987654321, pid: 1, at: "外部替换的标记内容", note: "not-ours" }),
    "外部标记内容一个字节都不能改");

  // 4) 同样的登记失败，但标记仍属于本进程：正常清理仍要释放自己的标记（不因本次收紧而留下垃圾）。
  const cleanDir = join(ROOT, "h6-registration-own-marker");
  const cleaned = runClaimFailure(cleanDir, "registration-mismatch");
  assert.equal(cleaned.errorCode, "fresh_receipt_invalid", JSON.stringify(cleaned));
  assert.equal(cleaned.db.exists, true, "自有零字节库也保留供诊断");
  assert.equal(cleaned.db.size,0);
  assert.equal(cleaned.db.hash,createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  assert.equal(cleaned.marker.exists, false, "自有标记被释放（nonce 命中且未被替换）");

  // 5) 库文件 O_EXCL 打开失败（EEXIST）+ 标记已被换成外部内容：不得删外部标记。
  const eexistDir = join(ROOT, "h6-open-eexist");
  const eexist = runClaimFailure(eexistDir, "open-eexist", { replaceMarker: true });
  assert.equal(eexist.errorCode, "fresh_target_claimed", JSON.stringify(eexist));
  assert.equal(eexist.db.exists, false, "库文件根本没被创建");
  assert.equal(eexist.marker.exists, true, "被替换的标记必须保留");
  assert.equal(eexist.marker.text, JSON.stringify({ nonce: 987654321, pid: 1, at: "外部替换的标记内容", note: "not-ours" }));

  // 6) 打开失败（EACCES）+ 标记被换：同样保留外部标记，不掩盖原始异常。
  const eaccesDir = join(ROOT, "h6-open-eacces-foreign-marker");
  const eacces = runClaimFailure(eaccesDir, "open-eacces", { replaceMarker: true });
  assert.equal(eacces.errorCode, "fresh_target_claim_failed", JSON.stringify(eacces));
  assert.equal(eacces.details?.reason, "EACCES");
  assert.equal(eacces.marker.exists, true);
  assert.equal(eacces.db.exists, false);

  // 7) 打开失败 + 标记仍属于自己的：标记照旧被释放（正常清理未被收紧破坏）。
  const eaccesOwnDir = join(ROOT, "h6-open-eacces-own-marker");
  const eaccesOwn = runClaimFailure(eaccesOwnDir, "open-eacces");
  assert.equal(eaccesOwn.errorCode, "fresh_target_claim_failed", JSON.stringify(eaccesOwn));
  assert.equal(eaccesOwn.marker.exists, false, "自有标记被释放");
  assert.equal(eaccesOwn.db.exists, false);
});

// ---------------------------------------------------------------- H7 跨路径：活动创建事实只允许打开自己创建的库
/**
 * 管理复验真实复现（`local07-crosspath-probe-*` 的 RESULT.json = `not-rejected`）：本进程 claim A 之后把
 * `WORKBENCH_DATA_DIR` 指向另建的合成既有库 B，初始化钩子按路径查不到创建事实就退化成普通入口，
 * 于是在 guard 之前给 B 建了 account_sets 等核心表。现要求：只要本进程持有**活动**创建事实，
 * 核心首次打开的目标就必须对应其创建事实，否则在任何 DDL / WAL / 迁移写之前拒绝；
 * 没有任何活动创建事实时普通业务入口行为不变。
 */
const CROSS_PATH_CODE = `
import fs from "node:fs";
import * as storage from "./server/local-batch-storage.mjs";
const claimDirs = JSON.parse(process.env.CLAIM_DIRS || "[]");
const tokens = claimDirs.map((dir) => storage.claimFreshDataDir(dir));
if (process.env.RELEASE_CLAIMS === "1") tokens.forEach((token) => storage.releaseFreshClaim(token));
const target = process.env.TARGET_DIR;
process.env.WORKBENCH_DATA_DIR = target;
let errorCode = null;
let opened = false;
try { await import("./server/db.mjs"); opened = true; }
catch (error) { errorCode = (error && error.code) ? error.code : "import_failed"; }
const dbPath = target + "/workbench.db";
console.log(JSON.stringify({
  errorCode, opened,
  wal: fs.existsSync(dbPath + "-wal"), shm: fs.existsSync(dbPath + "-shm"),
  entries: fs.existsSync(target) ? fs.readdirSync(target).sort() : null,
}));
`;
function runCrossPath({ claimDirs = [], target, release = false }) {
  const result = runNode(CROSS_PATH_CODE, {
    env: {
      CLAIM_DIRS: JSON.stringify(claimDirs), TARGET_DIR: target,
      ...(release ? { RELEASE_CLAIMS: "1" } : {}),
    },
  });
  assert.equal(result.status, 0, `跨路径子进程应正常结束：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}
/** 合成库指纹：字节 hash + 身份 + 表 / 行 + pragma（user_version / application_id / journal_mode）。 */
function dbFingerprint(dbPath) {
  const stat = statSync(dbPath);
  const probe = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      size: stat.size, dev: String(stat.dev), ino: String(stat.ino),
      hash: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
      tables: probe.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((row) => row.name),
      rows: Number(probe.prepare(`SELECT COUNT(*) AS n FROM sentinel`).get().n),
      userVersion: Number(probe.prepare(`PRAGMA user_version`).get().user_version),
      applicationId: Number(probe.prepare(`PRAGMA application_id`).get().application_id),
      journalMode: String(probe.prepare(`PRAGMA journal_mode`).get().journal_mode),
    };
  } finally { probe.close(); }
}

await test("H7 跨路径：活动创建事实下核心首次打开另一个库必须在任何写之前拒绝", async () => {
  // B：另建的合成既有库（DELETE journal + sentinel 行），模拟「另一个数据目录里已有的账套库」。
  const bDir = join(ROOT, "h7-b");
  mkdirSync(bDir, { recursive: true });
  {
    const seeded = new DatabaseSync(join(bDir, "workbench.db"));
    try {
      seeded.exec(`PRAGMA journal_mode = DELETE;
        CREATE TABLE sentinel (id INTEGER PRIMARY KEY, note TEXT NOT NULL);
        INSERT INTO sentinel (id, note) VALUES (1, '外部既有企业'), (2, '第二行');`);
    } finally { seeded.close(); }
  }
  const bDb = join(bDir, "workbench.db");
  const before = dbFingerprint(bDb);
  assert.equal(before.journalMode, "delete", "B 是 DELETE journal 的合成既有库");
  assert.deepEqual(before.tables, ["sentinel"]);

  // 1) A claim（活动）+ WORKBENCH_DATA_DIR=B：必须在任何核心 DDL / WAL / 迁移写之前拒绝。
  const cross = runCrossPath({ claimDirs: [join(ROOT, "h7-a")], target: bDir });
  assert.equal(cross.errorCode, "fresh_claim_target_mismatch", JSON.stringify(cross));
  assert.equal(cross.opened, false, "初始化钩子必须先拒绝，不能完成 DDL");
  assert.equal(cross.wal, false, "不得持久设置 WAL");
  assert.equal(cross.shm, false);
  assert.deepEqual(cross.entries, ["workbench.db"], "B 目录不得多出 -wal / -shm / 标记等任何文件");
  assert.deepEqual(dbFingerprint(bDb), before, "B 的 SHA / 表 / 行 / pragma / journal_mode 全部保留");

  // 2) junction 别名路径指向 B：同样必须拒绝（不能靠 map miss 退化成普通入口），B 仍完全不变。
  const linkPath = join(ROOT, "h7-b-link");
  let junctionError = null;
  try { symlinkSync(bDir, linkPath, "junction"); } catch (error) { junctionError = error?.code || String(error); }
  assert.equal(junctionError, null, "本机必须能构造 junction 别名（不可构造不得当成通过）");
  const aliased = runCrossPath({ claimDirs: [join(ROOT, "h7-a2")], target: linkPath });
  assert.equal(aliased.errorCode, "fresh_claim_target_mismatch", JSON.stringify(aliased));
  assert.equal(aliased.opened, false);
  assert.deepEqual(dbFingerprint(bDb), before, "经 junction 也不能写入 B");
  assert.deepEqual(readdirSync(bDir).sort(), ["workbench.db"]);

  // 3) 多个活动 claim：目标对应其中一次创建事实时仍走 claimed 路径（不是一刀切禁死）。
  const matched = runCrossPath({
    claimDirs: [join(ROOT, "h7-m1"), join(ROOT, "h7-m2")], target: join(ROOT, "h7-m1"),
  });
  assert.equal(matched.errorCode, null, JSON.stringify(matched));
  assert.equal(matched.opened, true, "目标与某次创建事实对应时必须继续");
  const matchedProbe = openDb(join(ROOT, "h7-m1"));
  try {
    assert.ok(
      Number(matchedProbe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get().n) >= 10,
      "匹配目标照常建立核心结构",
    );
  } finally { matchedProbe.close(); }

  // 3b) 多个活动 claim 但目标不对应任何一次：仍拒绝，且该目标不得留下任何 schema 对象。
  const otherTarget = join(ROOT, "h7-other");
  const other = runCrossPath({ claimDirs: [join(ROOT, "h7-n1"), join(ROOT, "h7-n2")], target: otherTarget });
  assert.equal(other.errorCode, "fresh_claim_target_mismatch", JSON.stringify(other));
  assert.equal(other.opened, false);
  assert.equal(other.wal, false);
  assert.equal(other.shm, false);
  if (existsSync(join(otherTarget, "workbench.db"))) {
    const otherProbe = openDb(otherTarget);
    try {
      assert.equal(
        Number(otherProbe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get().n), 0,
        "被拒绝的目标不得建立任何 schema 对象",
      );
    } finally { otherProbe.close(); }
  }

  // 4) 未知默认导入仍拒绝非严格结构；不承诺零写入。
  const strictBefore=dbFingerprint(bDb),directoryBefore=readdirSync(bDir).sort();
  const readonly=new DatabaseSync(bDb,{readOnly:true});try{const LB=await import('../server/local-backup.mjs');assert.throws(()=>LB.assertSupportedDatabaseConnection(readonly),e=>e.code==='not_product_database');}finally{readonly.close();}
  assert.deepEqual(dbFingerprint(bDb),strictBefore);assert.deepEqual(readdirSync(bDir).sort(),directoryBefore);
  const unknown=runCrossPath({claimDirs:[join(ROOT,'h7-r1'),join(ROOT,'h7-r2')],target:bDir,release:true});assert.equal(unknown.errorCode,'structure_invalid');assert.equal(unknown.opened,false);assert.equal(dbFingerprint(bDb).rows,before.rows);console.log('unknown default import rejected; core-init side effects are not claimed zero');
  const cDir=join(ROOT,'h7-supported');primeDataDir(cDir);const [c]=createFixture(cDir,[{name:'supported ordinary open',enterpriseKey:'SYN-H7-C',salary:47.29}]);
  const business=()=>{const handle=openDb(cDir);try{return JSON.stringify(['account_sets','accounts','opening_balances','periods','vouchers','voucher_entries','asset_cards','asset_depreciation_runs','import_enterprise_account_sets','import_source_bindings','import_batches','import_voucher_sources','import_batch_vouchers'].map(t=>[t,handle.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));}finally{handle.close();}};
  const supportedBefore=business();const normal=runCrossPath({claimDirs:[join(ROOT,'h7-cr1'),join(ROOT,'h7-cr2')],target:cDir,release:true});assert.equal(normal.errorCode,null,JSON.stringify(normal));assert.equal(normal.opened,true);assert.equal(business(),supportedBefore);assert.equal(count(cDir,'SELECT SUM(debit) FROM voucher_entries'),47.29);

});

// ---------------------------------------------------------------- H8 所有权标记归属：只认创建时的不可变身份
/**
 * nonce 不是秘密（标记 JSON / 页 1 / describeFreshClaim / 诊断都会出现它），所以「内容命中 nonce」
 * 不能当归属证据：同一个 nonce 的新文件对象（哪怕字节完全相同）或追加了外部字段的标记都必须保留。
 * 归属只能来自 O_EXCL 创建时 `fstat(markerFd)` 的不可变身份 + 本进程写下的期望内容。
 */
await test("H8 所有权标记只认创建时身份：同 nonce 替换对象在 open / release / 登记失败时均不误删", () => {
  // 1) 字节完全相同的新文件对象（同一 nonce）：open 校验失败，release 不删该对象。
  const sameBytesDir = join(ROOT, "h8-same-bytes");
  const sameBytesToken = storage.claimFreshDataDir(sameBytesDir);
  const sameBytesMarker = join(sameBytesDir, ".local-batch-create");
  const sameBytesDb = join(sameBytesDir, "workbench.db");
  const originalBytes = readFileSync(sameBytesMarker);
  assert.match(originalBytes.toString("utf8"), /"nonce":\d+/, "标记里本来就有 nonce（不是秘密）");
  unlinkSync(sameBytesMarker);
  writeFileSync(sameBytesMarker, originalBytes);
  const sameBytesConn = new DatabaseSync(sameBytesDb, { readOnly: true });
  try {
    assert.throws(
      () => storage.assertFreshReceipt(sameBytesToken, sameBytesConn),
      (error) => error.code === "fresh_receipt_stale",
      "同字节的替换对象不是本进程创建的标记",
    );
  } finally { sameBytesConn.close(); }
  const sameSeedHash=storage.sha256(readFileSync(sameBytesDb));
  assert.equal(storage.releaseFreshClaim(sameBytesToken), true);
  assert.equal(existsSync(sameBytesMarker), true, "同字节替换的标记对象必须保留");
  assert.deepEqual(readFileSync(sameBytesMarker), originalBytes, "替换对象字节一个都不能改");
  assert.equal(existsSync(sameBytesDb), true, "本次空种子同样保留供诊断");
  assert.equal(storage.sha256(readFileSync(sameBytesDb)),sameSeedHash,"替换marker时DB种子也逐字节保留");

  // 2) 同一 nonce + 外部追加字段：同样不是我的（内容不是本进程写下的那份）。
  const extraDir = join(ROOT, "h8-same-nonce-extra");
  const extraToken = storage.claimFreshDataDir(extraDir);
  const extraMarker = join(extraDir, ".local-batch-create");
  const parsedMarker = JSON.parse(readFileSync(extraMarker, "utf8"));
  const extraContent = JSON.stringify({ ...parsedMarker, note: "external-extension" });
  writeFileSync(extraMarker, extraContent);
  const extraConn = new DatabaseSync(join(extraDir, "workbench.db"), { readOnly: true });
  try {
    assert.throws(
      () => storage.assertFreshReceipt(extraToken, extraConn),
      (error) => error.code === "fresh_receipt_stale",
      "追加外部字段的标记不是本进程写下的内容",
    );
  } finally { extraConn.close(); }
  assert.equal(storage.releaseFreshClaim(extraToken), true);
  assert.equal(readFileSync(extraMarker, "utf8"), extraContent, "追加字段的外部标记必须原样保留");

  // 3) 回执 token 上的任意赋值（含标记相关字段）不改变内部事实；自己的标记 / 创建fd被释放，空种子逐字节保留。
  const ownDir = join(ROOT, "h8-own");
  const ownToken = storage.claimFreshDataDir(ownDir);
  const ownMarker = join(ownDir, ".local-batch-create");
  ownToken.markerIdentity = { dev: "0", ino: "0" };
  ownToken.markerContent = "not-ours";
  ownToken.markerPath = join(ROOT, "h8-elsewhere-marker");
  ownToken.markerFd = 0;
  const ownFacts = guard.describeFreshClaim(ownToken);
  const ownConn = new DatabaseSync(join(ownDir, "workbench.db"), { readOnly: true });
  try {
    const bound = storage.assertFreshReceipt(ownToken, ownConn);
    assert.equal(String(bound.dev), String(ownFacts.identity.dev), "绑定仍指向内部不可变事实");
    assert.equal(String(bound.ino), String(ownFacts.identity.ino));
  } finally { ownConn.close(); }
  const ownSeedHash=storage.sha256(readFileSync(join(ownDir,"workbench.db")));
  assert.equal(storage.releaseFreshClaim(ownToken), true);
  assert.equal(existsSync(ownMarker), false, "自己的标记仍被正常释放");
  assert.equal(existsSync(join(ownDir, "workbench.db")), true, "自己的空种子保留供诊断");
  assert.equal(storage.sha256(readFileSync(join(ownDir,"workbench.db"))),ownSeedHash,"空种子字节不变");
  assert.equal(storage.releaseFreshClaim(ownToken),false,"再次释放幂等无写");

  // 4) 登记失败路径（H6 注入）下的同 nonce 替换：外部标记与本次零字节DB均保留。
  const registerDir = join(ROOT, "h8-register-same-bytes");
  const registerSame = runClaimFailure(registerDir, "registration-mismatch", { replaceMarker: "same-bytes" });
  assert.equal(registerSame.errorCode, "fresh_receipt_invalid", JSON.stringify(registerSame));
  assert.equal(registerSame.db.exists, true, "未登记失败保留本次零字节库");
  assert.equal(registerSame.db.size,0);
  assert.equal(registerSame.db.hash,createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  assert.equal(registerSame.marker.exists, true, "同字节替换的标记不得被删除");
  assert.match(String(registerSame.marker.text), /"nonce":\d+/, "保留的仍是同 nonce 的替换对象");
  assert.ok(!/"note"/.test(String(registerSame.marker.text)), "标记字节未被改写（没写入额外字段）");

  const registerExtraDir = join(ROOT, "h8-register-same-nonce-extra");
  const registerExtra = runClaimFailure(registerExtraDir, "registration-mismatch", { replaceMarker: "same-nonce-extra" });
  assert.equal(registerExtra.errorCode, "fresh_receipt_invalid", JSON.stringify(registerExtra));
  assert.equal(registerExtra.marker.exists, true, "同 nonce 追加字段的标记不得被删除");
  assert.match(String(registerExtra.marker.text), /"note":"external-extension"/, "外部追加字段原样保留");

  // 5) 打开失败分支 + 同字节替换标记：同样保留。
  const openDir = join(ROOT, "h8-open-same-bytes");
  const openSame = runClaimFailure(openDir, "open-eacces", { replaceMarker: "same-bytes" });
  assert.equal(openSame.errorCode, "fresh_target_claim_failed", JSON.stringify(openSame));
  assert.equal(openSame.db.exists, false);
  assert.equal(openSame.marker.exists, true, "打开失败时同字节替换的标记不得被删除");
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

// ---------------------------------------------------------------- K. 折旧证据完整性 / resume 真实重检
function depreciationItem(fixture, spec, periods) {
  return {
    itemKey: spec.itemKey,
    source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
    accountSetId: fixture.setId,
    periods: periods.map((period) => ({ period, depreciation: true })),
  };
}
const CARD_UPDATE_CODE = `
import * as A from "./server/accounting.mjs";
const patch = JSON.parse(process.env.CARD_PATCH);
A.updateAssetCard(Number(process.env.SET_ID), Number(process.env.CARD_ID), patch);
console.log(JSON.stringify({ patched: true }));
`;
function updateStateCard(dataDir, setId, cardId, patch) {
  const result = runNode(CARD_UPDATE_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(setId), CARD_ID: String(cardId), CARD_PATCH: JSON.stringify(patch) },
  });
  assert.equal(result.status, 0, `更新卡片失败：${result.stderr}`);
}
const CARD_DELETE_CODE = `
import * as A from "./server/accounting.mjs";
A.deleteAssetCard(Number(process.env.SET_ID), Number(process.env.CARD_ID));
console.log(JSON.stringify({ deleted: true }));
`;
function deleteStateCard(dataDir, setId, cardId) {
  const result = runNode(CARD_DELETE_CODE, {
    env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(setId), CARD_ID: String(cardId) },
  });
  assert.equal(result.status, 0, `删除卡片失败：${result.stderr}`);
}
/** 直接 SQL 改动（用真实 SQLite 写入合成库）：模拟外部 / 遗留工具改动业务事实。 */
function mutateSql(dataDir, sql, ...args) {
  const db = new DatabaseSync(join(dataDir, "workbench.db"));
  try { db.prepare(sql).run(...args); } finally { db.close(); }
}
const voucherCount = (dataDir, setId) => count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=?`, setId);
const runCount = (dataDir, setId) => count(dataDir, `SELECT COUNT(*) FROM asset_depreciation_runs WHERE account_set_id=?`, setId);
const depVoucherCount = (dataDir, setId) => count(dataDir, `SELECT COUNT(*) FROM vouchers WHERE account_set_id=? AND kind='depreciation'`, setId);

await test("K1 折旧 no_action / 已计提证据完整（卡片事实 + 全部 runs + 关联凭证）：跨进程 resume 不重做、反过账转复核且不默补提", () => {
  const dataDir = join(ROOT, "k1-data");
  const outDir = join(ROOT, "k1-out");
  primeDataDir(dataDir);
  const spec = { itemKey: "dep-1", enterpriseKey: "91350000DEPR0001A", name: "折旧证据甲", revenue: 1000, other: 0, capital: 30000 };
  const [fixture] = createFixture(dataDir, [spec]);
  // 真实领域入口建卡并先计提一次（已过账）：批量阶段因此是「本期已计提」的 no_action。
  const seeded = addStateCard(dataDir, {
    setId: fixture.setId,
    card: {
      kind: "fixed", name: "已计提设备", original_cost: 600, residual_rate: 0, useful_life_months: 12,
      start_period: "2026-01", acquired_period: "2026-01",
      asset_account: "1601", accum_account: "1602", expense_account: "5602",
    },
    preDepreciate: true,
  });
  assert.ok(seeded.generated?.voucherId, "预置计提必须真实生成已过账凭证");
  const manifestPath = writeManifest("k1", jobManifest({
    jobKey: "depot-evidence", items: [depreciationItem(fixture, spec, ["2026-01"])],
  }));
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
  const first = stageRow(dataDir, "depreciation", spec.enterpriseKey);
  assert.equal(first.status, "not_applicable");
  const evidence = JSON.parse(first.evidence_json);
  assert.equal(evidence.action, "no_action");
  assert.equal(evidence.reason, "already_posted_this_period");
  assert.equal(evidence.voucher, null);
  assert.equal(evidence.cards.length, 1);
  // 卡片集合 + 与当期适用性相关的事实必须持久化（不能只记一个 status）。
  for (const field of [
    "assetId", "startPeriod", "acquiredPeriod", "acquiredPeriodRaw", "acquiredPeriodMissing", "ledgerStatus",
    "usefulLifeMonths", "originalCost", "residualRate", "openingAccumulated", "periodIndex", "depreciable",
    "accumulated", "remaining", "status", "dueAmount", "recordedAmount",
  ]) {
    assert.ok(Object.hasOwn(evidence.cards[0], field), `证据缺少卡片事实 ${field}`);
  }
  assert.equal(evidence.cards[0].status, "posted");
  assert.equal(evidence.cards[0].recordedAmount, 50);
  // 当期**全部** runs + 关联凭证 / 分录指纹（旧实现只记新生成的 runs，no_action 时恒为空）。
  assert.equal(evidence.runs.length, 1);
  assert.equal(evidence.runs[0].voucherId, seeded.generated.voucherId);
  assert.equal(evidence.runs[0].voucherStatus, "posted");
  assert.equal(evidence.runs[0].amount, 50);
  assert.match(String(evidence.runs[0].entriesHash), /^[0-9a-f]{64}$/);
  const vouchersBefore = voucherCount(dataDir, fixture.setId);
  const runsBefore = runCount(dataDir, fixture.setId);
  const attemptBefore = first.attempt;

  // 跨进程普通 resume：数据未变 → 仍不适用、不重做（attempt 不变、不新增凭证 / run）。
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-evidence"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).status, "not_applicable");
  assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).attempt, attemptBefore);
  assert.equal(voucherCount(dataDir, fixture.setId), vouchersBefore);
  assert.equal(runCount(dataDir, fixture.setId), runsBefore);

  // 真实反过账已计提凭证 → resume 必须转 needs_review（draft_pending），且不默补提。
  setVoucherState(dataDir, fixture.setId, seeded.generated.voucherId, "unpostVoucher");
  const broken = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-evidence"]);
  assert.equal(broken.status, 1, `${broken.stderr} ${broken.stdout}`);
  const brokenRow = stageRow(dataDir, "depreciation", spec.enterpriseKey);
  assert.equal(brokenRow.status, "needs_review");
  assert.equal(brokenRow.error_code, "evidence_changed");
  assert.equal(JSON.parse(brokenRow.evidence_json).verificationFailure, "depreciation_card_draft_pending");
  assert.equal(voucherCount(dataDir, fixture.setId), vouchersBefore, "复核不得自动补提凭证");
  assert.equal(runCount(dataDir, fixture.setId), runsBefore, "复核不得自动补提 run");

  // 修复路径：真实重新过账 + 显式 retry → resume 只重做该阶段，不重复计提。
  setVoucherState(dataDir, fixture.setId, seeded.generated.voucherId, "postVoucher");
  const retried = runCli(["retry", "--data-dir", dataDir, "--job-key", "depot-evidence", "--item", "dep-1"]);
  assert.equal(retried.status, 0, retried.stderr);
  const repaired = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-evidence"]);
  assert.equal(repaired.status, 0, `${repaired.stderr} ${repaired.stdout}`);
  const repairedRow = stageRow(dataDir, "depreciation", spec.enterpriseKey);
  assert.equal(repairedRow.status, "not_applicable");
  assert.equal(voucherCount(dataDir, fixture.setId), vouchersBefore, "修复路径不得重复计提");
  assert.equal(runCount(dataDir, fixture.setId), runsBefore);
  assert.equal(depVoucherCount(dataDir, fixture.setId), seeded.generated.voucherId ? 1 : 0);

  // 后续期间合法计提后：历史期间证据仍可核验（期间口径不被后期计提污染）。
  const laterPath = writeManifest("k1-later", jobManifest({
    jobKey: "depot-later", items: [depreciationItem(fixture, spec, ["2026-02"])],
  }));
  const later = runCli(["start", "--data-dir", dataDir, "--manifest", laterPath, "--output-dir", outDir]);
  assert.equal(later.status, 0, `${later.stderr} ${later.stdout}`);
  assert.equal(runCount(dataDir, fixture.setId), runsBefore + 1, "后续期间真实新增一条计提 run");
  const historyResume = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-evidence"]);
  assert.equal(historyResume.status, 0, `${historyResume.stderr} ${historyResume.stdout}`);
  assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).status, "not_applicable");
  assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).attempt, repairedRow.attempt);
});

await test("K2 卡片增删 / 未来卡变当期 due / 金额变化 / 凭证分录被改：resume 均转复核且不默补提", () => {
  const card = (patch = {}) => ({
    kind: "fixed", name: "设备", original_cost: 600, residual_rate: 0, useful_life_months: 12,
    start_period: "2026-01", acquired_period: "2026-01",
    asset_account: "1601", accum_account: "1602", expense_account: "5602", ...patch,
  });

  // a) 无卡片 → not_applicable；真实新增一张本期 due 的卡 → resume 转复核，不自动补提。
  {
    const dataDir = join(ROOT, "k2a-data");
    const outDir = join(ROOT, "k2a-out");
    primeDataDir(dataDir);
    const spec = { itemKey: "dep-a", enterpriseKey: "91350000DEPR0002A", name: "折旧证据乙", revenue: 900, other: 0, capital: 20000 };
    const [fixture] = createFixture(dataDir, [spec]);
    const manifestPath = writeManifest("k2a", jobManifest({
      jobKey: "depot-cards-added", items: [depreciationItem(fixture, spec, ["2026-01"])],
    }));
    const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
    assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
    assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).status, "not_applicable");
    assert.equal(JSON.parse(stageRow(dataDir, "depreciation", spec.enterpriseKey).evidence_json).reason, "no_asset_cards");
    addStateCard(dataDir, { setId: fixture.setId, card: card() });
    const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-cards-added"]);
    assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
    const row = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(row.status, "needs_review");
    assert.equal(JSON.parse(row.evidence_json).verificationFailure, "depreciation_cards_changed");
    assert.equal(voucherCount(dataDir, fixture.setId), 0, "复核不得自动补提");
    assert.equal(runCount(dataDir, fixture.setId), 0);
  }

  // b) 未来取得期间的卡（not_existed）→ 真实改成当期取得（due）→ resume 转复核，不自动补提。
  {
    const dataDir = join(ROOT, "k2b-data");
    const outDir = join(ROOT, "k2b-out");
    primeDataDir(dataDir);
    const spec = { itemKey: "dep-b", enterpriseKey: "91350000DEPR0003A", name: "折旧证据丙", revenue: 700, other: 0, capital: 20000 };
    const [fixture] = createFixture(dataDir, [spec]);
    const created = addStateCard(dataDir, { setId: fixture.setId, card: card({ name: "未来设备", acquired_period: "2026-03" }) });
    const manifestPath = writeManifest("k2b", jobManifest({
      jobKey: "depot-future-card", items: [depreciationItem(fixture, spec, ["2026-01"])],
    }));
    const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
    assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
    const startedRow = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(startedRow.status, "not_applicable");
    assert.equal(JSON.parse(startedRow.evidence_json).cards[0].status, "not_existed");
    updateStateCard(dataDir, fixture.setId, created.cardId, { acquired_period: "2026-01" });
    const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-future-card"]);
    assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
    const row = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(row.status, "needs_review");
    assert.equal(JSON.parse(row.evidence_json).verificationFailure, "depreciation_card_became_due");
    assert.equal(voucherCount(dataDir, fixture.setId), 0, "未来卡变 due 不得自动补提");
    assert.equal(runCount(dataDir, fixture.setId), 0);
  }

  // c) 卡片集合被真实删除 → resume 转复核（不把少了一张卡当成通过）。
  {
    const dataDir = join(ROOT, "k2c-data");
    const outDir = join(ROOT, "k2c-out");
    primeDataDir(dataDir);
    const spec = { itemKey: "dep-c", enterpriseKey: "91350000DEPR0004A", name: "折旧证据丁", revenue: 500, other: 0, capital: 20000 };
    const [fixture] = createFixture(dataDir, [spec]);
    addStateCard(dataDir, { setId: fixture.setId, card: card({ name: "未来设备", acquired_period: "2026-03" }) });
    const removable = addStateCard(dataDir, { setId: fixture.setId, card: card({ name: "零分设备", original_cost: 1, useful_life_months: 1200 }) });
    const manifestPath = writeManifest("k2c", jobManifest({
      jobKey: "depot-card-deleted", items: [depreciationItem(fixture, spec, ["2026-01"])],
    }));
    const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
    assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
    assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).status, "not_applicable");
    deleteStateCard(dataDir, fixture.setId, removable.cardId);
    const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-card-deleted"]);
    assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
    const row = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(row.status, "needs_review");
    assert.equal(JSON.parse(row.evidence_json).verificationFailure, "depreciation_cards_changed");
    assert.equal(voucherCount(dataDir, fixture.setId), 0);
  }

  // d) 金额变化（真实 SQL 业务事实改动）：run 金额被改 → 卡片重算 posted_stale → 复核，不补提。
  {
    const dataDir = join(ROOT, "k2d-data");
    const outDir = join(ROOT, "k2d-out");
    primeDataDir(dataDir);
    const spec = { itemKey: "dep-d", enterpriseKey: "91350000DEPR0005A", name: "折旧证据戊", revenue: 1300, other: 0, capital: 20000 };
    const [fixture] = createFixture(dataDir, [spec]);
    addStateCard(dataDir, { setId: fixture.setId, card: card() });
    const manifestPath = writeManifest("k2d", jobManifest({
      jobKey: "depot-amount", items: [depreciationItem(fixture, spec, ["2026-01"])],
    }));
    const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
    assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
    assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).status, "succeeded");
    const vouchersBefore = voucherCount(dataDir, fixture.setId);
    const runsBefore = runCount(dataDir, fixture.setId);
    mutateSql(dataDir, `UPDATE asset_depreciation_runs SET amount=? WHERE account_set_id=? AND period='2026-01'`, 60, fixture.setId);
    const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-amount"]);
    assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
    const row = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(row.status, "needs_review");
    assert.equal(JSON.parse(row.evidence_json).verificationFailure, "depreciation_card_posted_stale");
    assert.equal(voucherCount(dataDir, fixture.setId), vouchersBefore, "复核不得补提 / 改凭证");
    assert.equal(runCount(dataDir, fixture.setId), runsBefore);
  }

  // e) 计提凭证分录被改（run 金额不变）→ 分录指纹不一致 → 复核，不补提。
  {
    const dataDir = join(ROOT, "k2e-data");
    const outDir = join(ROOT, "k2e-out");
    primeDataDir(dataDir);
    const spec = { itemKey: "dep-e", enterpriseKey: "91350000DEPR0006A", name: "折旧证据己", revenue: 1500, other: 0, capital: 20000 };
    const [fixture] = createFixture(dataDir, [spec]);
    addStateCard(dataDir, { setId: fixture.setId, card: card() });
    const manifestPath = writeManifest("k2e", jobManifest({
      jobKey: "depot-voucher-entries", items: [depreciationItem(fixture, spec, ["2026-01"])],
    }));
    const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
    assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
    const row = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(row.status, "succeeded");
    const evidence = JSON.parse(row.evidence_json);
    const entryRows = (() => {
      const db = openDb(dataDir);
      try {
        return db.prepare(`SELECT id, code, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY id`)
          .all(evidence.voucher.voucherId);
      } finally { db.close(); }
    })();
    const debitEntry = entryRows.find((entry) => Number(entry.debit) > 0);
    const creditEntry = entryRows.find((entry) => Number(entry.credit) > 0);
    // 两边同额改动：凭证仍平衡，run 金额不变 → 只有分录指纹能发现。
    mutateSql(dataDir, `UPDATE voucher_entries SET debit=? WHERE id=?`, 55, debitEntry.id);
    mutateSql(dataDir, `UPDATE voucher_entries SET credit=? WHERE id=?`, 55, creditEntry.id);
    const vouchersBefore = voucherCount(dataDir, fixture.setId);
    const runsBefore = runCount(dataDir, fixture.setId);
    const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "depot-voucher-entries"]);
    assert.equal(resumed.status, 1, `${resumed.stderr} ${resumed.stdout}`);
    const broken = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(broken.status, "needs_review");
    assert.equal(JSON.parse(broken.evidence_json).verificationFailure, "depreciation_run_voucher_modified");
    assert.equal(voucherCount(dataDir, fixture.setId), vouchersBefore, "复核不得补提 / 重写凭证");
    assert.equal(runCount(dataDir, fixture.setId), runsBefore);
  }
});

await test("K3 同月先提 A50 后新增 B100：只生成新增子集、全量证据保留、跨进程无重复，旧凭证异常原子拒绝", () => {
  const card = (cost) => ({
    kind: "fixed", name: `设备${cost}`, original_cost: cost, residual_rate: 0, useful_life_months: 12,
    start_period: "2026-01", acquired_period: "2026-01", ledger_status: "booked",
    asset_account: "1601", accum_account: "1602", expense_account: "5602",
  });
  for (const mode of ["valid", "resume-scope", "resume-kind", "old-entries", "old-code", "old-scope", "old-period", "old-kind", "old-amount", "old-draft"]) {
    const dataDir = join(ROOT, `k3-${mode}-data`);
    const outDir = join(ROOT, `k3-${mode}-out`);
    primeDataDir(dataDir);
    const spec = { itemKey: "added-card", enterpriseKey: `K3-${mode}`, name: `同月新增-${mode}` };
    const [fixture] = createFixture(dataDir, [spec]);
    const a = addStateCard(dataDir, { setId: fixture.setId, card: card(600), preDepreciate: true });
    const b = addStateCard(dataDir, { setId: fixture.setId, card: card(1200) });
    const oldVoucher = a.generated.voucherId;
    if (mode === "old-entries") {
      // 借贷仍平衡、run 金额仍 50，必须按旧凭证本身检查，不可仅核本次新凭证。
      mutateSql(dataDir, `UPDATE voucher_entries SET debit=CASE WHEN debit>0 THEN 51 ELSE 0 END,
        credit=CASE WHEN credit>0 THEN 51 ELSE 0 END WHERE voucher_id=?`, oldVoucher);
    }
    if (mode === "old-code") mutateSql(dataDir, `UPDATE voucher_entries SET code='NOT_AN_ACCOUNT' WHERE voucher_id=? AND debit>0`, oldVoucher);
    if (mode === "old-scope") {
      const [other] = createFixture(dataDir, [{ enterpriseKey: "K3-other-scope", name: "另一合成账套" }]);
      mutateSql(dataDir, `UPDATE vouchers SET account_set_id=? WHERE id=?`, other.setId, oldVoucher);
    }
    if (mode === "old-period") mutateSql(dataDir, `UPDATE vouchers SET period='2026-02' WHERE id=?`, oldVoucher);
    if (mode === "old-kind") mutateSql(dataDir, `UPDATE vouchers SET kind='normal' WHERE id=?`, oldVoucher);
    if (mode === "old-amount") mutateSql(dataDir, `UPDATE asset_depreciation_runs SET amount=60 WHERE asset_id=?`, a.cardId);
    if (mode === "old-draft") setVoucherState(dataDir, fixture.setId, oldVoucher, "unpostVoucher");
    const before = count(dataDir, `SELECT COUNT(*) FROM vouchers`);
    const manifestPath = writeManifest(`k3-${mode}`, jobManifest({
      jobKey: `added-${mode}`, items: [depreciationItem(fixture, spec, ["2026-01"])],
    }));
    const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
    if (mode !== "valid" && !mode.startsWith("resume-")) {
      assert.equal(started.status, 1, `${mode}: ${started.stderr} ${started.stdout}`);
      assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).status, "needs_review", mode);
      assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), before, `${mode}: 新凭证整体回滚`);
      assert.equal(runCount(dataDir, fixture.setId), 1, `${mode}: 不补提 B`);
      continue;
    }
    assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
    const first = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(first.status, "succeeded");
    const evidence = JSON.parse(first.evidence_json);
    assert.equal(evidence.cards.length, 2);
    assert.equal(evidence.runs.length, 2, "恢复证据不能只记录本次新增 subset");
    assert.deepEqual(evidence.dueCards, [b.cardId]);
    const oldRun = evidence.runs.find((run) => run.assetId === a.cardId);
    const newRun = evidence.runs.find((run) => run.assetId === b.cardId);
    assert.equal(oldRun.voucherId, oldVoucher);
    assert.equal(oldRun.amount, 50);
    assert.equal(newRun.amount, 100);
    assert.notEqual(newRun.voucherId, oldVoucher);
    assert.equal(evidence.voucher.voucherId, newRun.voucherId);
    assert.equal(evidence.voucher.totalDebit, 100);
    assert.equal(evidence.voucher.totalCredit, 100);
    assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), before + 1);
    const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", `added-${mode}`]);
    assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
    assert.equal(stageRow(dataDir, "depreciation", spec.enterpriseKey).attempt, first.attempt);
    assert.equal(depVoucherCount(dataDir, fixture.setId), 2);
    assert.equal(runCount(dataDir, fixture.setId), 2);
    // 新凭证未变，只篡改旧凭证分录，恢复仍应拒绝且不重做。
    if (mode === "resume-scope") {
      const [other] = createFixture(dataDir, [{ enterpriseKey: "K3-resume-other", name: "恢复时另一合成账套" }]);
      mutateSql(dataDir, `UPDATE vouchers SET account_set_id=? WHERE id=?`, other.setId, oldVoucher);
    } else if (mode === "resume-kind") {
      mutateSql(dataDir, `UPDATE vouchers SET kind='normal' WHERE id=?`, oldVoucher);
    } else {
      mutateSql(dataDir, `UPDATE voucher_entries SET code='6602' WHERE voucher_id=? AND debit>0`, oldVoucher);
    }
    const broken = runCli(["resume", "--data-dir", dataDir, "--job-key", `added-${mode}`]);
    assert.equal(broken.status, 1, `${broken.stderr} ${broken.stdout}`);
    const row = stageRow(dataDir, "depreciation", spec.enterpriseKey);
    assert.equal(row.status, "needs_review");
    assert.equal(JSON.parse(row.evidence_json).verificationFailure, "depreciation_run_voucher_modified");
    assert.equal(count(dataDir, `SELECT COUNT(*) FROM vouchers`), before + 1);
    assert.equal(runCount(dataDir, fixture.setId), 2);
  }
});

await test("K4 已计提后合法改未来费用科目：核心与批量同月新增一致，旧凭证不改写且恢复仍拒旧分录篡改", () => {
  const card = (cost) => ({
    kind: "fixed", name: `费用科目设备${cost}`, original_cost: cost, residual_rate: 0, useful_life_months: 12,
    start_period: "2026-01", acquired_period: "2026-01", ledger_status: "booked",
    asset_account: "1601", accum_account: "1602", expense_account: "5602",
  });
  for (const mode of ["core", "batch"]) {
    const dataDir = join(ROOT, `k4-${mode}-data`);
    primeDataDir(dataDir);
    const spec = { itemKey: "expense-change", enterpriseKey: `K4-${mode}`, name: `费用科目维护-${mode}` };
    const [fixture] = createFixture(dataDir, [spec]);
    const a = addStateCard(dataDir, { setId: fixture.setId, card: card(600), preDepreciate: true });
    const oldVoucher = a.generated.voucherId;
    updateStateCard(dataDir, fixture.setId, a.cardId, { expense_account: "5601" });
    addStateCard(dataDir, { setId: fixture.setId, card: card(1200) });
    if (mode === "core") {
      const generated = runNode(`import * as A from './server/accounting.mjs';
        const result=A.generateDepreciation(Number(process.env.SET_ID),'2026-01');
        console.log(JSON.stringify({ amount: result.runs.reduce((sum,run)=>sum+run.amount,0), count:result.runs.length }));`,
      { env: { WORKBENCH_DATA_DIR: dataDir, SET_ID: String(fixture.setId) } });
      assert.equal(generated.status, 0, generated.stderr);
      assert.deepEqual(JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1)), { amount: 100, count: 1 });
      console.log("    核心实证：updateAssetCard(5602→5601) 后新增 B100 成功");
    } else {
      const manifestPath = writeManifest("k4", jobManifest({ jobKey: "expense-change",
        items: [depreciationItem(fixture, spec, ["2026-01"])] }));
      const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", join(ROOT, "k4-out")]);
      assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
      const evidence = JSON.parse(stageRow(dataDir, "depreciation", spec.enterpriseKey).evidence_json);
      assert.equal(evidence.voucher.totalDebit, 100);
      assert.equal(evidence.runs.length, 2);
      assert.equal(count(dataDir, `SELECT code FROM voucher_entries WHERE voucher_id=? AND debit>0`, oldVoucher), "5602",
        "合法维护未来科目不得重写原凭证");
      // 完成之后再次合法维护未来费用科目，也不应使历史计提证据失效。
      updateStateCard(dataDir, fixture.setId, a.cardId, { expense_account: "5602" });
      const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "expense-change"]);
      assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
      // 旧费用科目仍 5602 是合法历史事实；直接改旧凭证到另一合法费用科目也必须被指纹拒绝。
      mutateSql(dataDir, `UPDATE voucher_entries SET code='5601' WHERE voucher_id=? AND debit>0`, oldVoucher);
      const broken = runCli(["resume", "--data-dir", dataDir, "--job-key", "expense-change"]);
      assert.equal(broken.status, 1, `${broken.stderr} ${broken.stdout}`);
      assert.equal(JSON.parse(stageRow(dataDir, "depreciation", spec.enterpriseKey).evidence_json).verificationFailure,
        "depreciation_run_voucher_modified");
    }
    assert.equal(count(dataDir, `SELECT code FROM voucher_entries WHERE voucher_id=? AND debit>0`, oldVoucher), mode === "core" ? "5602" : "5601");
    assert.equal(runCount(dataDir, fixture.setId), 2);
    assert.equal(depVoucherCount(dataDir, fixture.setId), 2);
  }
});

// ---------------------------------------------------------------- 收尾
if(SELECT_CASES)assert.deepEqual(new Set(RESULTS.map(([,name])=>name.split(' ')[0])),SELECT_CASES,'选中的原用例必须实际执行，不接受空过滤');
console.log("");
const passed = RESULTS.filter(([ok]) => ok).length;
console.log(`结果：${passed} / ${RESULTS.length} 通过`);
if (failures === 0) {
  cleanupRoot();
  process.exit(0);
}
console.log(`未清理临时目录（便于排查）：${ROOT}`);
process.exit(1);
