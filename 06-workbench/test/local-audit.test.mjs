#!/usr/bin/env node
/**
 * LOCAL-06 AUDIT（A 包）存储 / 事务 / 去重 / 隐私 / 查询验收。
 *
 * 全部使用 `mkdtemp` 合成临时目录，并在导入任何模块**之前**设置 `WORKBENCH_DATA_DIR`；
 * 本套件不 import `server/db.mjs` / `server/accounting.mjs` / `server/import-incremental.mjs`，
 * 不连接、不创建任何默认真实数据目录，也不使用真实账套或凭据（全合成）。
 *
 * 覆盖：
 *  - 受保护组件初始化：空库安装、重复安装幂等、既有业务库拒绝安装（业务与 schema 不变）、
 *    初始化故障整体回滚、缺表 / 坏版本 / 非数据库文件拒绝、只读打开不创建文件；
 *  - 真实 SQLite：业务行与成功事件同事务提交；事件写入故障使两者全部回滚；
 *    外层 BEGIN + 内层 SAVEPOINT 后外层失败；提交结果不明确不伪造成功；重启后仍可查询；
 *  - 去重：同 operation/attempt 相同事件一条、同键不同数据冲突、不同 attempt 分别保留、
 *    post/unpost/post 不被粗糙去重；
 *  - 留痕：业务对象不存在 / 删除后事件保留、两账套不串数据、分页稳定、非法过滤与注入失败；
 *  - 隐私：合成敏感哨兵（payload / 摘要 / 名称 / 用户 batchId / error.message / code / details /
 *    stack / 未知 metadata）不进数据库、不进错误信息、不进 CLI 输出；
 *  - 恢复分叉实例（note 固定枚举）、append-only（含默认连接下的 INSERT OR REPLACE 防护）、
 *    同名无效触发器识别、内容摘要篡改检测与 CLI schema 完整结构断言。
 *
 * 运行（在 06-workbench 目录）：`node test/local-audit.test.mjs`
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const workbenchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "wb-local-audit-"));

// 必须在导入被测模块之前锁定临时数据目录（任务要求）。
process.env.WORKBENCH_DATA_DIR = dataDir;
if (process.env.WORKBENCH_DATA_DIR !== dataDir) throw new Error("WORKBENCH_DATA_DIR 未锁定到临时目录");

const LA = await import("../server/local-audit.mjs");
const LS = await import("../server/local-audit-storage.mjs");

/** 合成敏感哨兵：不得出现在数据库、错误信息或 CLI 输出。 */
const SENTINEL = "SYNTH-91350000ZZ0001X-张合成-2026Q1-payload";
const SENTINEL2 = "SYNTH-BATCH-用户批次-敏感-0002";
/** 初审复现值：实例分叉 note 曾可把本机敏感路径直接持久化。 */
const SENTINEL_PATH = "C:\\private\\customer-secret.db";

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e && e.message}`); }
};

const DB_NAMES = new Set();
const FILES = [];
const OPEN_DBS = [];
let fileSeq = 0;
const newPath = (prefix = "workbench") => {
  fileSeq += 1;
  const name = `${prefix}-${fileSeq}.db`;
  DB_NAMES.add(name);
  return join(dataDir, name);
};

/** 打开一个临时库（不安装审计结构）。 */
function rawDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  FILES.push(file);
  OPEN_DBS.push(db);
  return db;
}

/** 安装审计组件 + 业务表（先装审计再建业务表，模拟 B 包接线后的同一个库）。 */
function auditDbWithBusiness(file = newPath()) {
  const db = rawDb(file);
  LS.ensureAuditSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS account_sets (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL
           )`);
  db.exec(`CREATE TABLE IF NOT EXISTS vouchers (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_set_id INTEGER NOT NULL,
             summary TEXT
           )`);
  return { db, file };
}

const countEvents = (db) => Number(db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get().n);
const insertBusiness = (db, name = "合成账套", summary = "合成凭证") => {
  const info = db.prepare(`INSERT INTO account_sets (name) VALUES (?)`).run(name);
  const setId = Number(info.lastInsertRowid);
  const v = db.prepare(`INSERT INTO vouchers (account_set_id, summary) VALUES (?,?)`).run(setId, summary);
  return { setId, voucherId: Number(v.lastInsertRowid) };
};
const ctx = (over = {}) => LA.createOperationContext({
  operationId: "op-0001", actor: "domain", action: "voucher.post", attempt: 1, ...over,
});

/** 基础事件：同一 operation/attempt/action/目标 → 同一去重键。 */
const baseEvent = (over = {}) => ({
  outcome: "succeeded",
  resultCode: "voucher_post_succeeded",
  ...over,
});

/** 整库文本转储（先关闭写连接，避免 WAL 未合并）：用于敏感哨兵扫描。 */
function dumpDatabases() {
  const chunks = [];
  for (const file of FILES) {
    if (!existsSync(file)) continue;
    chunks.push(readFileSync(file).toString("utf8"));
    const probe = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = probe.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();
      for (const row of tables) chunks.push(JSON.stringify(probe.prepare(`SELECT * FROM "${row.name}"`).all()));
    } finally {
      probe.close();
    }
  }
  return chunks.join("\n");
}

const runCli = (args) => spawnSync(process.execPath, [join(workbenchDir, "scripts", "local-audit.mjs"), ...args], {
  cwd: workbenchDir,
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir },
  encoding: "utf8",
});

