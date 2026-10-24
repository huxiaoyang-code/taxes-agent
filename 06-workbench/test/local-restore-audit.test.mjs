#!/usr/bin/env node
/**
 * LOCAL-06 AUDIT（A 包）恢复操作 ledger 原语验收。
 *
 * 只验收**独立 ledger 原语**：begin / prepared / succeeded / failed|rejected|unknown / reconcile、
 * 幂等与冲突（终态按完整字段）、故障注入下不伪造终态、触发器定义保护、缺列 / 未知版本结构拒绝、
 * unknown 保持可对账并可显式核验、只读分页查询与 CLI。
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
  targetInstanceId:"c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",targetBindingDigest:"f".repeat(64),
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
        targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",
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
      targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",
    }), (e) => e.code === "restore_receipt_mismatch");
    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_B,
      targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",
    }), (e) => e.code === "restore_digest_mismatch");
    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: "not-a-digest", targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",
    }), (e) => e.code === "restore_operation_invalid");
    assert.equal(LR.getRestoreOperation(db, "restore-op-1").status, "prepared", "证据不足不得落终态");

    const done = LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",
    });
    assert.equal(done.changed, true);
    assert.equal(done.operation.status, "succeeded");
    assert.equal(done.operation.resultCode, "restore_new_succeeded");
    assert.equal(done.operation.targetDigest, DIGEST_TARGET);
    assert.ok(done.operation.publishedAt && done.operation.terminalAt);
    const repeat = LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",
    });
    assert.equal(repeat.changed, false);
    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId: "restore-op-1", receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: "9".repeat(64), targetInstanceId: "instance-2",
    }), (e) => e.code === "restore_target_binding_mismatch");
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

  test("fail 终态幂等按完整字段：同请求 changed:false，任一冲突字段拒绝且原库不变", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-terminal" }));
    const request = {
      operationId: "restore-op-terminal", status: "failed", resultCode: "restore_new_failed", reasonCode: "internal_error",
    };
    assert.equal(LR.failRestoreOperation(db, request).changed, true);
    const snapshot = () => ({
      operation: LR.getRestoreOperation(db, "restore-op-terminal"),
      transitions: LR.listRestoreTransitions(db, "restore-op-terminal"),
      rows: db.prepare(`SELECT COUNT(*) n FROM restore_operations`).get().n,
    });
    const before = snapshot();

    assert.equal(LR.failRestoreOperation(db, request).changed, false, "同请求必须幂等");
    // 初审复现：同一 failed 状态只改 resultCode / reasonCode 曾被当成新迁移。
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId: "restore-op-terminal", status: "failed", resultCode: "restore_new_failed", reasonCode: "restore_verify_failed",
    }), (e) => e.code === "restore_state_conflict");
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId: "restore-op-terminal", status: "failed", resultCode: "restore_new_failed", reasonCode: "internal_error",
      noteCode: "reconcile",
    }), (e) => e.code === "restore_state_conflict");
    // status 与 resultCode 的非法组合：不能把 failed 行写成 succeeded 结果码。
    // 已终态的行优先报状态冲突（任一不同字段都不允许覆写）。
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId: "restore-op-terminal", status: "failed", resultCode: "restore_new_succeeded", reasonCode: "none",
    }), (e) => e.code === "restore_state_conflict");
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId: "restore-op-terminal", status: "rejected", resultCode: "restore_new_rejected", reasonCode: "none",
    }), (e) => e.code === "restore_state_conflict");

    assert.deepEqual(snapshot(), before, "冲突拒绝后原库必须完全不变（含迁移历史）");

    // 仍可迁移的行上，非法 status / resultCode 组合同样拒绝。
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-illegal" }));
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId: "restore-op-illegal", status: "failed", resultCode: "restore_new_succeeded", reasonCode: "none",
    }), (e) => e.code === "restore_operation_invalid");
    assert.equal(LR.getRestoreOperation(db, "restore-op-illegal").status, "started");

    // unknown 也可记录「已发布但终态待确认」的固定组合。
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-published" }));
    const published = LR.failRestoreOperation(db, {
      operationId: "restore-op-published", status: "unknown", resultCode: "restore_published_pending", reasonCode: "none",
    });
    assert.equal(published.operation.status, "unknown");
    assert.equal(published.operation.resultCode, "restore_published_pending");

    // 其他终态入口同样幂等 / 冲突：begin 的 noteCode、prepared 的 receipt、succeeded 的证据。
    assert.throws(() => LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-terminal", noteCode: "reconcile" })),
      (e) => e.code === "restore_operation_conflict");

    const preparedDb = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(preparedDb, beginArgs({ operationId: "restore-op-prepared" }));
    LR.markRestorePrepared(preparedDb, { operationId: "restore-op-prepared", receipt: RECEIPT });
    const preparedBefore = LR.getRestoreOperation(preparedDb, "restore-op-prepared");
    assert.throws(() => LR.markRestorePrepared(preparedDb, {
      operationId: "restore-op-prepared", receipt: "e".repeat(64),
    }), (e) => e.code === "restore_receipt_mismatch");
    assert.deepEqual(LR.getRestoreOperation(preparedDb, "restore-op-prepared"), preparedBefore);

    // begin 带 noteCode 时，重复的 fail（不显式改 note）仍幂等；显式不同 note 才冲突。
    const noteDb = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(noteDb, beginArgs({ operationId: "restore-op-note", noteCode: "reconcile" }));
    const noteRequest = {
      operationId: "restore-op-note", status: "failed", resultCode: "restore_new_failed", reasonCode: "internal_error",
    };
    assert.equal(LR.failRestoreOperation(noteDb, noteRequest).changed, true);
    assert.equal(LR.failRestoreOperation(noteDb, noteRequest).changed, false);
    assert.equal(LR.getRestoreOperation(noteDb, "restore-op-note").noteCode, "reconcile");
    assert.throws(() => LR.failRestoreOperation(noteDb, { ...noteRequest, noteCode: "another" }),
      (e) => e.code === "restore_state_conflict");
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
        targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f",
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
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: RECEIPT }),
    });
    assert.equal(early.reconciled, false);
    assert.equal(early.terminal, "unknown");
    assert.equal(early.operation.status, "started");

    LR.markRestorePrepared(db, { operationId: "restore-op-1", receipt: RECEIPT });
    const insufficient = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => ({ targetDigest: "not-a-digest", targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: RECEIPT }),
    });
    assert.equal(insufficient.reconciled, false);
    assert.equal(insufficient.terminal, "unknown");
    assert.equal(insufficient.operation.status, "prepared", "证据不足不得改状态");
    const wrongReceipt = LR.reconcileRestoreOperation(db, {
      operationId: "restore-op-1",
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: "9".repeat(64) }),
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
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: RECEIPT }),
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

  test("unknown 是可对账状态：证据 callback 被调用、证据不足保留、完整证据转 succeeded、冲突保护", () => {
    const db = openLedger(ledgerPath(), { create: true });
    const operationId = "restore-op-unknown-path";
    LR.beginRestoreOperation(db, beginArgs({ operationId }));
    LR.markRestorePrepared(db, { operationId, receipt: RECEIPT });
    const unknown = LR.failRestoreOperation(db, {
      operationId, status: "unknown", resultCode: "restore_unknown", reasonCode: "internal_error",
    });
    assert.equal(unknown.operation.status, "unknown");
    // 「结果待确认」必须留在可对账集合里，而不是永远退出。
    assert.deepEqual(LR.listPendingRestoreOperations(db, { limit: 10 }).map((o) => o.operationId), [operationId]);
    // unknown 不得被盲当失败 / 盲重试改写。
    assert.throws(() => LR.failRestoreOperation(db, {
      operationId, status: "failed", resultCode: "restore_new_failed", reasonCode: "internal_error",
    }), (e) => e.code === "restore_state_conflict");

    let calls = 0;
    const insufficient = LR.reconcileRestoreOperation(db, {
      operationId,
      verifyPublished: () => { calls += 1; return null; },
    });
    assert.equal(calls, 1, "unknown 必须调用显式核验 callback");
    assert.equal(insufficient.reconciled, false);
    assert.equal(insufficient.terminal, "unknown");
    assert.equal(insufficient.operation.status, "unknown", "证据不足保留 unknown，不猜成功");
    assert.equal(LR.listPendingRestoreOperations(db, { limit: 10 }).length, 1, "仍可再次核验");

    const wrongReceipt = LR.reconcileRestoreOperation(db, {
      operationId,
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: "9".repeat(64) }),
    });
    assert.equal(wrongReceipt.reconciled, false);
    assert.equal(wrongReceipt.operation.status, "unknown");

    const done = LR.reconcileRestoreOperation(db, {
      operationId,
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: RECEIPT }),
    });
    assert.equal(done.reconciled, true);
    assert.equal(done.operation.status, "succeeded");
    assert.equal(done.operation.targetDigest, DIGEST_TARGET);
    assert.deepEqual(
      LR.listRestoreTransitions(db, operationId).map((t) => `${t.fromStatus}->${t.toStatus}`),
      ["null->started", "started->prepared", "prepared->unknown", "unknown->unknown", "unknown->unknown", "unknown->succeeded"],
    );
    assert.deepEqual(LR.listPendingRestoreOperations(db, { limit: 10 }), []);

    // 终态后证据不一致 → 冲突，不得改写已核验的 succeeded。
    assert.throws(() => LR.completeRestoreOperation(db, {
      operationId, receipt: RECEIPT, backupDigest: DIGEST_A,
      targetDigest: "9".repeat(64), targetInstanceId: "instance-2",
    }), (e) => e.code === "restore_target_binding_mismatch");
    assert.equal(LR.getRestoreOperation(db, operationId).targetInstanceId, "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f");

    // started → unknown（无 receipt）也保留在待对账列表，但不会被猜成成功。
    const startedUnknown = "restore-op-unknown-started";
    LR.beginRestoreOperation(db, beginArgs({ operationId: startedUnknown }));
    LR.failRestoreOperation(db, {
      operationId: startedUnknown, status: "unknown", resultCode: "restore_unknown", reasonCode: "internal_error",
    });
    assert.ok(LR.listPendingRestoreOperations(db, { limit: 10 }).some((o) => o.operationId === startedUnknown));
    const noReceipt = LR.reconcileRestoreOperation(db, {
      operationId: startedUnknown,
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: RECEIPT }),
    });
    assert.equal(noReceipt.reconciled, false);
    assert.equal(noReceipt.terminal, "unknown");
    assert.equal(noReceipt.operation.status, "unknown");
  });

  test("待对账列表包含 started / prepared / unknown，且排序稳定", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-a" }));
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-b" }));
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-c" }));
    LR.failRestoreOperation(db, { operationId: "restore-op-c", resultCode: "restore_new_failed", reasonCode: "internal_error" });
    LR.beginRestoreOperation(db, beginArgs({ operationId: "restore-op-u" }));
    LR.failRestoreOperation(db, {
      operationId: "restore-op-u", status: "unknown", resultCode: "restore_unknown", reasonCode: "internal_error",
    });
    const pending = LR.listPendingRestoreOperations(db, { limit: 10 });
    assert.deepEqual(pending.map((p) => p.operationId), ["restore-op-a", "restore-op-b", "restore-op-u"]);
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
      verifyPublished: () => ({ targetDigest: DIGEST_TARGET, targetInstanceId: "c4f8b1e2-904e-4c1d-875b-df65bbc3e67f", receipt: RECEIPT }),
    });
    assert.equal(reconcile.operation.status, "succeeded");
    db.close();
    const reopened = openLedger(lpath, { readOnly: true });
    assert.equal(LR.getRestoreOperation(reopened, "restore-op-1").status, "succeeded");
    reopened.close();
  });

  test("append-only：迁移历史不可改 / 不可删 / 不可被 INSERT OR REPLACE 替换", () => {
    const db = openLedger(ledgerPath(), { create: true });
    LR.beginRestoreOperation(db, beginArgs());
    const event = db.prepare(`SELECT * FROM restore_operation_events`).get();
    assert.throws(() => db.prepare(`UPDATE restore_operation_events SET to_status='succeeded'`).run());
    assert.throws(() => db.prepare(`DELETE FROM restore_operation_events`).run());
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO restore_operation_events
        (id, operation_id, at, from_status, to_status, result_code, reason_code, note_code)
        VALUES (?,?,?,?,?,?,?,?)`).run(
      event.id, event.operation_id, event.at, event.from_status, "succeeded", "restore_new_succeeded", "none", null,
    ), "默认 recursive_triggers=0 下 REPLACE 也必须被拒绝");
    assert.deepEqual(LR.listRestoreTransitions(db, "restore-op-1").map((t) => t.toStatus), ["started"]);
  });

  test("已安装 / 只读打开都验证必需触发器定义：DROP 或同名无效触发器均拒绝", () => {
    const invalidPath = ledgerPath();
    const invalidDb = openLedger(invalidPath, { create: true });
    LR.beginRestoreOperation(invalidDb, beginArgs());
    invalidDb.exec(`DROP TRIGGER restore_events_no_delete`);
    invalidDb.exec(`CREATE TRIGGER restore_events_no_delete BEFORE DELETE ON restore_operation_events BEGIN SELECT 1; END`);
    let thrown = null;
    try { LR.ensureRestoreLedgerSchema(invalidDb); } catch (e) { thrown = e; }
    assert.ok(thrown, "同名无效触发器不得假通过");
    assert.equal(thrown.code, "restore_ledger_inconsistent");
    assert.equal(thrown.details.reason, "invalid_triggers");
    assert.throws(() => LR.restoreLedgerStats(invalidDb), (e) => e.code === "restore_ledger_inconsistent");
    invalidDb.close();
    assert.throws(() => LR.openRestoreLedger(invalidPath, { readOnly: true }),
      (e) => e.code === "restore_ledger_inconsistent" && e.details.reason === "invalid_triggers");

    const missingPath = ledgerPath();
    const missingDb = openLedger(missingPath, { create: true });
    LR.beginRestoreOperation(missingDb, beginArgs());
    missingDb.exec(`DROP TRIGGER restore_events_no_delete`);
    assert.throws(() => LR.ensureRestoreLedgerSchema(missingDb),
      (e) => e.code === "restore_ledger_inconsistent" && e.details.reason === "missing_triggers");
    missingDb.close();
    assert.throws(() => LR.openRestoreLedger(missingPath, { readOnly: true }),
      (e) => e.code === "restore_ledger_inconsistent" && e.details.reason === "missing_triggers");
  });

  test("未知版本 / 缺列先结构检查后查询：固定结构化拒绝，不回原始 SQLite 文本、不改库", () => {
    const missingColumnPath = ledgerPath();
    const missingColumn = openLedger(missingColumnPath, { create: true });
    LR.beginRestoreOperation(missingColumn, beginArgs());
    missingColumn.exec(`ALTER TABLE restore_operations DROP COLUMN note_code`);
    const calls = [
      () => LR.ensureRestoreLedgerSchema(missingColumn),
      () => LR.getRestoreOperation(missingColumn, "restore-op-1"),
      () => LR.listPendingRestoreOperations(missingColumn),
      () => LR.queryRestoreOperations(missingColumn, {}),
      () => LR.listRestoreTransitions(missingColumn, "restore-op-1"),
      () => LR.restoreLedgerStats(missingColumn),
      () => LR.beginRestoreOperation(missingColumn, beginArgs({ operationId: "restore-op-new" })),
    ];
    for (const call of calls) {
      let failure = null;
      try { call(); } catch (e) { failure = e; }
      assert.ok(failure, "缺列必须结构化拒绝");
      assert.equal(failure.code, "restore_ledger_inconsistent");
      assert.equal(failure.details.reason, "missing_columns");
      assert.equal(/no such column|SQLITE_ERROR/i.test(failure.message), false, "不得回原始 SQLite 文本");
    }
    missingColumn.close();
    assert.throws(() => LR.openRestoreLedger(missingColumnPath, { readOnly: true }),
      (e) => e.code === "restore_ledger_inconsistent" && e.details.reason === "missing_columns");
    const probe = new DatabaseSync(missingColumnPath, { readOnly: true });
    try {
      const columns = probe.prepare(`PRAGMA table_info(restore_operations)`).all().map((r) => r.name);
      assert.equal(columns.includes("note_code"), false, "只读检查不得修复结构");
    } finally { probe.close(); }
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
  const keepFixtures = process.env.KEEP_FIXTURES === "1" || process.env.WORKBENCH_TEST_KEEP_FIXTURES === "1";
  if (keepFixtures) {
    console.log(`保留合成 ledger 夹具：${dataDir}`);
  } else {
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (e) {
      console.error("临时目录清理失败：", e && e.message);
      process.exitCode = 1;
    }
    if (existsSync(dataDir)) {
      console.error(`临时目录未清理：${dataDir}`);
      process.exitCode = 1;
    }
  }
}
