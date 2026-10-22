#!/usr/bin/env node
/**
 * LOCAL-06 AUDIT（A 包）恢复操作 ledger 原语验收。
 *
 * 只验收**独立 ledger 原语**：begin / prepared / succeeded / failed|rejected|unknown / reconcile、
 * 幂等与冲突、故障注入下不伪造终态、只读分页查询与 CLI。
 * **不含**真实 restore-new 接线（C 包）：本套件不复制 / 覆盖任何目录，也不声称跨库原子提交。
 *
 * 全部合成临时目录 + 合成摘要；不使用任何真实备份、目标库或凭据。
 * 运行（在 06-workbench 目录）：`node test/local-restore-audit.test.mjs`
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const workbenchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "wb-restore-ledger-"));
process.env.WORKBENCH_DATA_DIR = dataDir;
if (process.env.WORKBENCH_DATA_DIR !== dataDir) throw new Error("WORKBENCH_DATA_DIR 未锁定到临时目录");

const LA = await import("../server/local-audit.mjs");
const LR = await import("../server/local-restore-audit.mjs");

const SENTINEL = "SYNTH-C--backup-D--账套路径-敏感-0001";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_TARGET = "c".repeat(64);
const RECEIPT = "d".repeat(64);

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e && e.message}`); }
};

const FILES = [];
const OPEN = [];
let seq = 0;
const ledgerPath = () => { seq += 1; const p = join(dataDir, `ledger-${seq}.db`); FILES.push(p); return p; };

const openLedger = (path, options) => {
  const db = LR.openRestoreLedger(path, options);
  OPEN.push(db);
  return db;
};

const beginArgs = (over = {}) => ({
  operationId: "restore-op-1",
  backupDigest: DIGEST_A,
  backupBytes: 4096,
  backupSchemaVersion: 4,
  componentVersions: { "business-audit": 1, "local-backup": 4 },
  producer: "local-backup-cli",
  ...over,
});

const dumpLedger = () => {
  const chunks = [];
  for (const file of FILES) {
    if (!existsSync(file)) continue;
    chunks.push(readFileSync(file).toString("utf8"));
    const probe = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = probe.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();
      for (const row of tables) chunks.push(JSON.stringify(probe.prepare(`SELECT * FROM "${row.name}"`).all()));
    } catch { /* 非数据库文件：只保留原始字节扫描结果 */ } finally { probe.close(); }
  }
  return chunks.join("\n");
};

const runCli = (args) => spawnSync(process.execPath, [join(workbenchDir, "scripts", "local-audit.mjs"), ...args], {
  cwd: workbenchDir,
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir },
  encoding: "utf8",
});