try {
  // ---------------------------------------------------------------- 初始化与结构
  test("模块 import 无默认库 / 目录副作用，且不依赖 db.mjs / accounting.mjs", () => {
    for (const rel of ["server/local-audit.mjs", "server/local-audit-storage.mjs", "server/local-restore-audit.mjs"]) {
      const source = readFileSync(join(workbenchDir, rel), "utf8");
      for (const forbidden of [`from "./db.mjs"`, `from "./accounting.mjs"`, `"../server/db.mjs"`]) {
        assert.equal(source.includes(forbidden), false, `${rel} 不得 import ${forbidden}`);
      }
    }
    assert.equal(existsSync(join(workbenchDir, "data", "workbench.db")), false, "不得创建默认真实数据目录的库");
    assert.deepEqual(LS.inspectAuditSchema(rawDb(newPath("empty"))).present, []);
  });

  test("新库受保护初始化：结构 / 版本 / 活动实例 / append-only 触发器", () => {
    const file = newPath();
    const db = rawDb(file);
    const out = LS.ensureAuditSchema(db);
    assert.equal(out.installed, true);
    assert.equal(out.from, 0);
    assert.equal(out.to, LA.AUDIT_SCHEMA_VERSION);
    const state = LS.inspectAuditSchema(db);
    assert.deepEqual(state.present, [...LS.AUDIT_TABLES]);
    assert.equal(state.version, LA.AUDIT_SCHEMA_VERSION);
    assert.ok(state.activeInstanceId, "必须有活动实例");
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all().map((r) => r.name);
    for (const name of LS.AUDIT_TRIGGERS) assert.ok(triggers.includes(name), `缺少触发器 ${name}`);
    // 组件安装记录与实例登记都是真库里的行，不是内存标志。
    const component = db.prepare(`SELECT component, version FROM audit_components`).all();
    assert.deepEqual(component.map((r) => [r.component, Number(r.version)]), [[LA.AUDIT_COMPONENT, LA.AUDIT_SCHEMA_VERSION]]);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_database_instances WHERE is_active=1`).get().n, 1);
  });

  test("重复初始化不重建、不重复写版本；含业务表后再检查仍幂等", () => {
    const file = newPath();
    const db = rawDb(file);
    LS.ensureAuditSchema(db);
    const instance = LS.currentAuditInstanceId(db);
    const again = LS.ensureAuditSchema(db);
    assert.equal(again.installed, false);
    assert.equal(again.activeInstanceId, instance);
    db.exec(`CREATE TABLE account_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    db.prepare(`INSERT INTO account_sets (name) VALUES ('合成公司')`).run();
    const third = LS.ensureAuditSchema(db);
    assert.equal(third.installed, false);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_components`).get().n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, 1);
  });

  test("既有业务库拒绝安装：业务行与 schema 都不变（布尔值无法绕过）", () => {
    const file = newPath("existing");
    const db = rawDb(file);
    db.exec(`CREATE TABLE account_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    db.exec(`CREATE TABLE vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER, summary TEXT)`);
    db.prepare(`INSERT INTO account_sets (name) VALUES ('合成既有公司')`).run();
    const tablesBefore = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
    const rowsBefore = db.prepare(`SELECT * FROM account_sets ORDER BY id`).all();
    for (const attempt of [() => LS.ensureAuditSchema(db), () => LS.ensureAuditSchema(db, { freshDatabase: true })]) {
      assert.throws(attempt, (e) => e.code === "audit_install_requires_verified_backup");
    }
    assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all(), tablesBefore);
    assert.deepEqual(db.prepare(`SELECT * FROM account_sets ORDER BY id`).all(), rowsBefore);
    assert.deepEqual(LS.inspectAuditSchema(db).present, [], "拒绝后不得留下半截审计对象");
  });

  test("初始化故障整体回滚；重试可成功且不残留半截对象", () => {
    const file = newPath();
    const db = rawDb(file);
    assert.throws(
      () => LS.ensureAuditSchema(db, { faultInjection: () => { throw new Error("injected_init_failure"); } }),
      (e) => e.code === "audit_schema_install_failed",
    );
    assert.deepEqual(LS.inspectAuditSchema(db).present, []);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type IN ('table','trigger') AND name LIKE 'audit_%'`).get().n, 0);
    const retry = LS.ensureAuditSchema(db);
    assert.equal(retry.installed, true);
    assert.equal(LS.inspectAuditSchema(db).version, LA.AUDIT_SCHEMA_VERSION);
  });

  test("缺表 / 坏版本拒绝（不静默修复）", () => {
    const partial = rawDb(newPath("partial"));
    LS.ensureAuditSchema(partial);
    partial.exec(`DROP TABLE audit_database_instances`);
    assert.throws(() => LS.ensureAuditSchema(partial), (e) => e.code === "audit_schema_inconsistent");
    assert.throws(() => LS.assertAuditSchema(partial), (e) => e.code === "audit_schema_inconsistent");

    const newer = rawDb(newPath("newer"));
    LS.ensureAuditSchema(newer);
    newer.prepare(`UPDATE audit_components SET version=? WHERE component=?`).run(LA.AUDIT_SCHEMA_VERSION + 1, LA.AUDIT_COMPONENT);
    assert.throws(() => LS.ensureAuditSchema(newer), (e) => e.code === "audit_schema_newer");
    assert.throws(() => LS.queryAuditEvents(newer, {}), (e) => e.code === "audit_schema_newer");

    const noTriggers = rawDb(newPath("notrigger"));
    LS.ensureAuditSchema(noTriggers);
    noTriggers.exec(`DROP TRIGGER audit_events_no_update`);
    assert.throws(() => LS.assertAuditSchema(noTriggers), (e) => e.code === "audit_schema_inconsistent");

    const noVersion = rawDb(newPath("noversion"));
    LS.ensureAuditSchema(noVersion);
    noVersion.prepare(`DELETE FROM audit_components`).run();
    assert.throws(() => LS.ensureAuditSchema(noVersion), (e) => e.code === "audit_schema_inconsistent");
  });

  test("只读打开：缺文件不创建、非数据库文件拒绝；CLI 不建库", () => {
    const missing = join(dataDir, "never-created.db");
    assert.throws(() => LS.openAuditDatabase(missing, { readOnly: true }), (e) => e.code === "audit_database_missing");
    assert.equal(existsSync(missing), false);
    assert.equal(runCli(["events", "--db", missing]).status, 3);
    assert.equal(existsSync(missing), false, "CLI 查询不得创建库");

    const corrupt = join(dataDir, "corrupt.db");
    writeFileSync(corrupt, "这不是一个 SQLite 数据库".repeat(20));
    assert.throws(() => LS.openAuditDatabase(corrupt, { readOnly: true }), (e) => e.code === "audit_database_invalid");
    assert.equal(runCli(["schema", "--db", corrupt]).status, 3);
  });

  // ---------------------------------------------------------------- 事务与原子性
  test("真实 SQLite：业务行与成功事件同事务提交，重启后仍可查询", () => {
    const { db, file } = auditDbWithBusiness();
    const out = LS.runAuditedOperation(
      db,
      { context: ctx({ operationId: "op-commit-1", accountSetId: 1 }), terminal: baseEvent() },
      () => insertBusiness(db, "合成提交公司", "同事务凭证"),
    );
    assert.equal(out.appended, true);
    assert.equal(countEvents(db), 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 1);
    db.close();

    const reopened = new DatabaseSync(file);
    LS.assertAuditSchema(reopened);
    assert.equal(countEvents(reopened), 1);
    const page = LS.queryAuditEvents(reopened, { operationId: "op-commit-1" });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].outcome, "succeeded");
    assert.equal(page.events[0].resultCode, "voucher_post_succeeded");
    assert.equal(reopened.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 1);
    reopened.close();
  });

  test("终态事件写入故障（触发器 RAISE）：业务与成功事件全部回滚，仅留固定失败事件", () => {
    const { db } = auditDbWithBusiness();
    db.exec(`CREATE TRIGGER inject_success_event_failure BEFORE INSERT ON audit_events
             WHEN NEW.result_code = 'voucher_post_succeeded'
             BEGIN SELECT RAISE(ABORT, 'injected_event_failure'); END`);
    let thrown = null;
    try {
      LS.runAuditedOperation(
        db,
        { context: ctx({ operationId: "op-event-fail-1", accountSetId: 1 }), terminal: baseEvent() },
        () => insertBusiness(db, "合成故障公司", "不得提交的凭证"),
      );
    } catch (e) { thrown = e; }
    db.exec(`DROP TRIGGER inject_success_event_failure`);
    assert.ok(thrown, "事件写入失败必须抛出");
    assert.equal(thrown.code, "audit_write_failed");
    assert.equal(thrown.businessRolledBack, true);
    assert.equal(thrown.auditPersisted, true, "失败事件本身已落库");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 0, "业务必须整体回滚");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, 0);
    assert.equal(countEvents(db), 1);
    const only = LS.queryAuditEvents(db, {}).events[0];
    assert.equal(only.outcome, "failed");
    assert.equal(only.reasonCode, "audit_write_failed");
    assert.equal(only.operationId, "op-event-fail-1");
    assert.equal(only.resultCode, "audit_unavailable");
  });

  test("审计完全不可写：业务回滚并明确返回 audit_unavailable（不报成功）", () => {
    const { db } = auditDbWithBusiness();
    db.exec(`CREATE TRIGGER block_all_audit_writes BEFORE INSERT ON audit_events
             BEGIN SELECT RAISE(ABORT, 'audit_io_failure'); END`);
    let thrown = null;
    try {
      LS.runAuditedOperation(
        db,
        { context: ctx({ operationId: "op-audit-down-1", accountSetId: 1 }), terminal: baseEvent() },
        () => insertBusiness(db, "合成不可审计公司", "不得提交"),
      );
    } catch (e) { thrown = e; }
    db.exec(`DROP TRIGGER block_all_audit_writes`);
    assert.ok(thrown);
    assert.equal(thrown.code, "audit_unavailable");
    assert.equal(thrown.auditPersisted, false);
    assert.equal(thrown.businessRolledBack, true);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 0);
    assert.equal(countEvents(db), 0);
  });

  test("外层 BEGIN + 内层 SAVEPOINT 后外层失败：业务与成功审计均无，回滚后仅固定失败事件", () => {
    const { db, file } = auditDbWithBusiness();
    const outer = ctx({ operationId: "op-outer-1", action: "batch.job", actor: "batch" });
    const inner = LA.createChildOperation(outer, { operationId: "op-inner-1", action: "voucher.post", accountSetId: 1 });

    let outerError = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      LS.runAuditedOperation(db, { context: outer, terminal: { outcome: "succeeded", resultCode: "batch_job_succeeded" } }, () => {
        LS.runAuditedOperation(db, { context: inner, terminal: baseEvent() }, () => insertBusiness(db, "合成外层公司", "内层凭证"));
        throw Object.assign(new Error("outer failed"), { code: "period_closed" });
      });
    } catch (e) { outerError = e; }
    db.exec("ROLLBACK");

    assert.ok(outerError, "外层失败必须抛出");
    assert.equal(outerError.code, "period_closed");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 0, "内层业务必须随外层回滚");
    assert.equal(countEvents(db), 0, "成功事件不得比外层事务更早落库");

    const written = LS.appendDeferredFailure(db, outerError);
    assert.equal(written.outcome, "rejected");
    assert.equal(written.resultCode, "blocked_period_closed");
    assert.equal(countEvents(db), 1);
    db.close();

    const reopened = new DatabaseSync(file);
    LS.assertAuditSchema(reopened);
    const events = LS.queryAuditEvents(reopened, {}).events;
    assert.equal(events.length, 1, "重启后只有固定失败事件");
    assert.equal(events[0].operationId, "op-outer-1");
    assert.equal(events[0].outcome, "rejected");
    assert.equal(reopened.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 0);
    reopened.close();
  });

  test("提交结果不明确：返回 audit_commit_unknown，既不伪造 succeeded 也不写失败事件", () => {
    const { db } = auditDbWithBusiness();
    let thrown = null;
    try {
      LS.runAuditedOperation(
        db,
        { context: ctx({ operationId: "op-commit-unknown-1", accountSetId: 1 }), terminal: baseEvent() },
        () => insertBusiness(db, "合成不确定公司", "提交不确定"),
        { testHooks: { commit: () => { throw new Error("disk I/O error"); } } },
      );
    } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.equal(thrown.code, "audit_commit_unknown");
    assert.equal(thrown.auditPersisted, false);
    assert.equal(db.isTransaction, false, "提交失败后不得留下悬挂事务");
    assert.equal(countEvents(db), 0, "不得把失败事件写成「业务已回滚」");
  });

  test("保存点外层的业务失败仍由最外层统一留痕（嵌套不重复写成功）", () => {
    const { db } = auditDbWithBusiness();
    const outer = ctx({ operationId: "op-batch-2", action: "batch.job", actor: "batch" });
    const innerOk = LA.createChildOperation(outer, { operationId: "op-item-ok", action: "voucher.post", accountSetId: 1 });
    const innerBad = LA.createChildOperation(outer, { operationId: "op-item-bad", action: "voucher.post", accountSetId: 1 });

    LS.runAuditedOperation(db, { context: outer, terminal: { outcome: "succeeded", resultCode: "batch_job_succeeded" } }, () => {
      LS.runAuditedOperation(db, { context: innerOk, terminal: baseEvent() }, () => insertBusiness(db));
      const badError = Object.assign(new Error("bad item"), { code: "voucher_not_found" });
      assert.throws(
        () => LS.runAuditedOperation(db, { context: innerBad, terminal: baseEvent() }, () => { throw badError; }),
        (e) => e.code === "voucher_not_found",
      );
      const failureEvent = LS.appendDeferredFailure(db, badError);
      assert.equal(failureEvent.outcome, "rejected");
      assert.equal(failureEvent.resultCode, "not_found");
      return { ok: true };
    });

    const events = LS.queryAuditEvents(db, {}).events;
    assert.deepEqual(events.map((e) => [e.operationId, e.outcome]), [
      ["op-item-ok", "succeeded"],
      ["op-item-bad", "rejected"],
      ["op-batch-2", "succeeded"],
    ]);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 1, "成功项的业务不受失败项影响");
  });

  // ---------------------------------------------------------------- 去重语义
  test("事务外 append 被拒绝：成功事件必须写进外层业务事务", () => {
    const { db } = auditDbWithBusiness();
    assert.throws(
      () => LS.appendAuditEvent(db, baseEvent(), { context: ctx({ operationId: "op-outside-tx", accountSetId: 1 }) }),
      (e) => e.code === "audit_transaction_required",
    );
    assert.equal(countEvents(db), 0);
  });

  test("同 operation/attempt 相同事件一条；同键不同数据拒绝；不同 attempt 分别保留", () => {
    const { db } = auditDbWithBusiness();
    const context = ctx({ operationId: "op-dedupe-1", accountSetId: 1 });
    const first = LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context })).result;
    assert.equal(first.appended, true);
    const second = LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context })).result;
    assert.equal(second.appended, false);
    assert.equal(second.event.seq, first.event.seq);
    assert.equal(countEvents(db), 1);

    assert.throws(
      () => LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent({ resultCode: "no_change" }), { context })),
      (e) => e.code === "audit_event_conflict",
    );
    assert.equal(countEvents(db), 1, "冲突不得写入第二条");

    const attempt2 = LA.runInTransaction(db, () => LS.appendAuditEvent(
      db, baseEvent({ outcome: "failed", resultCode: "failed", reasonCode: "internal_error" }), { context: LA.withAttempt(context, 2) },
    )).result;
    const attempt3 = LA.runInTransaction(db, () => LS.appendAuditEvent(
      db, baseEvent({ outcome: "failed", resultCode: "failed", reasonCode: "validation_failed" }), { context: LA.withAttempt(context, 3) },
    )).result;
    assert.equal(attempt2.appended, true);
    assert.equal(attempt3.appended, true);
    const attempts = LS.queryAuditEvents(db, {}).events.map((e) => e.attempt);
    assert.deepEqual(attempts, [1, 2, 3]);
  });

  test("post → unpost → post 是三次实际动作，不被粗糙去重", () => {
    const { db } = auditDbWithBusiness();
    const base = { operationId: "op-cycle-1", actor: "http", accountSetId: 1, voucherId: 7 };
    const steps = [
      { action: "voucher.post", attempt: 1, outcome: "succeeded", resultCode: "voucher_post_succeeded" },
      { action: "voucher.unpost", attempt: 2, outcome: "succeeded", resultCode: "voucher_unpost_succeeded" },
      { action: "voucher.post", attempt: 3, outcome: "succeeded", resultCode: "voucher_post_succeeded" },
    ];
    for (const step of steps) {
      const context = LA.createOperationContext({ ...base, action: step.action, attempt: step.attempt });
      LA.runInTransaction(db, () => LS.appendAuditEvent(db, step, { context }));
    }
    const events = LS.queryAuditEvents(db, {}).events;
    assert.deepEqual(events.map((e) => [e.action, e.attempt]), [
      ["voucher.post", 1], ["voucher.unpost", 2], ["voucher.post", 3],
    ]);
  });

  // ---------------------------------------------------------------- 留痕与范围
  test("业务对象不存在 / 被删除后审计保留（事件无外键，不随业务级联删除）", () => {
    const { db } = auditDbWithBusiness();
    const { setId, voucherId } = insertBusiness(db, "合成删除公司", "将被删除的凭证");
    const context = ctx({ operationId: "op-retain-1", accountSetId: 999, voucherId: 1234 });
    const written = LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context })).result;
    assert.equal(written.appended, true, "不存在的业务对象也必须能留痕");

    const live = LA.createOperationContext({ operationId: "op-retain-2", actor: "domain", action: "voucher.post", accountSetId: setId, voucherId });
    LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context: live }));
    db.prepare(`DELETE FROM vouchers WHERE id=?`).run(voucherId);
    db.prepare(`DELETE FROM account_sets WHERE id=?`).run(setId);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 0);
    assert.equal(countEvents(db), 2, "删除业务对象不得删除审计事件");
    assert.equal(LS.queryAuditEvents(db, { voucherId }).events.length, 1);
  });

  test("两账套查询不串数据", () => {
    const { db } = auditDbWithBusiness();
    for (const setId of [11, 22]) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const context = LA.createOperationContext({
          operationId: `op-scope-${setId}`, actor: "domain", action: "voucher.post", accountSetId: setId, attempt,
        });
        LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context }));
      }
    }
    const only11 = LS.queryAuditEvents(db, { accountSetId: 11 }).events;
    const only22 = LS.queryAuditEvents(db, { accountSetId: 22 }).events;
    assert.equal(only11.length, 3);
    assert.equal(only22.length, 3);
    assert.ok(only11.every((e) => e.accountSetId === 11));
    assert.ok(only22.every((e) => e.accountSetId === 22));
    assert.deepEqual(only11.map((e) => e.seq).filter((seq) => only22.some((x) => x.seq === seq)), []);
  });

  test("分页无重复 / 无遗漏；limit 有上限；非法过滤失败", () => {
    const { db } = auditDbWithBusiness();
    for (let attempt = 1; attempt <= 23; attempt += 1) {
      const context = LA.createOperationContext({
        operationId: "op-page-1", actor: "domain", action: "voucher.post", accountSetId: 5, attempt,
        period: `2026-${String((attempt % 12) + 1).padStart(2, "0")}`,
      });
      LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context }));
    }
    const seen = [];
    let cursor = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = LS.queryAuditEvents(db, { limit: 7, afterSeq: cursor });
      seen.push(...page.events.map((e) => e.seq));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23, "分页不得重复");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "分页保持固定 seq 升序");

    assert.throws(() => LS.queryAuditEvents(db, { limit: 501 }), (e) => e.code === "audit_filter_invalid");
    assert.throws(() => LS.queryAuditEvents(db, { limit: 0 }), (e) => e.code === "audit_filter_invalid");
    assert.throws(() => LS.queryAuditEvents(db, { limit: 1.5 }), (e) => e.code === "audit_filter_invalid");
    assert.throws(() => LS.queryAuditEvents(db, { afterSeq: "5" }), (e) => e.code === "audit_filter_invalid");
    assert.throws(() => LS.queryAuditEvents(db, { action: "voucher.delete" }), (e) => e.code === "audit_filter_invalid");
    assert.throws(() => LS.queryAuditEvents(db, { accountSetId: "5" }), (e) => e.code === "audit_filter_invalid");
    assert.throws(() => LS.queryAuditEvents(db, { metadata: "anything" }), (e) => e.code === "audit_filter_invalid");
  });

  test("SQL 注入尝试被拒绝且不影响数据（全部参数化）", () => {
    const { db } = auditDbWithBusiness();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const context = LA.createOperationContext({
        operationId: "op-inject-1", actor: "domain", action: "voucher.post", accountSetId: 3, attempt,
      });
      LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context }));
    }
    const injections = [
      "2026-01' OR 1=1 --",
      "2026-01; DROP TABLE audit_events; --",
      "2026-01' UNION SELECT * FROM audit_events --",
    ];
    for (const period of injections) {
      assert.throws(() => LS.queryAuditEvents(db, { period }), (e) => e.code === "audit_filter_invalid");
    }
    assert.throws(() => LS.queryAuditEvents(db, { resultCode: `ok' OR '1'='1` }), (e) => e.code === "audit_filter_invalid");
    assert.throws(() => LS.queryAuditEvents(db, { operationId: `op-1' OR 1=1 --` }), (e) => e.code === "audit_filter_invalid");
    assert.equal(countEvents(db), 4, "注入尝试不得改动或泄漏数据");
    assert.equal(LS.queryAuditEvents(db, { accountSetId: 3 }).events.length, 4);
  });

  // ---------------------------------------------------------------- 隐私
  test("敏感哨兵：未知字段 / 用户标识 / 异常文本一律不进审计", () => {
    const { db } = auditDbWithBusiness();
    const context = ctx({ operationId: "op-privacy-1", accountSetId: 1 });

    const badEvents = [
      { ...baseEvent(), payload: { raw: SENTINEL } },
      { ...baseEvent(), summary: SENTINEL },
      { ...baseEvent(), name: SENTINEL },
      { ...baseEvent(), batchId: SENTINEL2 },
      { ...baseEvent(), metadata: { note: SENTINEL } },
      { ...baseEvent(), errorMessage: SENTINEL },
      { ...baseEvent(), stack: SENTINEL },
      { ...baseEvent(), error: { message: SENTINEL, code: SENTINEL, details: SENTINEL, stack: SENTINEL } },
      { ...baseEvent(), resultCode: SENTINEL },
      { ...baseEvent(), reasonCode: SENTINEL },
      { ...baseEvent(), correlation: SENTINEL },
      { ...baseEvent(), accountSetId: SENTINEL },
      { ...baseEvent(), period: SENTINEL },
      { ...baseEvent(), attempt: SENTINEL },
    ];
    for (const raw of badEvents) {
      let thrown = null;
      try { LA.runInTransaction(db, () => LS.appendAuditEvent(db, raw, { context })); } catch (e) { thrown = e; }
      assert.ok(thrown, "非法事件必须被拒绝");
      assert.ok(
        ["audit_event_invalid", "audit_event_context_mismatch"].includes(thrown.code),
        `未预期的拒绝码：${thrown.code}`,
      );
      const serialized = `${thrown.message} ${JSON.stringify(thrown.details ?? {})}`;
      assert.equal(serialized.includes(SENTINEL), false, "错误信息不得回显哨兵");
      assert.equal(serialized.includes(SENTINEL2), false);
    }
    // 技术 ID 校验：用户可改标识不能冒充内部 ID。
    assert.throws(() => LA.createOperationContext({ operationId: SENTINEL, actor: "domain", action: "voucher.post" }),
      (e) => e.code === "audit_operation_invalid");
    assert.throws(() => LA.createOperationContext({
      operationId: "op-ok", actor: "domain", action: "voucher.post", jobId: SENTINEL,
    }), (e) => e.code === "audit_operation_invalid");
    assert.throws(() => LA.correlationToken({ raw: SENTINEL }), (e) => e.code === "audit_operation_invalid");

    // 合法路径：用户标识只以服务端哈希令牌落库。
    const token = LA.correlationToken(SENTINEL2);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(token.includes(SENTINEL2), false);
    const okContext = ctx({ operationId: "op-privacy-2", accountSetId: 1, correlation: token });
    LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context: okContext }));

    // 异常码不在 allowlist → 固定 internal_error（不透传原文）。
    assert.deepEqual(
      LA.classifyFailure(Object.assign(new Error(SENTINEL), { code: SENTINEL, stack: SENTINEL, details: { a: SENTINEL } })),
      { outcome: "failed", resultCode: "internal_error", reasonCode: "internal_error" },
    );

    // 失败事件走真实失败路径：原始 message / code / stack 都不落库。
    let failure = null;
    try {
      LS.runAuditedOperation(
        db,
        { context: ctx({ operationId: "op-privacy-3", accountSetId: 1 }), terminal: baseEvent() },
        () => { throw Object.assign(new Error(SENTINEL), { code: SENTINEL2, details: { raw: SENTINEL } }); },
      );
    } catch (e) { failure = e; }
    assert.ok(failure);
    assert.equal(failure.code, SENTINEL2, "业务异常原样抛回（不篡改领域错误码）");
    assert.equal(failure.auditEvent.resultCode, "internal_error", "未知错误码固定映射，不透传原文");
    assert.equal(failure.auditEvent.reasonCode, "internal_error");
    assert.equal(countEvents(db), 2);
  });

  test("恢复分叉实例：旧事件不改写、新事件用新实例、重复幂等、父实例不符拒绝", () => {
    const { db } = auditDbWithBusiness();
    const parent = LS.currentAuditInstanceId(db);
    const context = ctx({ operationId: "op-instance-1", accountSetId: 1 });
    LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context }));

    const fork = LS.markAuditInstanceFork(db, { parentInstanceId: parent });
    assert.equal(fork.created, true);
    assert.notEqual(fork.instanceId, parent);
    assert.equal(LS.currentAuditInstanceId(db), fork.instanceId);
    const again = LS.markAuditInstanceFork(db, { parentInstanceId: parent });
    assert.equal(again.created, false);
    assert.equal(again.instanceId, fork.instanceId);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_database_instances`).get().n, 2);

    const forkContext = ctx({ operationId: "op-instance-2", accountSetId: 1 });
    LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context: forkContext }));
    const events = LS.queryAuditEvents(db, {}).events;
    assert.equal(events[0].databaseInstanceId, parent, "旧历史事件不改写");
    assert.equal(events[1].databaseInstanceId, fork.instanceId);
    assert.throws(() => LS.markAuditInstanceFork(db, { parentInstanceId: "not-the-active-one" }),
      (e) => e.code === "audit_instance_conflict");
    const instances = LS.listAuditInstances(db);
    assert.equal(instances.filter((i) => i.isActive).length, 1);
    assert.equal(instances.find((i) => i.isActive).parentInstanceId, parent);
  });

  test("实例分叉 note 只接受固定技术枚举：自由文本 / 本机路径拒绝且不入库、不回显", () => {
    const { db, file } = auditDbWithBusiness();
    const parent = LS.currentAuditInstanceId(db);
    for (const bad of [SENTINEL_PATH, SENTINEL, "restore-new ", ""]) {
      let thrown = null;
      try { LS.markAuditInstanceFork(db, { parentInstanceId: parent, note: bad }); } catch (e) { thrown = e; }
      assert.ok(thrown, "自由 note 必须被拒绝");
      assert.equal(thrown.code, "audit_operation_invalid");
      assert.deepEqual(thrown.details, { field: "note" }, "错误只给字段名，不回显原值");
      const serialized = `${thrown.message} ${JSON.stringify(thrown.details ?? {})}`;
      if (bad) assert.equal(serialized.includes(bad), false, "错误信息不得回显 note 原值");
    }
    // 未产生任何分叉实例 / 未落库任何自由文本。
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_database_instances`).get().n, 1);
    // 数据库 CHECK 约束兜底：直接 SQL 写自由文本同样失败。
    assert.throws(() => db.prepare(`UPDATE audit_database_instances SET note_code=?`).run(SENTINEL_PATH));
    // 合法枚举仍可正常恢复分叉。
    const fork = LS.markAuditInstanceFork(db, { parentInstanceId: parent, note: "restore-new" });
    assert.equal(fork.created, true);
    assert.deepEqual(
      db.prepare(`SELECT note_code FROM audit_database_instances ORDER BY note_code`).all().map((r) => r.note_code),
      ["initial", "restore-new"],
    );
    const cli = runCli(["instances", "--db", file]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(`${cli.stdout}${cli.stderr}`.includes(SENTINEL_PATH), false, "CLI 不得输出分叉 note 原文");
  });

  test("默认 recursive_triggers=0 下也不能用 INSERT OR REPLACE 替换历史事件", () => {
    const { db } = auditDbWithBusiness();
    assert.equal(Number(db.prepare(`PRAGMA recursive_triggers`).get().recursive_triggers), 0);
    const context = ctx({ operationId: "op-replace-1", accountSetId: 1 });
    LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context }));
    const before = LS.queryAuditEvents(db, {}).events[0];
    const row = db.prepare(`SELECT * FROM audit_events WHERE seq=?`).get(before.seq);

    // 初审复现：读原行、只改 event_id，按原 seq / dedupe_key 插回 → 旧事件会消失。
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO audit_events
        (seq,event_id,dedupe_key,database_instance_id,occurred_at,action,outcome,result_code,reason_code,
         actor,operation_id,parent_operation_id,attempt,account_set_id,voucher_id,period,job_id,item_id,
         stage_id,correlation,content_digest)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.seq, "11111111-1111-4111-8111-111111111111", row.dedupe_key, row.database_instance_id,
      row.occurred_at, row.action, "failed", row.result_code, row.reason_code, row.actor, row.operation_id,
      row.parent_operation_id, row.attempt, row.account_set_id, row.voucher_id, row.period, row.job_id,
      row.item_id, row.stage_id, row.correlation, row.content_digest,
    ));
    assert.deepEqual(LS.queryAuditEvents(db, {}).events[0], before, "原事件必须原样保留");
    assert.deepEqual(LS.verifyAuditEvents(db), { checked: 1, mismatched: [] });

    // 合法幂等 / 事务不受影响：同事件重放仍是 appended:false。
    const again = LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context })).result;
    assert.equal(again.appended, false);
    assert.equal(again.event.seq, before.seq);
    assert.equal(countEvents(db), 1);

    // 同名但无效的触发器不能被当成已保护。
    db.exec(`DROP TRIGGER audit_events_no_delete`);
    db.exec(`CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT 1; END`);
    assert.throws(() => LS.assertAuditSchema(db), (e) => e.code === "audit_schema_inconsistent");
    assert.throws(() => LS.queryAuditEvents(db, {}), (e) => e.code === "audit_schema_inconsistent");
  });

  test("CLI schema 做完整结构断言：更高版本 unsupported、缺触发器 / 缺列 invalid，均 exit 3 且不改库", () => {
    const { db, file } = auditDbWithBusiness();
    db.prepare(`UPDATE audit_components SET version=? WHERE component=?`)
      .run(LA.AUDIT_SCHEMA_VERSION + 1, LA.AUDIT_COMPONENT);
    const newer = runCli(["schema", "--db", file]);
    assert.equal(newer.status, 3, newer.stderr);
    const newerOut = JSON.parse(newer.stdout);
    assert.equal(newerOut.ok, false);
    assert.equal(newerOut.state, "unsupported");
    assert.equal(newerOut.version, LA.AUDIT_SCHEMA_VERSION + 1);
    assert.equal(
      Number(db.prepare(`SELECT version FROM audit_components WHERE component=?`).get(LA.AUDIT_COMPONENT).version),
      LA.AUDIT_SCHEMA_VERSION + 1,
      "只读 schema 不得修改库",
    );

    db.prepare(`UPDATE audit_components SET version=? WHERE component=?`)
      .run(LA.AUDIT_SCHEMA_VERSION, LA.AUDIT_COMPONENT);
    db.exec(`DROP TRIGGER audit_events_no_delete`);
    const invalid = runCli(["schema", "--db", file]);
    assert.equal(invalid.status, 3, invalid.stderr);
    const invalidOut = JSON.parse(invalid.stdout);
    assert.equal(invalidOut.ok, false);
    assert.equal(invalidOut.state, "invalid");
    assert.ok(invalidOut.problems.includes("missing_triggers"));
    const triggerNames = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all().map((r) => r.name);
    assert.equal(triggerNames.includes("audit_events_no_delete"), false, "只读 schema 不得修复触发器");

    // 缺列同样先结构检查、给 invalid，而不是原始 SQLite 错误。
    const noColumn = auditDbWithBusiness();
    noColumn.db.exec(`ALTER TABLE audit_events DROP COLUMN stage_id`);
    const missing = runCli(["schema", "--db", noColumn.file]);
    assert.equal(missing.status, 3, missing.stderr);
    const missingOut = JSON.parse(missing.stdout);
    assert.equal(missingOut.state, "invalid");
    assert.ok(missingOut.problems.includes("missing_columns"));
    assert.throws(() => LS.queryAuditEvents(noColumn.db, {}), (e) => e.code === "audit_schema_inconsistent");

    const ok = runCli(["schema", "--db", auditDbWithBusiness().file]);
    assert.equal(ok.status, 0, ok.stderr);
    const okOut = JSON.parse(ok.stdout);
    assert.equal(okOut.ok, true);
    assert.equal(okOut.state, "ok");
  });

  test("append-only 与内容摘要：改写 / 删除被拒，绕过触发器后可被完整性自检发现", () => {
    const { db } = auditDbWithBusiness();
    const context = ctx({ operationId: "op-integrity-1", accountSetId: 1, period: "2026-01" });
    LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context }));
    assert.throws(() => db.prepare(`UPDATE audit_events SET result_code='no_change'`).run());
    assert.throws(() => db.prepare(`DELETE FROM audit_events`).run());
    assert.deepEqual(LS.verifyAuditEvents(db), { checked: 1, mismatched: [] });

    // 模拟数据库文件被外部改写（绕过触发器）：摘要自检必须发现不一致。
    db.exec(`DROP TRIGGER audit_events_no_update`);
    db.prepare(`UPDATE audit_events SET result_code='no_change'`).run();
    db.exec(`CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
             BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`);
    const verified = LS.verifyAuditEvents(db);
    assert.equal(verified.checked, 1);
    assert.deepEqual(verified.mismatched, [1]);
  });

  // ---------------------------------------------------------------- CLI 只读
  test("CLI 只读查询：schema / events / verify / stats 正确且不回显敏感值", () => {
    const { db, file } = auditDbWithBusiness();
    const token = LA.correlationToken(SENTINEL2);
    const context = ctx({ operationId: "op-cli-1", accountSetId: 42, correlation: token });
    LA.runInTransaction(db, () => LS.appendAuditEvent(db, baseEvent(), { context }));
    db.close();

    const schema = runCli(["schema", "--db", file]);
    assert.equal(schema.status, 0, schema.stderr);
    const schemaOut = JSON.parse(schema.stdout);
    assert.equal(schemaOut.installed, true);
    assert.equal(schemaOut.version, LA.AUDIT_SCHEMA_VERSION);
    assert.equal(schemaOut.component, LA.AUDIT_COMPONENT);

    const events = runCli(["events", "--db", file, "--account-set", "42"]);
    assert.equal(events.status, 0, events.stderr);
    const eventsOut = JSON.parse(events.stdout);
    assert.equal(eventsOut.events.length, 1);
    assert.equal(eventsOut.events[0].accountSetId, 42);
    assert.equal(eventsOut.events[0].correlation, token);

    const verify = runCli(["verify", "--db", file]);
    assert.equal(verify.status, 0);
    assert.deepEqual(JSON.parse(verify.stdout), { checked: 1, mismatched: [] });

    const stats = runCli(["stats", "--db", file]);
    assert.equal(stats.status, 0);
    assert.equal(JSON.parse(stats.stdout).total, 1);

    const badAction = runCli(["events", "--db", file, "--action", SENTINEL]);
    assert.equal(badAction.status, 2);
    assert.equal(`${badAction.stdout}${badAction.stderr}`.includes(SENTINEL), false);
    const badOption = runCli(["events", "--db", file, `--${SENTINEL}`, "x"]);
    assert.equal(badOption.status, 2);
    assert.equal(`${badOption.stdout}${badOption.stderr}`.includes(SENTINEL), false);
    const noDb = runCli(["events"]);
    assert.equal(noDb.status, 2);
    assert.equal(`${noDb.stdout}${noDb.stderr}`.includes(dataDir), false, "错误输出不回显本机路径");
    const unknown = runCli(["init", "--db", file]);
    assert.equal(unknown.status, 2, "CLI 不提供现库初始化快捷入口");
  });

  test("全库转储（含 WAL 合并后内容）不含任何合成敏感哨兵", () => {
    const text = dumpDatabases();
    assert.equal(text.includes(SENTINEL), false, "数据库内容不得出现哨兵");
    assert.equal(text.includes(SENTINEL2), false, "数据库内容不得出现用户批次哨兵");
    assert.equal(text.includes(SENTINEL_PATH), false, "数据库内容不得出现本机路径哨兵");
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e);
  process.exitCode = 1;
} finally {
  for (const db of OPEN_DBS) {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (e) {
    console.error("临时目录清理失败：", e && e.message);
    process.exitCode = 1;
  }
  if (existsSync(dataDir)) {
    console.error(`临时目录未清理：${dataDir}`);
    process.exitCode = 1;
  }
}