try {
  // ---------------------------------------------------------------- 打开与结构
  test("显式路径缺失：不创建文件；只读打开拒绝", () => {
    const missing = join(dataDir, "no-ledger.db");
    assert.throws(() => LR.openRestoreLedger(missing), (e) => e.code === "restore_ledger_missing");
    assert.throws(() => LR.openRestoreLedger(missing, { readOnly: true }), (e) => e.code === "restore_ledger_missing");
    assert.equal(existsSync(missing), false);
    assert.equal(runCli(["restore-stats", "--ledger", missing]).status, 3);
    assert.equal(existsSync(missing), false, "CLI 查询不得创建 ledger");
  });

  test("受保护初始化：空库建表 + 版本；重复幂等；非空非 ledger 库拒绝", () => {
    const path = ledgerPath();
    const db = openLedger(path, { create: true });
    const state = LR.inspectRestoreLedger(db);
    assert.equal(state.installed, true);
    assert.equal(state.version, LR.RESTORE_LEDGER_SCHEMA_VERSION);
    assert.deepEqual(state.present, [...LR.RESTORE_LEDGER_TABLES]);
    const again = LR.ensureRestoreLedgerSchema(db);
    assert.equal(again.installed, false);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM restore_ledger_meta`).get().n, 1);
    db.close();

    // 业务库（含其他表）不能被当成 ledger 采用。
    const foreign = join(dataDir, "business-like.db");
    FILES.push(foreign);
    const biz = new DatabaseSync(foreign);
    biz.exec(`CREATE TABLE account_sets (id INTEGER PRIMARY KEY, name TEXT)`);
    biz.close();
    assert.throws(() => LR.openRestoreLedger(foreign, { create: true }), (e) => e.code === "restore_ledger_foreign_tables");
    const foreignCheck = new DatabaseSync(foreign);
    try {
      assert.equal(foreignCheck.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, 0);
    } finally { foreignCheck.close(); }

    // 坏文件（不是数据库）拒绝，且不静默重建。
    const corrupt = join(dataDir, "corrupt-ledger.db");
    FILES.push(corrupt);
    writeFileSync(corrupt, "不是数据库".repeat(40));
    assert.throws(() => LR.openRestoreLedger(corrupt, { create: true }), (e) => e.code === "restore_ledger_invalid");
  });

  test("版本更高 / 缺表拒绝（不静默修复）", () => {
    const newerPath = ledgerPath();
    const newer = openLedger(newerPath, { create: true });
    newer.prepare(`UPDATE restore_ledger_meta SET version=?`).run(LR.RESTORE_LEDGER_SCHEMA_VERSION + 1);
    assert.throws(() => LR.ensureRestoreLedgerSchema(newer), (e) => e.code === "restore_ledger_incompatible");
    newer.close();
    assert.throws(() => LR.openRestoreLedger(newerPath, { readOnly: true }), (e) => e.code === "restore_ledger_incompatible");

    const partialPath = ledgerPath();
    const partial = openLedger(partialPath, { create: true });
    partial.exec(`DROP TABLE restore_operation_events`);
    assert.throws(() => LR.ensureRestoreLedgerSchema(partial), (e) => e.code === "restore_ledger_inconsistent");
  });

  // ---------------------------------------------------------------- 生命周期
  test("started 真实持久化：关闭重开后仍在，transitions 可查", () => {
    const path = ledgerPath();
    const db = openLedger(path, { create: true });
    const begun = LR.beginRestoreOperation(db, beginArgs());
    assert.equal(begun.created, true);
    assert.equal(begun.operation.status, "started");
    assert.equal(begun.operation.resultCode, "restore_started");
    assert.equal(begun.operation.backupBytes, 4096);
    assert.deepEqual(begun.operation.componentVersions, { "business-audit": 1, "local-backup": 4 });
    db.close();

    const reopened = openLedger(path, { readOnly: true });
    const op = LR.getRestoreOperation(reopened, "restore-op-1");
    assert.equal(op.status, "started");
    assert.equal(op.backupDigest, DIGEST_A);
    const transitions = LR.listRestoreTransitions(reopened, "restore-op-1");
    assert.deepEqual(transitions.map((t) => [t.fromStatus, t.toStatus]), [[null, "started"]]);
    reopened.close();
  });

  test("begin 幂等；不同 digest / 字节 / 组件 / producer 冲突且原记录不变", () => {
    const db = openLedger(ledgerPath(), { create: true });
    assert.equal(LR.beginRestoreOperation(db, beginArgs()).created, true);
    const repeat = LR.beginRestoreOperation(db, beginArgs());
    assert.equal(repeat.created, false);
    assert.equal(repeat.operation.status, "started");

    const conflicts = [
      { backupDigest: DIGEST_B },
      { backupBytes: 8192 },
      { producer: "other-cli" },
      { backupSchemaVersion: 3 },
      { componentVersions: { "business-audit": 1, "local-backup": 5 } },
    ];
    for (const over of conflicts) {
      assert.throws(() => LR.beginRestoreOperation(db, beginArgs(over)), (e) => e.code === "restore_operation_conflict");
    }
    const op = LR.getRestoreOperation(db, "restore-op-1");
    assert.equal(op.backupDigest, DIGEST_A);
    assert.equal(op.backupBytes, 4096);
    assert.equal(op.producer, "local-backup-cli");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM restore_operations`).get().n, 1);
  });

  test("prepared 需要 receipt；重复幂等；不同 receipt 冲突", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    assert.throws(() => LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: "not-a-digest" }),
      (e) => e.code === "restore_operation_invalid");
    const prepared = LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: RECEIPT });
    assert.equal(prepared.changed, true);
    assert.equal(prepared.operation.status, "prepared");
    assert.equal(prepared.operation.receipt, RECEIPT);
    assert.ok(prepared.operation.preparedAt);
    const repeat = LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: RECEIPT });
    assert.equal(repeat.changed, false);
    assert.throws(() => LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: "e".repeat(64) }),
      (e) => e.code === "restore_receipt_mismatch");
    assert.equal(LR.getRestoreOperation(db, "restore-op-1").receipt, RECEIPT);
  });

  test("不能伪造终态：未 prepared 的 started 不允许 succeeded", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    assert.throws(
      () => LR.completeRestoreOperation(db, {
        operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
        targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1",
      }),
      (e) => e.code === "restore_state_conflict",
    );
    const op = LR.getRestoreOperation(db, "restore-op-1");
    assert.equal(op.status, "started");
    assert.equal(op.terminalAt, null);
    assert.equal(op.targetDigest, null);
  });

  test("succeeded：receipt / digest 一致才允许；幂等；证据不一致冲突", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: RECEIPT });

    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: "f".repeat(64), backupDigest: DIGEST_A,
      targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1",
    }), (e) => e.code === "restore_receipt_mismatch");
    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_B,
      targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1",
    }), (e) => e.code === "restore_digest_mismatch");
    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: "not-a-digest", targetInstanceId: "instance-1",
    }), (e) => e.code === "restore_operation_invalid");
    assert.equal(LR.getRestoreOperation(db, "restore-op-1").status, "prepared", "证据不足不得落终态");

    const done = LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1",
    });
    assert.equal(done.changed, true);
    assert.equal(done.operation.status, "succeeded");
    assert.equal(done.operation.resultCode, "restore_new_succeeded");
    assert.equal(done.operation.targetDigest, DIGEST_TARGET);
    assert.ok(done.operation.publishedAt && done.operation.terminalAt);
    const repeat = LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1",
    });
    assert.equal(repeat.changed, false);
    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: "9".repeat(64), targetInstanceId: "instance-2",
    }), (e) => e.code === "restore_digest_mismatch");
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId: "restore-op-1", resultCode: "restore_new_failed",
    }), (e) => e.code === "restore_state_conflict");
  });

  test("失败 / 拒绝 / unknown 终态：重复幂等、终态不可互改", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-fail" }));
    const failed = LR.failRestoreOperation(db, {
      operationId: "restore-op-fail", status: "failed", resultCode: "restore_new_failed", reasonCode: "internal_error",
    });
    assert.equal(failed.changed, true);
    assert.equal(failed.operation.status, "failed");
    const repeat = LR.failRestoreOperation(db, {
      operationId: "restore-op-fail", status: "failed", resultCode: "restore_new_failed", reasonCode: "internal_error",
    });
    assert.equal(repeat.changed, false);
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId: "restore-op-fail", status: "rejected", resultCode: "restore_new_rejected",
    }), (e) => e.code === "restore_state_conflict");

    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-reject" }));
    const rejected = LR.failRestoreOperation(db, {
      operationId: "restore-op-reject", status: "rejected", resultCode: "restore_new_rejected",
      reasonCode: "restore_verify_failed",
    });
    assert.equal(rejected.operation.status, "rejected");

    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-unknown" }));
    const unknown = LR.failRestoreOperation(db, {
      operationId: "restore-op-unknown", status: "unknown", resultCode: "restore_unknown", reasonCode: "internal_error",
    });
    assert.equal(unknown.operation.status, "unknown");

    const stats = LR.restoreLedgerStats(db);
    assert.deepEqual(stats.byStatus.map((s) => s.status), ["failed", "rejected", "unknown"]);
    assert.equal(stats.total, 3);
  });

  test("故障注入（写入触发器 RAISE）：complete 整体回滚，状态保持 prepared", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: RECEIPT });
    db.exec(`CREATE TRIGGER inject_ledger_update_failure BEFORE UPDATE ON restore_operations
             WHEN NEW.status = 'succeeded'
             BEGIN SELECT RAISE(ABORT, 'injected_ledger_failure'); END`);
    let thrown = null;
    try {
      LR.completeRestoreOperation(db, {
        operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
        targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1",
      });
    } catch (e) { thrown = e; }
    db.exec(`DROP TRIGGER inject_ledger_update_failure`);
    assert.ok(thrown, "写入故障必须抛出");
    const op = LR.getRestoreOperation(db, "restore-op-1");
    assert.equal(op.status, "prepared", "不得留下半个 succeeded");
    assert.equal(op.terminalAt, null);
    assert.equal(op.targetDigest, null);
    const transitions = LR.listRestoreTransitions(db, "restore-op-1").map((t) => t.toStatus);
    assert.deepEqual(transitions, ["started", "prepared"], "失败迁移不得写入迁移记录");
  });

  test("reconcile：started 证据不足 → unknown 且不改状态；prepared 证据完整才补记终态", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    const early = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1", receipt: RECEIPT }),
    });
    assert.equal(early.reconciled, false);
    assert.equal(early.terminal, "unknown");
    assert.equal(early.operation.status, "started");

    LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: RECEIPT });
    const insufficient = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => ({ targetDigest: "not-a-digest", targetInstanceId: "instance-1", receipt: RECEIPT }),
    });
    assert.equal(insufficient.reconciled, false);
    assert.equal(insufficient.terminal, "unknown");
    assert.equal(insufficient.operation.status, "prepared", "证据不足不得改状态");
    const wrongReceipt = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1", receipt: "9".repeat(64) }),
    });
    assert.equal(wrongReceipt.reconciled, false);
    const throwsEvidence = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => { throw new Error("target unreadable"); },
    });
    assert.equal(throwsEvidence.reconciled, false);
    assert.equal(throwsEvidence.operation.status, "prepared");

    const done = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1", receipt: RECEIPT }),
    });
    assert.equal(done.reconciled, true);
    assert.equal(done.operation.status, "succeeded");
    assert.equal(done.operation.targetDigest, DIGEST_TARGET);
    const repeat = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1", verifyPublished: () => { throw new Error("不得再次调用"); },
    });
    assert.equal(repeat.reconciled, false);
    assert.equal(repeat.terminal, "succeeded");
    const notes = LR.listRestoreTransitions(db, "restore-op-1").filter((t) => t.resultCode === "restore_reconcile_pending");
    assert.ok(notes.length >= 3, "证据不足的每次对账都要留痕");
    assert.equal(LR.restoreLedgerStats(db).byStatus.find((s) => s.status === "succeeded").count, 1);
  });

  test("待对账列表只含 started / prepared，且排序稳定", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-a" }));
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-b" }));
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-c" }));
    LR.failRestoreOperation(db, { operationId: "restore-op-c", resultCode: "restore_new_failed", reasonCode: "internal_error" });
    const pending = LR.listPendingRestoreOperations(db, { limit: 10 });
    assert.deepEqual(pending.map((p) => p.operationId), ["restore-op-a", "restore-op-b"]);
    assert.throws(() => LR.listPendingRestoreOperations(db, { limit: 0 }), (e) => e.code === "restore_operation_invalid");
  });

  test("只读分页查询稳定；非法过滤拒绝", () => {
    const db = openLedger(ledgerPath(), { create: true });
    for (let i = 1; i <= 12; i += 1) {
      LR.beginRestoreOperation(db, beginArgs({ operationId: `restore-op-p${String(i).padStart(2, "0")}` }));
    }
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = LR.queryRestoreOperations(db, cursor ? { limit: 5, ...cursor } : { limit: 5 });
      seen.push(...page.operations.map((o) => o.operationId));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12, "分页不得重复");
    assert.deepEqual(seen, [...seen].sort(), "固定按 started_at / operation_id 升序");

    assert.throws(() => LR.queryRestoreOperations(db, { status: "published" }), (e) => e.code === "restore_operation_invalid");
    assert.throws(() => LR.queryRestoreOperations(db, { limit: 501 }), (e) => e.code === "restore_operation_invalid");
    assert.throws(() => LR.queryRestoreOperations(db, { afterStartedAt: "2026-01-01T00:00:00Z" }),
      (e) => e.code === "restore_operation_invalid");
    assert.throws(() => LR.queryRestoreOperations(db, { rawPath: SENTINEL }), (e) => e.code === "restore_operation_invalid");
  });

  test("ledger 不存原始路径 / 用户标识：非法 producer / operationId 拒绝且不回显", () => {
    const db = openLedger(ledgerPath(), { create: true });
    const badProducer = () => LR.beginRestoreOperation(db, beginArgs({ producer: SENTINEL }));
    assert.throws(badProducer, (e) => e.code === "restore_operation_invalid");
    try { badProducer(); } catch (e) {
      assert.equal(`${e.message} ${JSON.stringify(e.details ?? {})}`.includes(SENTINEL), false);
    }
    assert.throws(() => LR.beginRestoreOperation(db, beginArgs({ operationId: SENTINEL })),
      (e) => e.code === "restore_operation_invalid");
    assert.throws(() => LR.beginRestoreOperation(db, beginArgs({ backupDigest: SENTINEL })),
      (e) => e.code === "restore_operation_invalid");
    assert.throws(() => LR.beginRestoreOperation(db, beginArgs({ componentVersions: { [SENTINEL]: 1 } })),
      (e) => e.code === "restore_operation_invalid");
    assert.throws(() => LR.queryRestoreOperations(db, { producer: SENTINEL }),
      (e) => e.code === "restore_operation_invalid");
    // 一个合法操作后，整库转储仍不含哨兵。
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-clean" }));
    assert.equal(dumpLedger().includes(SENTINEL), false, "ledger 不得落任何原始路径 / 用户标识");
  });

  test("ledger 与业务库相互独立：业务库删除后 ledger 记录仍可查询（不声称跨库原子）", () => {
    const lpath = ledgerPath();
    const db = openLedger(lpath, { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: RECEIPT });
    const businessDbPath = join(dataDir, "business-under-restore.db");
    FILES.push(businessDbPath);
    const biz = new DatabaseSync(businessDbPath);
    biz.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    biz.close();

    // 模拟「恢复失败、目标库不可用」：目标库文件被删除，ledger 仍在（两阶段 + 显式对账，不假装原子）。
    writeFileSync(businessDbPath, "");
    assert.equal(existsSync(businessDbPath), true);
    const op = LR.getRestoreOperation(db, "restore-op-1");
    assert.equal(op.status, "prepared");
    const reconcile = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "instance-1", receipt: RECEIPT }),
    });
    assert.equal(reconcile.operation.status, "succeeded");
    db.close();
    const reopened = openLedger(lpath, { readOnly: true });
    assert.equal(LR.getRestoreOperation(reopened, "restore-op-1").status, "succeeded");
    reopened.close();
  });

  test("append-only：迁移历史不可改 / 不可删", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    assert.throws(() => db.prepare(`UPDATE restore_operation_events SET to_status='succeeded'`).run());
    assert.throws(() => db.prepare(`DELETE FROM restore_operation_events`).run());
  });

  test("CLI 只读：restore-stats / restore-operations / restore-operation / restore-pending / restore-transitions", () => {
    const path = ledgerPath();
    const db = openLedger(path, { create: true });
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-cli" }));
    LR.markRestorePrepared(db, { operationId: "restore-op-cli", receipt: RECEIPT });
    db.close();

    const stats = runCli(["restore-stats", "--ledger", path]);
    assert.equal(stats.status, 0, stats.stderr);
    const statsOut = JSON.parse(stats.stdout);
    assert.equal(statsOut.component, LR.RESTORE_LEDGER_COMPONENT);
    assert.equal(statsOut.byStatus.find((s) => s.status === "prepared").count, 1);

    const list = runCli(["restore-operations", "--ledger", path, "--status", "prepared"]);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).operations.map((o) => o.operationId), ["restore-op-cli"]);

    const one = runCli(["restore-operation", "--ledger", path, "--operation", "restore-op-cli"]);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(JSON.parse(one.stdout).operation.status, "prepared");

    const pending = runCli(["restore-pending", "--ledger", path]);
    assert.equal(pending.status, 0, pending.stderr);
    assert.equal(JSON.parse(pending.stdout).operations.length, 1);

    const transitions = runCli(["restore-transitions", "--ledger", path, "--operation", "restore-op-cli"]);
    assert.equal(transitions.status, 0, transitions.stderr);
    assert.deepEqual(JSON.parse(transitions.stdout).transitions.map((t) => t.toStatus), ["started", "prepared"]);

    const badStatus = runCli(["restore-operations", "--ledger", path, "--status", SENTINEL]);
    assert.equal(badStatus.status, 2);
    assert.equal(`${badStatus.stdout}${badStatus.stderr}`.includes(SENTINEL), false);
    const noLedger = runCli(["restore-operations"]);
    assert.equal(noLedger.status, 2);
    assert.equal(`${noLedger.stdout}${noLedger.stderr}`.includes(dataDir), false, "错误输出不回显本机路径");
    const writeAttempt = runCli(["reconcile", "--ledger", path]);
    assert.equal(writeAttempt.status, 2, "CLI 不提供写入口");
  });

  test("ledger 全库转储不含哨兵；也不含业务金额 / 路径形态内容", () => {
    const text = dumpLedger();
    assert.equal(text.includes(SENTINEL), false);
    assert.equal(/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(text), false, "不得落原始文件路径");
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e);
  process.exitCode = 1;
} finally {
  for (const db of OPEN) {
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
