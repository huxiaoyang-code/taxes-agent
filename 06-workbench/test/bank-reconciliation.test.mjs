#!/usr/bin/env node
/**
 * LOCAL-04 银行流水持久化 / 匹配 / 失效 / 余额调节回归（领域层，真实 SQLite）。
 *
 * 全部使用合成临时库：先由本测试声明「创建事实」，再调用产品真实建库入口
 * （server/db.mjs，WORKBENCH_DATA_DIR 指向临时目录）与真实会计 API 建账套、期初、
 * posted / 草稿凭证、反过账 / 再记账，然后在同一真实库上跑银行组件。
 * 不读取任何真实账套 / 银行文件 / 凭据。
 *
 * 运行：node test/bank-reconciliation.test.mjs（在 06-workbench 目录）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = mkdtempSync(join(tmpdir(), "wb-bank-"));
const dbPath = join(dataDir, "workbench.db");
process.env.WORKBENCH_DATA_DIR = dataDir;

const S = await import("../server/bank-storage.mjs");
const I = await import("../server/bank-import.mjs");
const receipt = S.claimFreshDatabase({ dbPath });
const { db } = await import("../server/db.mjs");
const A = await import("../server/accounting.mjs");
const B = await import("../server/bank-reconciliation.mjs");

process.on("exit", () => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
});

const schema = await S.ensureBankSchema(db, { dbPath, receipt });
assert.equal(schema.migrated, true);

const BANK_TABLE_LIST = [...S.BANK_TABLES];
const snapshotBank = () => Object.fromEntries(BANK_TABLE_LIST.map((t) => [
  t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
]));
const snapshotAccounting = () => ({
  vouchers: db.prepare(`SELECT * FROM vouchers ORDER BY id`).all(),
  entries: db.prepare(`SELECT * FROM voucher_entries ORDER BY id`).all(),
  periods: db.prepare(`SELECT * FROM periods ORDER BY account_set_id, period`).all(),
  openings: db.prepare(`SELECT * FROM opening_balances ORDER BY account_set_id, code`).all(),
});
const count = (sql, ...args) => Number(db.prepare(sql).get(...args).n);

let seq = 0;
const uniq = (prefix) => `${prefix}-${++seq}`;

function createSet(name, opening = [{ code: "1002", debit: 80000, credit: 0 }, { code: "3001", debit: 0, credit: 80000 }], startPeriod = "2026-01") {
  const set = A.createAccountSet({ name, start_period: startPeriod });
  if (opening.length) A.setOpeningBalances(set.id, opening);
  return set;
}

function register(setId, bankAccountId = uniq("BANK"), sourceId = "local-statement", glAccountCode = "1002") {
  return B.registerBankAccount(db, { accountSetId: setId, bankAccountId, sourceId, glAccountCode });
}

function post(setId, date, entries, { period = date.slice(0, 7), draft = false } = {}) {
  return A.createVoucher(setId, {
    period, voucher_date: date, status: draft ? "draft" : "posted", entries,
  });
}

const bankIn = (amount) => [{ code: "1002", debit: amount, credit: 0 }, { code: "1122", debit: 0, credit: amount }];
const bankOut = (amount) => [{ code: "5602", debit: amount, credit: 0 }, { code: "1002", debit: 0, credit: amount }];

const MAPPING_AMOUNT_DIRECTION = {
  columns: { date: "日期", summary: "摘要", amount: "金额", direction: "方向", refId: "流水号" },
  amountMode: "amount_direction",
  directionLabels: { inflow: ["收"], outflow: ["付"] },
  currency: "CNY",
};
const MAPPING_DEBIT_CREDIT = {
  columns: { date: "日期", summary: "摘要", debit: "借方", credit: "贷方", refId: "流水号" },
  amountMode: "debit_credit",
  currency: "CNY",
};

function csvAmountDirection(rows) {
  const lines = ["日期,摘要,金额,方向,流水号"];
  for (const r of rows) lines.push(`${r.date},${r.summary},${r.amount},${r.direction === "inflow" ? "收" : "付"},${r.refId ?? ""}`);
  return `${lines.join("\n")}\n`;
}
function csvDebitCredit(rows) {
  const lines = ["日期,摘要,借方,贷方,流水号"];
  for (const r of rows) {
    const debit = r.direction === "inflow" ? r.amount : "";
    const credit = r.direction === "outflow" ? r.amount : "";
    lines.push(`${r.date},${r.summary},${debit},${credit},${r.refId ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function importCsv(setId, bankAccountId, batchId, csv, mapping = MAPPING_AMOUNT_DIRECTION, options = {}) {
  return B.importBankBatch(db, {
    accountSetId: setId,
    bankAccountId,
    sourceId: options.sourceId ?? "local-statement",
    period: options.period ?? "2026-01",
    batchId,
    csvText: csv,
    mapping,
  });
}

const txnCount = (setId, bankAccountId) =>
  count(`SELECT COUNT(*) AS n FROM bank_transactions WHERE account_set_id=? AND bank_account_id=?`, setId, bankAccountId);

// ------------------------------------------------------------------ schema / 迁移门槛
test("银行组件使用独立 bank_* 命名空间与组件版本，不改全局版本 / 全局迁移表", async () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
  for (const name of BANK_TABLE_LIST) assert.ok(tables.includes(name), `缺少表 ${name}`);
  assert.equal(S.bankSchemaVersion(db), S.BANK_SCHEMA_VERSION);
  const state = S.bankSchemaState(db);
  assert.equal(state.version, 1);
  assert.deepEqual(state.tables.sort(), BANK_TABLE_LIST.sort());
  const userVersion = db.prepare(`PRAGMA user_version`).get();
  assert.equal(Number(Object.values(userVersion)[0]), 0, "不得写 PRAGMA user_version");
  const globalMigrations = db.prepare(`SELECT version, note FROM schema_migrations ORDER BY version`).all();
  assert.deepEqual(globalMigrations.map((m) => Number(m.version)), [1, 2, 3, 4], "不得写 LOCAL-01 的 schema_migrations");

  // 已存在的文件不能被再次声明为新库。
  assert.throws(() => S.claimFreshDatabase({ dbPath }), (e) => e.code === "fresh_database_file_exists");
  // 重复初始化是幂等的 no-op。
  const again = await S.ensureBankSchema(db, { dbPath });
  assert.equal(again.migrated, false);
  assert.equal(again.creation, "already-initialized");
});

test("迁移门槛：非本产品库 / 已有库无备份服务 / 备份失败 都拒绝且不动原库", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-gate-"));
  try {
    const file = join(dir, "workbench.db");
    const conn = new DatabaseSync(file);
    try {
      conn.exec(`CREATE TABLE account_sets (id INTEGER PRIMARY KEY, name TEXT, start_period TEXT, created_at TEXT)`);
      await assert.rejects(
        () => S.ensureBankSchema(conn, { dbPath: file }),
        (e) => e.code === "schema_not_supported",
      );
      assert.equal(countIn(conn, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'bank_%'`), 0);
    } finally { conn.close(); }

    const file2 = join(dir, "workbench2.db");
    const conn2 = new DatabaseSync(file2);
    try {
      createLegacySchema(conn2);
      // 已有库、无备份服务 -> migration_backup_unavailable，且不建任何 bank_* 表。
      await assert.rejects(
        () => S.ensureBankSchema(conn2, { dbPath: file2, backupService: null }),
        (e) => e.code === "migration_backup_unavailable",
      );
      assert.equal(countIn(conn2, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'bank_%'`), 0);

      // 备份实现抛错 -> migration_backup_failed，同样不建表、不改业务数据。
      const failing = {
        createBackup: () => { throw new Error("disk full"); },
        verifyBackup: () => ({ ok: true }),
      };
      await assert.rejects(
        () => S.ensureBankSchema(conn2, { dbPath: file2, backupService: failing }),
        (e) => e.code === "migration_backup_failed",
      );
      assert.equal(countIn(conn2, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'bank_%'`), 0);

      // 备份校验不通过 -> migration_backup_invalid。
      const invalid = {
        ...fakeBackupService(file2),
        verifyBackup: () => ({ ok: false, status: "corrupt" }),
      };
      await assert.rejects(
        () => S.ensureBankSchema(conn2, { dbPath: file2, backupService: invalid }),
        (e) => e.code === "migration_backup_invalid",
      );
      assert.equal(countIn(conn2, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'bank_%'`), 0);

      // 弱 mock 不得放行：verify 返回 true / 只有 integrity、create 不返回真实快照字段都要拒绝。
      const booleanVerify = { ...fakeBackupService(file2), verifyBackup: () => true };
      await assert.rejects(
        () => S.ensureBankSchema(conn2, { dbPath: file2, backupService: booleanVerify }),
        (e) => e.code === "migration_backup_invalid",
      );
      const integrityOnly = { ...fakeBackupService(file2), verifyBackup: () => ({ integrity: "ok" }) };
      await assert.rejects(
        () => S.ensureBankSchema(conn2, { dbPath: file2, backupService: integrityOnly }),
        (e) => e.code === "migration_backup_invalid",
      );
      const noSnapshotFacts = {
        ...fakeBackupService(file2),
        createBackup: ({ outDir }) => ({ ok: true, status: "ok", backupDir: join(outDir, "fake-backup"), bytes: 1 }),
      };
      await assert.rejects(
        () => S.ensureBankSchema(conn2, { dbPath: file2, backupService: noSnapshotFacts }),
        (e) => e.code === "migration_backup_failed",
      );
      assert.equal(countIn(conn2, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'bank_%'`), 0);

      // 仅顺序验证（不是 LOCAL-06 真实迁移验收）：DDL 只在备份校验返回 ok 之后发生。
      const calls = [];
      const full = fakeBackupService(file2);
      const fake = {
        createBackup: (options) => { calls.push("createBackup"); return full.createBackup(options); },
        verifyBackup: (options) => { calls.push("verifyBackup"); return full.verifyBackup(options); },
      };
      const migrated = await S.ensureBankSchema(conn2, { dbPath: file2, backupService: fake });
      assert.equal(migrated.migrated, true);
      assert.equal(migrated.creation, "existing-database");
      assert.deepEqual(calls, ["createBackup", "verifyBackup"]);
      assert.equal(S.bankSchemaVersion(conn2), 1);
    } finally { conn2.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function countIn(conn, sql, ...args) {
  return Number(conn.prepare(sql).get(...args).n);
}

function createLegacySchema(conn) {
  conn.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE account_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      taxpayer_type TEXT NOT NULL DEFAULT '小规模纳税人',
      accounting_standard TEXT NOT NULL DEFAULT '小企业会计准则',
      start_period TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
      code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,
      contra INTEGER NOT NULL DEFAULT 0, is_leaf INTEGER NOT NULL DEFAULT 1,
      UNIQUE (account_set_id, code));
    CREATE TABLE opening_balances (
      account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
      code TEXT NOT NULL, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (account_set_id, code));
    CREATE TABLE periods (
      account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
      period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      PRIMARY KEY (account_set_id, period));
    CREATE TABLE vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
      period TEXT NOT NULL, voucher_date TEXT NOT NULL, word TEXT NOT NULL DEFAULT '记',
      number INTEGER NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'draft',
      kind TEXT NOT NULL DEFAULT 'normal', created_at TEXT NOT NULL);
    CREATE TABLE voucher_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL, code TEXT NOT NULL, summary TEXT,
      debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0);
    INSERT INTO account_sets (name, start_period, created_at) VALUES ('合成旧库公司', '2025-12', '2025-12-01T00:00:00.000Z');
  `);
}

// ------------------------------------------------------------------ 账户登记
test("登记银行账户：叶子科目 / 重复绑定 / 跨账套隔离 / 幂等 / 币种拒绝", () => {
  const setA = createSet("合成登记甲");
  const setB = createSet("合成登记乙");
  const gl = "100201";
  A.addAccount(setA.id, { code: gl, name: "基本户", category: "资产", direction: "debit" });

  const first = register(setA.id, "BANK-REG-1", "src-1", gl);
  assert.equal(first.created, true);
  assert.equal(first.account.gl_account_code, gl);
  assert.equal(first.account.currency, "CNY");
  const again = register(setA.id, "BANK-REG-1", "src-1", gl);
  assert.equal(again.created, false, "相同登记必须幂等");
  assert.throws(
    () => register(setA.id, "BANK-REG-1", "src-2", gl),
    (e) => e.code === "bank_account_conflict",
  );
  // 同一账套同一叶子科目不能被两个银行账户并行绑定。
  assert.throws(
    () => register(setA.id, "BANK-REG-2", "src-1", gl),
    (e) => e.code === "bank_gl_account_already_bound",
  );
  // 同一个 bankAccountId 在不同账套是独立范围。
  const other = register(setB.id, "BANK-REG-1", "src-1", "1002");
  assert.equal(other.created, true);

  // 1002 一旦有明细子科目，就不再是可独立归属的叶子科目。
  const leafSet = createSet("合成登记叶子");
  A.addAccount(leafSet.id, { code: "100201", name: "基本户", category: "资产", direction: "debit" });
  assert.throws(
    () => register(leafSet.id, "BANK-REG-LEAF", "src-1", "1002"),
    (e) => e.code === "bank_gl_account_not_leaf",
  );
  // 非银行存款科目、外币、非法标识都拒绝。
  assert.throws(() => register(setB.id, uniq("BANK"), "src-1", "5602"),
    (e) => e.code === "bank_gl_account_invalid");
  assert.throws(() => B.registerBankAccount(db, {
    accountSetId: setB.id, bankAccountId: uniq("BANK"), sourceId: "src-1", glAccountCode: "1002", currency: "USD",
  }), (e) => e.code === "currency_unsupported");
  assert.throws(() => register(setB.id, "含 空格", "src-1", "1002"),
    (e) => e.code === "bank_account_id_invalid");
  assert.throws(() => register(999999, "BANK-X", "src-1", "1002"),
    (e) => e.code === "account_set_not_found");
});

// ------------------------------------------------------------------ 预检 / 幂等 / 去重
test("导入预检不写库；账套 / 账户 / 期间 / 日期期间一致性在预检阶段就拒绝", () => {
  const set = createSet("合成预检");
  const account = register(set.id, uniq("BANK"));
  const bank = account.account.bank_account_id;
  const before = snapshotBank();
  const preview = B.previewBankImport(db, {
    accountSetId: set.id, bankAccountId: bank, sourceId: "local-statement", period: "2026-01",
    csvText: csvAmountDirection([{ date: "2026-01-05", summary: "收款", amount: "100.00", direction: "inflow", refId: "P-1" }]),
    mapping: MAPPING_AMOUNT_DIRECTION,
  });
  assert.equal(preview.preview.ok, true, JSON.stringify(preview.preview.errors));
  assert.equal(preview.preview.rows.length, 1);
  assert.deepEqual(snapshotBank(), before, "预检不得写任何 bank_* 表");

  const wrongPeriod = B.previewBankImport(db, {
    accountSetId: set.id, bankAccountId: bank, sourceId: "local-statement", period: "2026-02",
    csvText: csvAmountDirection([{ date: "2026-01-05", summary: "收款", amount: "1.00", direction: "inflow" }]),
    mapping: MAPPING_AMOUNT_DIRECTION,
  });
  assert.equal(wrongPeriod.preview.ok, false);
  assert.ok(wrongPeriod.preview.errors.some((e) => e.code === "row_date_period_mismatch"));

  assert.throws(() => B.previewBankImport(db, {
    accountSetId: set.id, bankAccountId: "未登记账户", sourceId: "local-statement", period: "2026-01",
    csvText: "", mapping: MAPPING_AMOUNT_DIRECTION,
  }), (e) => e.code === "bank_account_not_registered");
  assert.throws(() => B.previewBankImport(db, {
    accountSetId: set.id, bankAccountId: bank, sourceId: "local-statement", period: "2025-12",
    csvText: "", mapping: MAPPING_AMOUNT_DIRECTION,
  }), (e) => e.code === "period_before_start");
  // 借 / 贷两列模式同样走预检。
  const dc = B.previewBankImport(db, {
    accountSetId: set.id, bankAccountId: bank, sourceId: "local-statement", period: "2026-01",
    csvText: csvDebitCredit([{ date: "2026-01-05", summary: "收款", amount: "100.00", direction: "inflow", refId: "D-1" }]),
    mapping: MAPPING_DEBIT_CREDIT,
  });
  assert.equal(dc.preview.ok, true, JSON.stringify(dc.preview.errors));
  assert.equal(dc.preview.rows[0].direction, "inflow");
});

test("有稳定银行 ID：同批 / 跨批幂等、改内容冲突、不同 ID 同日同额保留两笔", () => {
  const set = createSet("合成稳定ID");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const rows = [
    { date: "2026-01-05", summary: "收款", amount: "100.00", direction: "inflow", refId: "R-1" },
    { date: "2026-01-05", summary: "收款", amount: "100.00", direction: "inflow", refId: "R-2" },
  ];
  const csv = csvAmountDirection(rows);
  const first = importCsv(set.id, bank, "BATCH-ID-1", csv);
  assert.equal(first.replay, false);
  assert.equal(first.batch.status, "completed");
  assert.equal(first.batch.importedRows, 2);
  assert.equal(txnCount(set.id, bank), 2, "不同稳定 ID 即使同日同额同摘要也必须两笔");

  const replay = importCsv(set.id, bank, "BATCH-ID-1", csv);
  assert.equal(replay.replay, true);
  assert.equal(replay.replayKind, "same-batch");
  assert.equal(txnCount(set.id, bank), 2);

  const conflict = csvAmountDirection([{ ...rows[0], amount: "100.01" }, rows[1]]);
  assert.throws(() => importCsv(set.id, bank, "BATCH-ID-1", conflict),
    (e) => e.code === "batch_content_conflict");
  const batches = db.prepare(`SELECT status, content_sha256 FROM bank_batches WHERE account_set_id=? AND batch_id='BATCH-ID-1'`)
    .get(set.id);
  assert.equal(batches.status, "completed", "冲突不得覆盖已完成批次");
  assert.equal(txnCount(set.id, bank), 2);

  // 不同文件（多一条新 ID）：前两行按稳定 ID 复用，新行新增。
  const nextFile = csvAmountDirection([...rows, {
    date: "2026-01-06", summary: "收款", amount: "100.00", direction: "inflow", refId: "R-3",
  }]);
  const second = importCsv(set.id, bank, "BATCH-ID-2", nextFile);
  assert.equal(second.batch.reusedRows, 2);
  assert.equal(second.batch.importedRows, 1);
  assert.equal(txnCount(set.id, bank), 3);
  const reusedRows = db.prepare(`SELECT status FROM bank_batch_rows WHERE account_set_id=? AND batch_id='BATCH-ID-2' ORDER BY row_index`)
    .all(set.id).map((r) => r.status);
  assert.deepEqual(reusedRows, ["duplicate_reused", "duplicate_reused", "imported"]);

  // 同 ID 改金额：结构化冲突且整批回滚，既有流水不变。
  const changed = csvAmountDirection([{ ...rows[0], amount: "999.00" }, rows[1]]);
  assert.throws(() => importCsv(set.id, bank, "BATCH-ID-3", changed),
    (e) => e.code === "source_transaction_content_changed");
  assert.equal(txnCount(set.id, bank), 3, "冲突批次不得留下半笔流水");
  const failed = db.prepare(`SELECT status, error_code FROM bank_batches WHERE account_set_id=? AND batch_id='BATCH-ID-3'`)
    .get(set.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "source_transaction_content_changed");
  const existing = db.prepare(`SELECT amount_cents FROM bank_transactions WHERE account_set_id=? AND bank_ref_id='R-1'`)
    .get(set.id);
  assert.equal(Number(existing.amount_cents), 10000, "既有流水金额不得被覆盖");
});

test("同一文件换新 batchId：识别为已完成来源，不新增流水，并保留逐行追踪", () => {
  const set = createSet("合成文件回放");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const csv = csvAmountDirection([
    { date: "2026-01-07", summary: "收款", amount: "10.00", direction: "inflow", refId: "F-1" },
    { date: "2026-01-08", summary: "付款", amount: "20.00", direction: "outflow", refId: "F-2" },
  ]);
  const first = importCsv(set.id, bank, "FILE-A", csv);
  assert.equal(first.batch.importedRows, 2);
  const replay = importCsv(set.id, bank, "FILE-B", csv);
  assert.equal(replay.replay, true);
  assert.equal(replay.replayKind, "same-file-new-batch");
  assert.equal(replay.replayOfBatchId, "FILE-A");
  assert.equal(replay.batch.importedRows, 0);
  assert.equal(txnCount(set.id, bank), 2, "同文件不得新增流水");
  assert.equal(replay.rows.length, 2);
  for (const row of replay.rows) {
    assert.equal(row.status, "replayed");
    assert.ok(row.transaction_id, "回放行必须保留到既有流水的追踪");
    const txn = db.prepare(`SELECT bank_ref_id FROM bank_transactions WHERE id=?`).get(row.transaction_id);
    assert.ok(["F-1", "F-2"].includes(txn.bank_ref_id));
  }
  const batchRow = db.prepare(`SELECT replay_of_batch, result_json FROM bank_batches WHERE account_set_id=? AND batch_id='FILE-B'`)
    .get(set.id);
  assert.equal(batchRow.replay_of_batch, "FILE-A");
  assert.equal(JSON.parse(batchRow.result_json).noNewTransactions, true);
});

test("无稳定 ID：文件内同特征两笔保留；交叠文件只存待判定证据；人工 same / distinct 幂等", () => {
  const set = createSet("合成歧义");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const duplicated = [
    { date: "2026-01-09", summary: "同摘要", amount: "50.00", direction: "inflow" },
    { date: "2026-01-09", summary: "同摘要", amount: "50.00", direction: "inflow" },
  ];
  const first = importCsv(set.id, bank, "AMB-A", csvAmountDirection(duplicated));
  assert.equal(first.batch.importedRows, 2, "同一文件内两条相同记录可能是两笔，必须都保留");
  assert.equal(txnCount(set.id, bank), 2);

  // 交叠窗口的新文件：一行同特征 + 一行确实新的。
  const overlap = csvAmountDirection([
    duplicated[0],
    { date: "2026-01-10", summary: "新交易", amount: "70.00", direction: "outflow" },
  ]);
  const second = importCsv(set.id, bank, "AMB-B", overlap);
  assert.equal(second.batch.status, "pending_review");
  assert.equal(second.batch.importedRows, 1);
  assert.equal(second.batch.ambiguousRows, 1);
  assert.equal(txnCount(set.id, bank), 3, "疑似重复行不得进入已确认流水");
  const pending = B.listAmbiguitiesView(db, { accountSetId: set.id, bankAccountId: bank, status: "pending" });
  assert.equal(pending.pending, 1);
  const ambiguity = pending.ambiguities[0];
  assert.equal(ambiguity.amountCents, 5000);
  assert.equal(ambiguity.candidateTransactionIds.length, 2, "两笔既有候选都要保留证据");

  // 未决批次不能被冲突重试或失败审计改写状态。
  assert.throws(() => importCsv(set.id, bank, "AMB-B", csvAmountDirection([
    { ...duplicated[0], amount: "51.00" },
  ])), (e) => e.code === "batch_content_conflict");
  assert.equal(
    db.prepare(`SELECT status FROM bank_batches WHERE account_set_id=? AND batch_id='AMB-B'`).get(set.id).status,
    "pending_review",
    "未决批次必须保持 pending_review，不得被失败审计覆写",
  );

  // 判定 distinct：新增一笔，批次转为 completed。
  assert.throws(() => B.resolveAmbiguity(db, {
    accountSetId: set.id, bankAccountId: bank, ambiguityId: ambiguity.ambiguityId,
    decision: "distinct", reason: "",
  }), (e) => e.code === "ambiguity_reason_required");
  const distinct = B.resolveAmbiguity(db, {
    accountSetId: set.id, bankAccountId: bank, ambiguityId: ambiguity.ambiguityId,
    decision: "distinct", reason: "两张回单为不同交易",
  });
  assert.equal(distinct.resolved, true);
  assert.equal(txnCount(set.id, bank), 4);
  const batchAfter = B.listBatchesView(db, { accountSetId: set.id, bankAccountId: bank })
    .find((b) => b.batchId === "AMB-B");
  assert.equal(batchAfter.status, "completed");
  assert.equal(batchAfter.pendingAmbiguities, 0);

  // 再交叠一行：判定 same（关联既有流水，不新增）。
  const third = importCsv(set.id, bank, "AMB-C", csvAmountDirection([duplicated[0]]));
  assert.equal(third.batch.ambiguousRows, 1);
  const target = db.prepare(`SELECT id FROM bank_transactions WHERE account_set_id=? AND bank_account_id=? ORDER BY id LIMIT 1`)
    .get(set.id, bank);
  const thirdAmbiguity = B.listAmbiguitiesView(db, { accountSetId: set.id, bankAccountId: bank, status: "pending" })
    .ambiguities[0];
  const same = B.resolveAmbiguity(db, {
    accountSetId: set.id, bankAccountId: bank, ambiguityId: thirdAmbiguity.ambiguityId,
    decision: "same", reason: "与既有流水同一笔", transactionId: Number(target.id),
  });
  assert.equal(same.transactionId, Number(target.id));
  assert.equal(txnCount(set.id, bank), 4, "判定同一笔不得新增流水");
  const idempotent = B.resolveAmbiguity(db, {
    accountSetId: set.id, bankAccountId: bank, ambiguityId: thirdAmbiguity.ambiguityId,
    decision: "same", reason: "重复提交", transactionId: Number(target.id),
  });
  assert.equal(idempotent.resolved, false);
  assert.equal(idempotent.idempotent, true);
  assert.throws(() => B.resolveAmbiguity(db, {
    accountSetId: set.id, bankAccountId: bank, ambiguityId: thirdAmbiguity.ambiguityId,
    decision: "distinct", reason: "改判",
  }), (e) => e.code === "ambiguity_already_resolved");
});

test("导入失败原子：中途数据库错误后无半笔流水；修复后同批次可重试", () => {
  const set = createSet("合成分片失败");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const csv = csvAmountDirection([
    { date: "2026-01-11", summary: "一", amount: "1.00", direction: "inflow", refId: "T-1" },
    { date: "2026-01-12", summary: "二", amount: "2.00", direction: "inflow", refId: "T-2" },
    { date: "2026-01-13", summary: "三", amount: "3.00", direction: "inflow", refId: "T-3" },
  ]);
  db.exec(`CREATE TRIGGER bank_test_fail AFTER INSERT ON bank_transactions
             WHEN NEW.row_index = 3 BEGIN SELECT RAISE(ABORT, 'injected_failure'); END`);
  try {
    assert.throws(() => importCsv(set.id, bank, "BATCH-FAIL-1", csv));
    assert.equal(txnCount(set.id, bank), 0, "事务失败不得留下半笔流水");
    assert.equal(count(`SELECT COUNT(*) AS n FROM bank_batch_rows WHERE account_set_id=? AND batch_id='BATCH-FAIL-1'`, set.id), 0);
    const failed = db.prepare(`SELECT status, attempts, error_code FROM bank_batches WHERE account_set_id=? AND batch_id='BATCH-FAIL-1'`)
      .get(set.id);
    assert.equal(failed.status, "failed");
    assert.ok(Number(failed.attempts) >= 1);
    assert.ok(failed.error_code);
  } finally {
    db.exec(`DROP TRIGGER bank_test_fail`);
  }
  const retry = importCsv(set.id, bank, "BATCH-FAIL-1", csv);
  assert.equal(retry.batch.status, "completed");
  assert.equal(retry.batch.importedRows, 3);
  assert.equal(txnCount(set.id, bank), 3);
  assert.ok(Number(retry.batch.attempts) >= 2, "重试必须保留尝试次数");
});

test("跨范围拒绝：错账套 / 错账户 / 错期间 / 目录外科目 / 币种", () => {
  const setA = createSet("合成范围甲");
  const setB = createSet("合成范围乙");
  const accountA = register(setA.id, uniq("BANK")).account.bank_account_id;
  const accountB = register(setB.id, uniq("BANK")).account.bank_account_id;
  const csv = csvAmountDirection([{ date: "2026-01-14", summary: "x", amount: "1.00", direction: "inflow", refId: "S-1" }]);

  assert.throws(() => importCsv(setB.id, accountA, "SCOPE-1", csv), (e) => e.code === "bank_account_not_registered");
  assert.throws(() => importCsv(setA.id, accountB, "SCOPE-2", csv), (e) => e.code === "bank_account_not_registered");
  assert.throws(() => importCsv(setA.id, accountA, "SCOPE-3", csv, MAPPING_AMOUNT_DIRECTION, { period: "2025-12" }),
    (e) => e.code === "period_before_start");
  assert.throws(() => B.importBankBatch(db, {
    accountSetId: setA.id, bankAccountId: accountA, sourceId: "local-statement", period: "2026-01",
    batchId: "SCOPE-4", csvText: csv, mapping: { ...MAPPING_AMOUNT_DIRECTION, currency: "USD" },
  }), (e) => e.code === "import_rejected");
  assert.throws(() => B.registerBankAccount(db, {
    accountSetId: setA.id, bankAccountId: uniq("BANK"), sourceId: "s", glAccountCode: "1002", currency: "EUR",
  }), (e) => e.code === "currency_unsupported");
  // 账套 B 的对账不能读账套 A 的流水。
  importCsv(setA.id, accountA, "SCOPE-OK", csv);
  const cross = B.reconcileBank(db, {
    accountSetId: setB.id, bankAccountId: accountB, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 0n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成对账单",
  });
  assert.equal(cross.outstanding.bankReceivedBookMissing.length, 0);
  assert.equal(cross.book.closingCents, 8000000);
});

// ------------------------------------------------------------------ 候选
test("候选只来自 posted 且同科目分录；多候选全部列出；日期窗口显式有限；组匹配未实现", () => {
  const set = createSet("合成候选");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const csv = csvAmountDirection([{ date: "2026-01-10", summary: "收款", amount: "50.00", direction: "inflow", refId: "C-1" }]);
  const imported = importCsv(set.id, bank, "CAND-1", csv);
  const txnId = imported.transactionIds[0];

  const vIn = post(set.id, "2026-01-10", bankIn(50));
  post(set.id, "2026-01-10", bankIn(50), { draft: true });
  post(set.id, "2026-01-10", bankOut(50));
  post(set.id, "2026-01-10", bankIn(49.99));
  const otherSet = createSet("合成候选其他账套");
  post(otherSet.id, "2026-01-10", bankIn(50));

  const single = B.listCandidates(db, { accountSetId: set.id, bankAccountId: bank, transactionId: txnId });
  assert.equal(single.selection, "single");
  assert.equal(single.candidates.length, 1);
  assert.equal(single.candidates[0].voucherId, vIn.id);
  assert.equal(single.candidates[0].amountCents, 5000);
  assert.equal(single.candidates[0].available, true);

  const vSecond = post(set.id, "2026-01-10", bankIn(50));
  const multi = B.listCandidates(db, { accountSetId: set.id, bankAccountId: bank, transactionId: txnId });
  assert.equal(multi.selection, "requires_manual_choice");
  assert.equal(multi.candidates.length, 2);
  assert.deepEqual(multi.candidates.map((c) => c.voucherId).sort(), [vIn.id, vSecond.id].sort());

  // 日期窗口：默认同日；显式窗口必须有界，不能无限回溯。
  assert.throws(() => B.listCandidates(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnId,
    from: "2026-01-01", to: "2026-01-31",
  }), (e) => e.code === "date_window_too_wide");
  const wide = B.listCandidates(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnId, dateToleranceDays: 2,
  });
  assert.equal(wide.window.from, "2026-01-08");
  assert.equal(wide.window.to, "2026-01-12");
  assert.equal(wide.candidates.length, 2);
  assert.throws(() => B.listCandidates(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnId, dateToleranceDays: 99,
  }), (e) => e.code === "date_tolerance_invalid");

  // 组匹配：只给提示，不自动占用。
  const groupCsv = csvAmountDirection([{ date: "2026-01-15", summary: "组", amount: "300.00", direction: "inflow", refId: "G-1" }]);
  const groupTxn = importCsv(set.id, bank, "CAND-GROUP", groupCsv).transactionIds[0];
  const part1 = post(set.id, "2026-01-15", bankIn(100));
  const part2 = post(set.id, "2026-01-15", bankIn(200));
  const group = B.listCandidates(db, { accountSetId: set.id, bankAccountId: bank, transactionId: groupTxn });
  assert.equal(group.selection, "none");
  assert.equal(group.groupMatch.supported, false);
  assert.equal(group.groupMatch.code, "group_match_requires_manual");
  const pair = group.groupMatch.pairs.find((p) => p.length === 2);
  assert.ok(pair);
  const pairVouchers = pair.map((entryId) => db.prepare(`SELECT voucher_id FROM voucher_entries WHERE id=?`).get(entryId).voucher_id);
  assert.deepEqual(pairVouchers.sort(), [part1.id, part2.id].sort());
  assert.equal(group.candidates.length, 0, "组匹配绝不能自动选中");

  // 只有不可精确组合时给 unsupported，而不是声称已实现自动组合搜索。
  const oddCsv = csvAmountDirection([{ date: "2026-01-16", summary: "奇", amount: "123.45", direction: "inflow", refId: "G-2" }]);
  const oddTxn = importCsv(set.id, bank, "CAND-UNSUPPORTED", oddCsv).transactionIds[0];
  const odd = B.listCandidates(db, { accountSetId: set.id, bankAccountId: bank, transactionId: oddTxn });
  assert.equal(odd.selection, "none");
  assert.equal(odd.groupMatch.code, "unsupported_group_match");
});

// ------------------------------------------------------------------ 确认 / 取消
test("确认匹配：事务内复核方向 / 金额 / 科目 / 过账状态 / 日期窗口；双重占用只成功一次", () => {
  const set = createSet("合成确认");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const csv = csvAmountDirection([
    { date: "2026-01-10", summary: "收款", amount: "50.00", direction: "inflow", refId: "CF-1" },
    { date: "2026-01-11", summary: "付款", amount: "30.00", direction: "outflow", refId: "CF-2" },
  ]);
  const imported = importCsv(set.id, bank, "CONF-1", csv);
  const [txnInId, txnOutId] = imported.transactionIds;
  const vIn = post(set.id, "2026-01-10", bankIn(50));
  const vOut = post(set.id, "2026-01-11", bankOut(30));
  const vDraft = post(set.id, "2026-01-10", bankIn(50), { draft: true });
  const entry = (voucherId, code = "1002") =>
    db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code=?`).get(voucherId, code).id;

  assert.throws(() => B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnInId,
    voucherId: vDraft.id, entryId: entry(vDraft.id), reason: "草稿",
  }), (e) => e.code === "voucher_not_posted");
  assert.throws(() => B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnInId,
    voucherId: vIn.id, entryId: entry(vIn.id, "1122"), reason: "非银行科目",
  }), (e) => e.code === "entry_not_bank_account");
  assert.throws(() => B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnOutId,
    voucherId: vIn.id, entryId: entry(vIn.id), reason: "方向不一致",
  }), (e) => e.code === "match_amount_mismatch");
  const otherSet = createSet("合成确认其他账套");
  const foreign = post(otherSet.id, "2026-01-10", bankIn(50));
  assert.throws(() => B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnInId,
    voucherId: foreign.id, entryId: entry(foreign.id), reason: "跨账套",
  }), (e) => e.code === "entry_account_set_mismatch");

  const confirmed = B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnInId,
    voucherId: vIn.id, entryId: entry(vIn.id), reason: "银行回单与凭证一致",
  });
  assert.equal(confirmed.match.status, "confirmed");
  assert.equal(confirmed.match.snapshot.amountCents, 5000);
  assert.throws(() => B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnInId,
    voucherId: vIn.id, entryId: entry(vIn.id), reason: "重复",
  }), (e) => e.code === "match_already_confirmed");
  // 同一分录不能被第二条同向同额流水占用。
  const secondInflow = importCsv(set.id, bank, "CONF-2", csvAmountDirection([
    { date: "2026-01-10", summary: "另一笔", amount: "50.00", direction: "inflow", refId: "CF-4" },
  ])).transactionIds[0];
  assert.throws(() => B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: secondInflow,
    voucherId: vIn.id, entryId: entry(vIn.id), reason: "占用同一分录",
  }), (e) => e.code === "entry_already_matched");

  // 日期偏差必须显式，默认同日。
  const late = post(set.id, "2026-01-13", bankIn(50));
  const lateTxnCsv = csvAmountDirection([{ date: "2026-01-11", summary: "晚到", amount: "50.00", direction: "inflow", refId: "CF-3" }]);
  const lateTxn = importCsv(set.id, bank, "CONF-DATE", lateTxnCsv).transactionIds[0];
  assert.throws(() => B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: lateTxn,
    voucherId: late.id, entryId: entry(late.id), reason: "超窗",
  }), (e) => e.code === "match_date_out_of_window");
  const okLate = B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: lateTxn,
    voucherId: late.id, entryId: entry(late.id), reason: "两日偏差已核对", dateToleranceDays: 2,
  });
  assert.equal(okLate.match.status, "confirmed");

  // 数据库级防双重占用：部分唯一索引直接拒绝重复的有效匹配（不依赖应用层预检查）。
  assert.throws(() => db.prepare(`INSERT INTO bank_matches
      (account_set_id, bank_account_id, currency, transaction_id, voucher_id, entry_id, entry_line_no,
       status, snapshot_json, reason, confirmed_at)
      VALUES (?,?, 'CNY', ?, ?, ?, 1, 'confirmed', '{}', 'dup', ?)`)
    .run(set.id, bank, txnInId, vIn.id, entry(vIn.id), new Date().toISOString()),
  /UNIQUE constraint failed/i);
  // 第二个独立连接（跨进程等价）确认另一条流水可以成功。
  const db2 = new DatabaseSync(dbPath);
  try {
    db2.exec("PRAGMA foreign_keys = ON");
    const viaSecond = B.confirmMatch(db2, {
      accountSetId: set.id, bankAccountId: bank, transactionId: txnOutId,
      voucherId: vOut.id, entryId: entry(vOut.id), reason: "第二连接确认",
    });
    assert.equal(viaSecond.match.status, "confirmed");
  } finally { db2.close(); }
});

test("取消 / 再确认：保留原记录、重复取消幂等、审计事件不丢失", () => {
  const set = createSet("合成取消");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const csv = csvAmountDirection([{ date: "2026-01-10", summary: "收款", amount: "70.00", direction: "inflow", refId: "CC-1" }]);
  const txnId = importCsv(set.id, bank, "CANCEL-1", csv).transactionIds[0];
  const voucher = post(set.id, "2026-01-10", bankIn(70));
  const entryId = db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'`).get(voucher.id).id;

  const confirmed = B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnId,
    voucherId: voucher.id, entryId, reason: "初次确认",
  });
  assert.throws(() => B.cancelMatch(db, {
    accountSetId: set.id, bankAccountId: bank, matchId: confirmed.match.matchId, reason: "",
  }), (e) => e.code === "cancel_reason_required");
  const cancelled = B.cancelMatch(db, {
    accountSetId: set.id, bankAccountId: bank, matchId: confirmed.match.matchId, reason: "凭证录错",
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.match.status, "cancelled");
  assert.equal(cancelled.match.reason, "初次确认", "取消后仍保留原确认理由");
  const cancelledAudit = count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='match_cancelled'`, set.id);
  const again = B.cancelMatch(db, {
    accountSetId: set.id, bankAccountId: bank, matchId: confirmed.match.matchId, reason: "重复取消",
  });
  assert.equal(again.cancelled, false);
  assert.equal(again.idempotent, true);
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='match_cancelled'`, set.id),
    cancelledAudit,
    "重复取消不得重复刷审计",
  );

  // 取消释放占用，可以再次确认并产生新记录。
  const reconfirmed = B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnId,
    voucherId: voucher.id, entryId, reason: "改正后重新确认",
  });
  assert.notEqual(reconfirmed.match.matchId, confirmed.match.matchId);
  const all = db.prepare(`SELECT id, status FROM bank_matches WHERE account_set_id=? ORDER BY id`).all(set.id);
  assert.deepEqual(all.map((m) => m.status), ["cancelled", "confirmed"]);
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='match_confirmed'`, set.id), 2);
});

// ------------------------------------------------------------------ 失效
test("反过账：查询立即失效、审计只记一次、重过账不自动恢复、可重新确认", () => {
  const set = createSet("合成失效");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const csv = csvAmountDirection([
    { date: "2026-01-15", summary: "收款", amount: "20.00", direction: "inflow", refId: "INV-1" },
  ]);
  const txnId = importCsv(set.id, bank, "INVALID-1", csv).transactionIds[0];
  const voucher = post(set.id, "2026-01-15", bankIn(20));
  const entryId = db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'`).get(voucher.id).id;
  const match = B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnId,
    voucherId: voucher.id, entryId, reason: "核对一致",
  });

  A.unpostVoucher(set.id, voucher.id);
  const view = B.listMatchesView(db, { accountSetId: set.id, bankAccountId: bank });
  assert.equal(view.matches[0].status, "invalidated");
  assert.equal(view.matches[0].invalidationReason, "voucher_unposted");
  assert.equal(view.invalidations.length, 1);
  const auditCount = count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='match_invalidated'`, set.id);
  assert.equal(auditCount, 1);
  // 再次查询不重复刷失效审计。
  B.listTransactionsView(db, { accountSetId: set.id, bankAccountId: bank });
  B.getBankStatus(db, { accountSetId: set.id, bankAccountId: bank });
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='match_invalidated'`, set.id),
    auditCount,
  );

  // 原样重新过账也不得恢复失效匹配。
  A.postVoucher(set.id, voucher.id);
  const afterRepost = B.listMatchesView(db, { accountSetId: set.id, bankAccountId: bank });
  assert.equal(afterRepost.matches[0].status, "invalidated");
  assert.equal(afterRepost.matches[0].validity, null, "失效匹配不再给「有效」状态");

  // 重新确认产生新记录（旧失效记录保留）。
  const reconfirmed = B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txnId,
    voucherId: voucher.id, entryId, reason: "重新复核后确认",
  });
  assert.equal(reconfirmed.match.status, "confirmed");
  assert.notEqual(reconfirmed.match.matchId, match.match.matchId);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM bank_matches WHERE account_set_id=? AND status='invalidated'`).get(set.id).n,
    1,
  );
});

test("结构改动（SQL）逐项识别：改金额 / 改日期 / 改科目 / 改行号 / 删除分录", () => {
  const scenarios = [
    {
      key: "amount",
      name: "金额",
      mutate: ({ voucherId, entryId }) => db.prepare(`UPDATE voucher_entries SET debit=debit+1 WHERE id=?`).run(entryId),
      reason: "entry_amount_changed",
    },
    {
      key: "date",
      name: "日期",
      mutate: ({ voucherId }) => db.prepare(`UPDATE vouchers SET voucher_date='2026-01-21' WHERE id=?`).run(voucherId),
      reason: "voucher_date_changed",
    },
    {
      key: "code",
      name: "科目",
      mutate: ({ entryId }) => db.prepare(`UPDATE voucher_entries SET code='1001' WHERE id=?`).run(entryId),
      reason: "entry_account_changed",
    },
    {
      key: "line",
      name: "行号",
      mutate: ({ entryId }) => db.prepare(`UPDATE voucher_entries SET line_no=line_no+10 WHERE id=?`).run(entryId),
      reason: "entry_line_changed",
    },
    {
      key: "delete",
      name: "删除分录",
      mutate: ({ entryId }) => db.prepare(`DELETE FROM voucher_entries WHERE id=?`).run(entryId),
      reason: "voucher_entry_missing",
    },
  ];
  for (const scenario of scenarios) {
    const set = createSet(`合成结构-${scenario.name}`);
    const bank = register(set.id, uniq("BANK")).account.bank_account_id;
    const csv = csvAmountDirection([{ date: "2026-01-20", summary: "收款", amount: "40.00", direction: "inflow", refId: `ST-${scenario.key}` }]);
    const txnId = importCsv(set.id, bank, `STRUCT-${scenario.key}`, csv).transactionIds[0];
    const voucher = post(set.id, "2026-01-20", bankIn(40));
    const entryId = db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'`).get(voucher.id).id;
    B.confirmMatch(db, {
      accountSetId: set.id, bankAccountId: bank, transactionId: txnId,
      voucherId: voucher.id, entryId, reason: "结构测试",
    });
    scenario.mutate({ voucherId: voucher.id, entryId });
    const view = B.listMatchesView(db, { accountSetId: set.id, bankAccountId: bank });
    const target = view.matches.find((m) => m.status === "invalidated");
    assert.ok(target, `${scenario.name}: 必须失效`);
    assert.equal(target.invalidationReason, scenario.reason, `${scenario.name}: 失效原因`);
  }
});

test("审计 append-only：删除账套级联清理银行业务数据，但不抹掉审计证据", () => {
  const set = createSet("合成审计");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  importCsv(set.id, bank, "AUDIT-1", csvAmountDirection([
    { date: "2026-01-05", summary: "收款", amount: "10.00", direction: "inflow", refId: "AU-1" },
  ]));
  const auditBefore = count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=?`, set.id);
  assert.ok(auditBefore >= 2);
  A.deleteAccountSet(set.id);
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_accounts WHERE account_set_id=?`, set.id), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_batches WHERE account_set_id=?`, set.id), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_transactions WHERE account_set_id=?`, set.id), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=?`, set.id), auditBefore,
    "审计事件不能被业务删除级联清空");
});

// ------------------------------------------------------------------ 余额调节
/** 固定手算场景（单位分）：期初两边 80000；账面未达收款 30000 / 付款 10000；银行未达收款 50000 / 付款 10000。 */
function fixedScenario({ bankOutflow = "100.00" } = {}) {
  const set = createSet("合成调节", [
    { code: "1002", debit: 800, credit: 0 },
    { code: "3001", debit: 0, credit: 800 },
  ]);
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  post(set.id, "2026-01-10", bankIn(300)); // 30000 分（企业已收银行未收）
  post(set.id, "2026-01-11", bankOut(100)); // 10000 分（企业已付银行未付）
  const csv = csvAmountDirection([
    { date: "2026-01-20", summary: "银行收款", amount: "500.00", direction: "inflow", refId: "RC-1" },
    { date: "2026-01-21", summary: "银行付款", amount: bankOutflow, direction: "outflow", refId: "RC-2" },
  ]);
  importCsv(set.id, bank, "REC-1", csv);
  return { set, bank };
}

test("余额调节固定手算：账面 100000、银行 120000、调节后两边 140000、差额 0", () => {
  const { set, bank } = fixedScenario();
  const before = snapshotAccounting();
  const result = B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, currency: "CNY", period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 80000n, // 800.00 元
    statementCloseCents: 120000n, // 1200.00 元
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31",
    statementSource: "合成 2026-01 银行对账单（期初 800.00 / 期末 1200.00）",
  });
  // 独立常量（手算，不调用被测公式生成），单位：分。
  assert.equal(result.book.openingCents, 80000);
  assert.equal(result.book.netCents, 20000); // +30000 -10000
  assert.equal(result.book.closingCents, 100000); // 100000 分
  assert.equal(result.statement.openCents, 80000);
  assert.equal(result.statement.netCents, 40000); // +50000 -10000
  assert.equal(result.statement.computedCloseCents, 120000);
  assert.equal(result.statement.closeCents, 120000);
  assert.equal(result.statement.differenceCents, 0);
  assert.equal(result.outstanding.totals.bookReceivedBankMissingCents, 30000);
  assert.equal(result.outstanding.totals.bookPaidBankMissingCents, 10000);
  assert.equal(result.outstanding.totals.bankReceivedBookMissingCents, 50000);
  assert.equal(result.outstanding.totals.bankPaidBookMissingCents, 10000);
  // 调节后账面 = 100000 + 50000 - 10000 = 140000
  assert.equal(result.adjusted.bookCents, 140000);
  // 调节后银行 = 120000 + 30000 - 10000 = 140000
  assert.equal(result.adjusted.bankCents, 140000);
  assert.equal(result.adjusted.differenceCents, 0);
  assert.equal(result.status, "reconciled");
  assert.deepEqual(snapshotAccounting(), before, "余额调节不得生成或修改任何账务凭证 / 期间");
  const run = db.prepare(`SELECT status, difference_cents FROM bank_reconcile_runs WHERE id=?`).get(result.reconcileRunId);
  assert.equal(run.status, "reconciled");
  assert.equal(Number(run.difference_cents), 0);
});

test("余额调节 1 分差异：暴露对账单余额不一致与调节差额，不自动改余额或补项", () => {
  const { set, bank } = fixedScenario({ bankOutflow: "100.01" }); // 10001 分
  const before = snapshotAccounting();
  const result = B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 80000n,
    statementCloseCents: 120000n, // 声明的银行截止余额保持不变
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31",
    statementSource: "合成 2026-01 银行对账单",
  });
  assert.equal(result.statement.computedCloseCents, 119999, "80000 + 50000 - 10001 = 119999");
  assert.equal(result.statement.differenceCents, 1, "声明的期末与计算期末相差 1 分");
  assert.equal(result.outstanding.totals.bankPaidBookMissingCents, 10001);
  assert.equal(result.adjusted.bookCents, 139999, "银行未达付款 10001 使调节后账面少 1 分");
  assert.equal(result.adjusted.bankCents, 140000);
  assert.equal(result.adjusted.differenceCents, -1);
  assert.equal(result.status, "pending_review");
  assert.ok(result.issues.some((i) => i.code === "statement_balance_mismatch"));
  assert.ok(result.issues.some((i) => i.code === "adjusted_balance_difference"));
  assert.equal(result.statement.closeCents, 120000, "不得自动改声明余额");
  assert.deepEqual(snapshotAccounting(), before);
});

test("余额调节：跨月上期未达、期初贷方余额（负数）、非零差额", () => {
  const set = createSet("合成跨月", [
    { code: "1002", debit: 0, credit: 5000 }, // 贷方余额 = -5000.00
    { code: "1001", debit: 5000, credit: 0 },
  ], "2025-12");
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  post(set.id, "2025-12-20", bankIn(20000)); // 上期未达收款 20000.00
  const result = B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 1500000n, statementCloseCents: 1500000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31",
    statementSource: "合成 2026-01 对账单（期初=期末 15000.00）",
  });
  assert.equal(result.book.openingCents, -500000);
  assert.equal(result.book.closingCents, 1500000);
  assert.equal(result.outstanding.totals.bookReceivedBankMissingCents, 2000000, "跨月上期未达必须列入未达项");
  assert.equal(result.outstanding.bookReceivedBankMissing[0].voucherDate, "2025-12-20");
  assert.equal(result.adjusted.bookCents, 1500000);
  assert.equal(result.adjusted.bankCents, 3500000);
  assert.equal(result.adjusted.differenceCents, -2000000);
  assert.equal(result.status, "pending_review");
});

test("余额调节：覆盖不完整 / 缺来源 / 未决歧义 / 失效匹配 都不得声明已对平", () => {
  const { set, bank } = fixedScenario();
  assert.throws(() => B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 80000n, statementCloseCents: 120000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "",
  }), (e) => e.code === "statement_source_required");
  assert.throws(() => B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-02-05",
    statementOpenCents: 80000n, statementCloseCents: 120000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成",
  }), (e) => e.code === "as_of_period_mismatch");

  // 覆盖截止早于 asOf -> incomplete（即使两边数字相等）。
  const partial = B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 80000n, statementCloseCents: 120000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-25", statementSource: "合成（覆盖不足）",
  });
  assert.equal(partial.status, "incomplete");
  assert.ok(partial.issues.some((i) => i.code === "statement_coverage_incomplete"));

  // 未决歧义 -> pending_review，并降级已完成批次状态。
  const ambSet = createSet("合成调节歧义");
  const ambBank = register(ambSet.id, uniq("BANK")).account.bank_account_id;
  const row = { date: "2026-01-05", summary: "同", amount: "10.00", direction: "inflow" };
  importCsv(ambSet.id, ambBank, "REC-AMB-1", csvAmountDirection([row, row]));
  importCsv(ambSet.id, ambBank, "REC-AMB-2", csvAmountDirection([row]));
  const amb = B.reconcileBank(db, {
    accountSetId: ambSet.id, bankAccountId: ambBank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 2000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成",
  });
  assert.equal(amb.status, "pending_review");
  assert.ok(amb.issues.some((i) => i.code === "unresolved_ambiguity"));

  // 失效匹配 -> pending_review（即使调节后两边相等）。
  const invSet = createSet("合成调节失效");
  const invBank = register(invSet.id, uniq("BANK")).account.bank_account_id;
  const txnId = importCsv(invSet.id, invBank, "REC-INV-1", csvAmountDirection([
    { date: "2026-01-05", summary: "x", amount: "10.00", direction: "inflow", refId: "RI-1" },
  ])).transactionIds[0];
  const voucher = post(invSet.id, "2026-01-05", bankIn(10));
  const entryId = db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'`).get(voucher.id).id;
  B.confirmMatch(db, {
    accountSetId: invSet.id, bankAccountId: invBank, transactionId: txnId,
    voucherId: voucher.id, entryId, reason: "核对",
  });
  A.unpostVoucher(invSet.id, voucher.id);
  const inv = B.reconcileBank(db, {
    accountSetId: invSet.id, bankAccountId: invBank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 80000n, statementCloseCents: 80000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成",
  });
  assert.equal(inv.status, "pending_review");
  assert.ok(inv.issues.some((i) => i.code === "match_invalidated"));
});

test("银行流水是独立数据：对账 / 匹配都不改变凭证与期间状态", () => {
  const { set, bank } = fixedScenario();
  const before = snapshotAccounting();
  const periodsBefore = db.prepare(`SELECT * FROM periods WHERE account_set_id=? ORDER BY period`).all(set.id);
  B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 80000n, statementCloseCents: 120000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成",
  });
  const txn = B.listTransactionsView(db, { accountSetId: set.id, bankAccountId: bank }).transactions[0];
  const candidate = B.listCandidates(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txn.transactionId,
  });
  void candidate;
  assert.deepEqual(snapshotAccounting(), before);
  assert.deepEqual(db.prepare(`SELECT * FROM periods WHERE account_set_id=? ORDER BY period`).all(set.id), periodsBefore,
    "银行对账不得自动改 periods 状态");
});

// ================================================================== 首轮独立审查 5 项阻塞回归
/** 独立金额常量（分）：每笔 1.00 元 = 100 分；501 笔合计 50100 分（手算，不用被测公式生成）。 */
const UNIT_CENTS = 100;
const BULK_N = 501;
const BULK_TOTAL_CENTS = 50100;

const bulkCsv = (count, prefix) => csvAmountDirection(Array.from({ length: count }, (_, i) => ({
  date: "2026-01-15", summary: `批量${i + 1}`, amount: "1.00", direction: "inflow", refId: `${prefix}-${i + 1}`,
})));

test("内部判定不被展示分页截断：501 条有效匹配全部参与未达项 / 候选占用 / 失效核验", () => {
  const set = createSet("合成分页截断", []); // 期初 0，全部金额来自本期
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const imported = importCsv(set.id, bank, "PAGE-501", bulkCsv(BULK_N, "PG"));
  assert.equal(imported.batch.importedRows, BULK_N);

  const voucherIds = [];
  for (let i = 0; i < BULK_N; i += 1) {
    const voucher = post(set.id, "2026-01-15", bankIn(1));
    voucherIds.push(voucher.id);
    B.confirmMatch(db, {
      accountSetId: set.id, bankAccountId: bank, transactionId: imported.transactionIds[i],
      voucherId: voucher.id, entryId: entryOfVoucher(voucher.id), reason: `第 ${i + 1} 笔复核一致`,
    });
  }
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_matches WHERE account_set_id=? AND status='confirmed'`, set.id), BULK_N);

  const reconciled = B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: BigInt(BULK_TOTAL_CENTS),
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成 501 笔对账单",
  });
  // 500 条以后的那一笔不得被当成未达项重复列在两侧。
  assert.equal(reconciled.outstanding.bookReceivedBankMissing.length, 0, "全部已核销后不得残留企业已收银行未收");
  assert.equal(reconciled.outstanding.bankReceivedBookMissing.length, 0, "全部已核销后不得残留银行已收企业未收");
  assert.equal(reconciled.outstanding.totals.bookReceivedBankMissingCents, 0);
  assert.equal(reconciled.outstanding.totals.bankReceivedBookMissingCents, 0);
  assert.equal(reconciled.book.closingCents, BULK_TOTAL_CENTS);
  assert.equal(reconciled.adjusted.bookCents, BULK_TOTAL_CENTS);
  assert.equal(reconciled.adjusted.bankCents, BULK_TOTAL_CENTS);
  assert.equal(reconciled.adjusted.differenceCents, 0);
  assert.equal(reconciled.matches.confirmed, BULK_N);
  assert.equal(reconciled.status, "reconciled");

  // 候选占用：第 501 条已占用分录也必须 available=false，不能被报成可再次占用。
  const extra = importCsv(set.id, bank, "PAGE-501-EXTRA", csvAmountDirection([
    { date: "2026-01-15", summary: "额外一笔", amount: "1.00", direction: "inflow", refId: "PG-EXTRA" },
  ]));
  const candidates = B.listCandidates(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: extra.transactionIds[0],
  });
  assert.equal(candidates.candidates.length, BULK_N);
  assert.equal(candidates.selection, "requires_manual_choice");
  for (const item of candidates.candidates) {
    assert.equal(item.available, false, `分录 ${item.entryId} 已占用却报成可用`);
    assert.ok(item.claimedByMatchId, `分录 ${item.entryId} 缺少占用匹配 ID`);
  }

  // 失效核验：反过账最后一笔后，checked 必须是 501，且该匹配立即失效。
  A.unpostVoucher(set.id, voucherIds[voucherIds.length - 1]);
  const view = B.listMatchesView(db, { accountSetId: set.id, bankAccountId: bank });
  assert.equal(view.invalidations.length, 1, "第 501 条之后的失效必须被发现");
  assert.equal(view.invalidations[0].reason, "voucher_unposted");
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_matches WHERE account_set_id=? AND status='invalidated'`, set.id), 1);
  const refresh = B.refreshMatchStates(db, { accountSetId: set.id, bankAccountId: bank });
  assert.equal(refresh.checked, BULK_N - 1, "核验范围必须覆盖全部剩余有效匹配");
});

test("批次与待决歧义真实数量不受展示分页影响（201 批次 / 501 待决歧义）", () => {
  // 批次：201 个批次，展示只给一页，但计数必须真实。
  const batchSet = createSet("合成分页批次", []);
  const batchBank = register(batchSet.id, uniq("BANK")).account.bank_account_id;
  for (let i = 1; i <= 201; i += 1) {
    S.insertBatch(db, {
      accountSetId: batchSet.id, bankAccountId: batchBank, sourceId: "local-statement",
      batchId: `PAGE-BATCH-${i}`, currency: "CNY", period: "2026-01",
      contentSha256: `digest-${i}`, mappingFingerprint: "fingerprint",
      normalizationVersion: I.NORMALIZATION_VERSION, status: "completed",
    });
  }
  const status = B.getBankStatus(db, { accountSetId: batchSet.id, bankAccountId: batchBank });
  assert.equal(status.batches.total, 201, "批次总数必须是真实数量，不是展示页长度");
  assert.equal(status.batches.completed, 201);
  assert.equal(status.batches.pendingReview, 0);
  assert.equal(status.batches.failed, 0);
  assert.ok(status.batches.items.length <= status.batches.itemsLimit, "展示分页仍有明确边界");
  assert.equal(status.batches.items.length, 200);
  assert.equal(status.batches.itemsTruncated, true);

  // 待决歧义：501 条 pending，对账问题计数必须是 501（不是 500）。
  const ambSet = createSet("合成分页歧义", []);
  const ambBank = register(ambSet.id, uniq("BANK")).account.bank_account_id;
  const dupRows = Array.from({ length: BULK_N }, () => ({
    date: "2026-01-05", summary: "同摘要", amount: "1.00", direction: "inflow",
  }));
  const firstFile = csvAmountDirection(dupRows).trimEnd();
  const firstImport = importCsv(ambSet.id, ambBank, "PAGE-AMB-1", `${firstFile}\n`);
  assert.equal(firstImport.batch.importedRows, BULK_N);
  // 内容摘要不同（末尾多一个换行）、规范化行完全相同 -> 每行都是待人工判定的疑似重复。
  const secondImport = importCsv(ambSet.id, ambBank, "PAGE-AMB-2", `${firstFile}\n\n`);
  assert.equal(secondImport.batch.ambiguousRows, BULK_N);

  const reconciled = B.reconcileBank(db, {
    accountSetId: ambSet.id, bankAccountId: ambBank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: BigInt(BULK_TOTAL_CENTS),
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成歧义对账单",
  });
  assert.equal(reconciled.ambiguities.pending, BULK_N, "待决歧义数量必须是真实数量");
  const issue = reconciled.issues.find((i) => i.code === "unresolved_ambiguity");
  assert.ok(issue, "必须给出未决歧义问题");
  assert.equal(issue.details.count, BULK_N);
  assert.ok(issue.details.items.length <= 20, "证据条数有上限");
  assert.equal(reconciled.status, "pending_review");
  const ambStatus = B.getBankStatus(db, { accountSetId: ambSet.id, bankAccountId: ambBank });
  assert.equal(ambStatus.ambiguities.pending, BULK_N);
});

test("余额调节按截止日 asOf 判定未达项：合法跨日匹配不得提前消除，截止后两侧都发生正常消除", () => {
  // 1) 1 月 31 日账面收款 1000.00，2 月 1 日银行收款 1000.00，容差 1 天确认。
  const set = createSet("合成跨日截止", []);
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const janVoucher = post(set.id, "2026-01-31", bankIn(1000));
  const febTxn = importCsv(set.id, bank, "ASOF-IN", csvAmountDirection([
    { date: "2026-02-01", summary: "次日到账", amount: "1000.00", direction: "inflow", refId: "AS-1" },
  ]), MAPPING_AMOUNT_DIRECTION, { period: "2026-02" });
  B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: febTxn.transactionIds[0],
    voucherId: janVoucher.id, entryId: entryOfVoucher(janVoucher.id),
    reason: "跨日 1 天已核对", dateToleranceDays: 1,
  });
  const jan = B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 0n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成 1 月对账单",
  });
  // 独立手算：账面截止 1000.00；银行截止 0.00；未达「企业已收银行未收」1000.00
  // 调节后账面 = 1000.00，调节后银行 = 0.00 + 1000.00 = 1000.00，差额 0。
  assert.equal(jan.book.closingCents, 100000);
  assert.equal(jan.statement.closeCents, 0);
  assert.deepEqual(jan.outstanding.bookReceivedBankMissing.map((i) => i.amountCents), [100000]);
  assert.equal(jan.outstanding.totals.bookReceivedBankMissingCents, 100000);
  assert.equal(jan.outstanding.bankReceivedBookMissing.length, 0);
  assert.equal(jan.adjusted.bookCents, 100000);
  assert.equal(jan.adjusted.bankCents, 100000);
  assert.equal(jan.adjusted.differenceCents, 0);
  assert.equal(jan.status, "reconciled");
  // 匹配本身仍然有效（不禁止合法跨日匹配）。
  assert.equal(jan.matches.confirmed, 1);

  // 2) 反方向：1 月 31 日账面付款 1000.00，2 月 1 日银行付款。
  const outSet = createSet("合成跨日截止反向", []);
  const outBank = register(outSet.id, uniq("BANK")).account.bank_account_id;
  const outVoucher = post(outSet.id, "2026-01-31", bankOut(1000));
  const febOut = importCsv(outSet.id, outBank, "ASOF-OUT", csvAmountDirection([
    { date: "2026-02-01", summary: "次日付款", amount: "1000.00", direction: "outflow", refId: "AS-2" },
  ]), MAPPING_AMOUNT_DIRECTION, { period: "2026-02" });
  B.confirmMatch(db, {
    accountSetId: outSet.id, bankAccountId: outBank, transactionId: febOut.transactionIds[0],
    voucherId: outVoucher.id, entryId: entryOfVoucher(outVoucher.id),
    reason: "跨日付款已核对", dateToleranceDays: 1,
  });
  const janOut = B.reconcileBank(db, {
    accountSetId: outSet.id, bankAccountId: outBank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 0n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成 1 月对账单",
  });
  assert.equal(janOut.book.closingCents, -100000);
  assert.equal(janOut.outstanding.totals.bookPaidBankMissingCents, 100000);
  assert.equal(janOut.outstanding.totals.bookReceivedBankMissingCents, 0);
  assert.equal(janOut.adjusted.bookCents, -100000);
  assert.equal(janOut.adjusted.bankCents, -100000);
  assert.equal(janOut.adjusted.differenceCents, 0);

  // 3) 截止日两侧都已发生：正常消除（不得因为 asOf 判定把已核销项留在未达里）。
  const sameSet = createSet("合成同侧截止", []);
  const sameBank = register(sameSet.id, uniq("BANK")).account.bank_account_id;
  const sameVoucher = post(sameSet.id, "2026-01-05", bankIn(1000));
  const sameTxn = importCsv(sameSet.id, sameBank, "ASOF-SAME", csvAmountDirection([
    { date: "2026-01-06", summary: "次日到账（仍在截止日前）", amount: "1000.00", direction: "inflow", refId: "AS-3" },
  ]));
  B.confirmMatch(db, {
    accountSetId: sameSet.id, bankAccountId: sameBank, transactionId: sameTxn.transactionIds[0],
    voucherId: sameVoucher.id, entryId: entryOfVoucher(sameVoucher.id),
    reason: "两侧都在截止日前", dateToleranceDays: 1,
  });
  const same = B.reconcileBank(db, {
    accountSetId: sameSet.id, bankAccountId: sameBank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 100000n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成 1 月对账单",
  });
  assert.equal(same.outstanding.totals.bookReceivedBankMissingCents, 0);
  assert.equal(same.outstanding.totals.bankReceivedBookMissingCents, 0);
  assert.equal(same.book.matchedEntryCount, 1);
  assert.equal(same.adjusted.bookCents, 100000);
  assert.equal(same.adjusted.bankCents, 100000);
  assert.equal(same.status, "reconciled");
});

test("对账结果持久化原子：插运行记录或插审计失败时全组件回滚、不废弃旧结果", () => {
  const set = createSet("合成对账原子", []);
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  post(set.id, "2026-01-10", bankIn(500));
  const options = {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 0n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成原子对账单",
  };
  const first = B.reconcileBank(db, options);
  assert.ok(first.reconcileRunId);
  const runsBefore = db.prepare(`SELECT id, stale, stale_reason FROM bank_reconcile_runs WHERE account_set_id=? ORDER BY id`).all(set.id)
    .map((r) => ({ id: Number(r.id), stale: Number(r.stale), reason: r.stale_reason }));
  const auditBefore = count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='reconcile_computed'`, set.id);
  const snapshotBefore = snapshotBank();

  // 1) 插审计失败：旧运行记录不能被标记 stale，也不能留下无审计的新结果。
  db.exec(`CREATE TRIGGER bank_test_audit_fail BEFORE INSERT ON bank_audit_events
             WHEN NEW.event_type = 'reconcile_computed'
             BEGIN SELECT RAISE(ABORT, 'injected_audit_failure'); END`);
  try {
    assert.throws(() => B.reconcileBank(db, options), /injected_audit_failure|constraint|ABORT/i);
    assert.deepEqual(
      db.prepare(`SELECT id, stale, stale_reason FROM bank_reconcile_runs WHERE account_set_id=? ORDER BY id`).all(set.id)
        .map((r) => ({ id: Number(r.id), stale: Number(r.stale), reason: r.stale_reason })),
      runsBefore,
      "插审计失败不得废弃旧运行记录",
    );
    assert.equal(count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='reconcile_computed'`, set.id), auditBefore);
    assert.deepEqual(snapshotBank(), snapshotBefore, "插审计失败后银行组件状态必须完全回滚");
  } finally {
    db.exec(`DROP TRIGGER bank_test_audit_fail`);
  }

  // 2) 插运行记录失败：同样不得留下新审计、不得误废弃旧结果。
  db.exec(`CREATE TRIGGER bank_test_run_fail BEFORE INSERT ON bank_reconcile_runs
             BEGIN SELECT RAISE(ABORT, 'injected_run_failure'); END`);
  try {
    assert.throws(() => B.reconcileBank(db, options), /injected_run_failure|constraint|ABORT/i);
    assert.deepEqual(
      db.prepare(`SELECT id, stale, stale_reason FROM bank_reconcile_runs WHERE account_set_id=? ORDER BY id`).all(set.id)
        .map((r) => ({ id: Number(r.id), stale: Number(r.stale), reason: r.stale_reason })),
      runsBefore,
      "插运行记录失败不得废弃旧运行记录",
    );
    assert.equal(count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='reconcile_computed'`, set.id), auditBefore);
    assert.deepEqual(snapshotBank(), snapshotBefore, "插运行记录失败后银行组件状态必须完全回滚");
  } finally {
    db.exec(`DROP TRIGGER bank_test_run_fail`);
  }

  // 3) 故障排除后同一请求成功，旧记录被正确标记 stale 且只增加一条运行记录 + 一条审计。
  const ok = B.reconcileBank(db, options);
  const runsAfter = db.prepare(`SELECT id, stale FROM bank_reconcile_runs WHERE account_set_id=? ORDER BY id`).all(set.id)
    .map((r) => ({ id: Number(r.id), stale: Number(r.stale) }));
  assert.equal(runsAfter.length, runsBefore.length + 1);
  assert.equal(runsAfter[runsAfter.length - 1].id, ok.reconcileRunId);
  assert.equal(runsAfter[0].stale, 1);
  assert.equal(count(`SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=? AND event_type='reconcile_computed'`, set.id), auditBefore + 1);
});

function entryOfVoucher(voucherId) {
  return db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'`).get(voucherId).id;
}

function bankTableNames(conn) {
  return conn.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    .map((r) => String(r.name)).filter((n) => n.startsWith("bank_")).sort();
}

function bankRowCounts(conn) {
  return Object.fromEntries(bankTableNames(conn).map((name) => [
    name, Number(conn.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n),
  ]));
}

/** 仅用于门槛顺序 / 结构篡改夹具的「形状完整」fake；真实备份链路由独立 integration 测试验证。 */
function fakeBackupService(file) {
  const sha = "a".repeat(64);
  const manifest = {
    snapshot: { file: "workbench.db.snapshot", bytes: 1, sha256: sha },
    source: { file: basename(file) },
    structure: { schemaVersion: 0 },
    components: [],
  };
  return {
    createBackup: ({ outDir }) => ({
      ok: true, status: "ok", backupDir: join(outDir, "fake-backup"),
      backupMeta: { snapshotBytes: 1, snapshotSha256: sha }, manifest,
    }),
    verifyBackup: () => ({
      ok: true, status: "ok",
      summary: { snapshotBytes: 1, snapshotSha256: sha }, manifest,
    }),
  };
}

/** 造一个「已迁移好银行组件」的独立临时库（最小真实账务结构 + 1002 叶子科目 + 1 个账套）。 */
async function isolatedComponentDb(dir, name) {
  const file = join(dir, name);
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA foreign_keys = ON");
  createLegacySchema(conn);
  conn.exec(`INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
              VALUES (1, '1002', '银行存款', '资产', 'debit', 0, 1)`);
  const backup = fakeBackupService(file);
  const migrated = await S.ensureBankSchema(conn, { dbPath: file, backupService: backup });
  assert.equal(migrated.migrated, true);
  assert.equal(S.bankSchemaContract(conn).ok, true, "健康组件库必须通过结构契约");
  return { conn, file };
}

const contractWriteCalls = (conn) => [
  ["registerBankAccount", () => B.registerBankAccount(conn, {
    accountSetId: 1, bankAccountId: "BANK-CONTRACT", sourceId: "src-1", glAccountCode: "1002",
  })],
  ["importBankBatch", () => B.importBankBatch(conn, {
    accountSetId: 1, bankAccountId: "BANK-CONTRACT", sourceId: "src-1", period: "2026-01",
    batchId: "CONTRACT-1", csvText: "日期,摘要,金额,方向\n2026-01-05,x,1.00,收\n", mapping: MAPPING_AMOUNT_DIRECTION,
  })],
  ["confirmMatch", () => B.confirmMatch(conn, {
    accountSetId: 1, bankAccountId: "BANK-CONTRACT", transactionId: 1, voucherId: 1, entryId: 1, reason: "x",
  })],
  ["resolveAmbiguity", () => B.resolveAmbiguity(conn, {
    accountSetId: 1, bankAccountId: "BANK-CONTRACT", ambiguityId: 1, decision: "distinct", reason: "x",
  })],
  ["reconcileBank", () => B.reconcileBank(conn, {
    accountSetId: 1, bankAccountId: "BANK-CONTRACT", period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 0n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "x",
  })],
  ["listTransactionsView", () => B.listTransactionsView(conn, { accountSetId: 1, bankAccountId: "BANK-CONTRACT" })],
];

test("组件结构 / 版本契约：未来版本、矛盾版本、缺表 / 缺列 / 唯一索引 / 外键动作都在业务写前拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-contract-"));
  const assertBlocked = async ({ conn, file }, expectedCode) => {
    const state = S.bankSchemaContract(conn);
    assert.equal(state.ok, false);
    assert.equal(state.code, expectedCode);
    const tablesBefore = bankTableNames(conn);
    const rowsBefore = bankRowCounts(conn);
    await assert.rejects(() => S.ensureBankSchema(conn, { dbPath: file }), (e) => e.code === expectedCode);
    for (const [label, call] of contractWriteCalls(conn)) {
      assert.throws(call, (e) => e.code === expectedCode, `${expectedCode}: ${label} 必须拒绝`);
    }
    assert.deepEqual(bankRowCounts(conn), rowsBefore, `${expectedCode}: 失败不得写入任何 bank_* 数据`);
    assert.deepEqual(bankTableNames(conn), tablesBefore, `${expectedCode}: 不得用 CREATE IF NOT EXISTS 修补坏库`);
    return state;
  };

  try {
    // 未来的组件版本：不能当 already-initialized 放行。
    {
      const ctx = await isolatedComponentDb(dir, "future.db");
      try {
        ctx.conn.prepare(`INSERT INTO bank_component_migrations (version, applied_at) VALUES (2, ?)`)
          .run(new Date().toISOString());
        await assertBlocked(ctx, "bank_schema_future_version");
      } finally { ctx.conn.close(); }
    }

    // 版本记录与表结构矛盾：表在、版本行丢了。
    {
      const ctx = await isolatedComponentDb(dir, "contradiction.db");
      try {
        ctx.conn.exec(`DELETE FROM bank_component_migrations`);
        await assertBlocked(ctx, "bank_schema_version_contradiction");
      } finally { ctx.conn.close(); }
    }

    // 缺表：不能静默补建。
    {
      const ctx = await isolatedComponentDb(dir, "missing-table.db");
      try {
        ctx.conn.exec(`DROP TABLE bank_reconcile_runs`);
        const state = await assertBlocked(ctx, "bank_schema_corrupt");
        assert.ok(state.problems.some((p) => p.code === "bank_schema_table_missing" && p.detail.table === "bank_reconcile_runs"));
      } finally { ctx.conn.close(); }
    }

    // 缺关键列。
    {
      const ctx = await isolatedComponentDb(dir, "missing-column.db");
      try {
        ctx.conn.exec(`ALTER TABLE bank_audit_events DROP COLUMN detail_json`);
        const state = await assertBlocked(ctx, "bank_schema_corrupt");
        assert.ok(state.problems.some((p) => p.code === "bank_schema_column_mismatch"
          && p.detail.table === "bank_audit_events" && p.detail.missing.includes("detail_json")));
      } finally { ctx.conn.close(); }
    }

    // 缺 UNIQUE（防双重占用）索引。
    {
      const ctx = await isolatedComponentDb(dir, "missing-unique.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_matches_active_txn`);
        const state = await assertBlocked(ctx, "bank_schema_corrupt");
        assert.ok(state.problems.some((p) => p.code === "bank_schema_index_missing"
          && p.detail.index === "idx_bank_matches_active_txn"));
      } finally { ctx.conn.close(); }
    }

    // 外键删除动作被改成 CASCADE：匹配证据会在删除流水时被连带抹掉，必须拒绝。
    {
      const ctx = await isolatedComponentDb(dir, "fk-action.db");
      try {
        ctx.conn.exec(`DROP TABLE bank_matches`);
        ctx.conn.exec(`CREATE TABLE bank_matches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_set_id INTEGER NOT NULL,
          bank_account_id TEXT NOT NULL,
          currency TEXT NOT NULL,
          transaction_id INTEGER REFERENCES bank_transactions(id) ON DELETE CASCADE,
          voucher_id INTEGER NOT NULL,
          entry_id INTEGER NOT NULL,
          entry_line_no INTEGER NOT NULL,
          status TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          confirmed_at TEXT NOT NULL,
          cancelled_at TEXT,
          cancel_reason TEXT,
          invalidated_at TEXT,
          invalidation_reason TEXT
        )`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_matches_active_txn
                         ON bank_matches (transaction_id) WHERE status = 'confirmed'`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_matches_active_entry
                         ON bank_matches (account_set_id, entry_id) WHERE status = 'confirmed'`);
        ctx.conn.exec(`CREATE INDEX idx_bank_matches_scope
                         ON bank_matches (account_set_id, bank_account_id, status)`);
        const state = await assertBlocked(ctx, "bank_schema_corrupt");
        assert.ok(state.problems.some((p) => p.code === "bank_schema_foreign_key_missing"
          && p.detail.table === "bank_matches" && p.detail.onDelete === "SET NULL"));
      } finally { ctx.conn.close(); }
    }

    // 未声明的额外 bank_* 表：本版本不假定它兼容。
    {
      const ctx = await isolatedComponentDb(dir, "unexpected-table.db");
      try {
        ctx.conn.exec(`CREATE TABLE bank_extra_probe (id INTEGER PRIMARY KEY)`);
        const state = await assertBlocked(ctx, "bank_schema_corrupt");
        assert.ok(state.problems.some((p) => p.code === "bank_schema_unexpected_table"));
        ctx.conn.exec(`DROP TABLE bank_extra_probe`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "移除额外表后契约恢复");
      } finally { ctx.conn.close(); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("部分索引契约核对真实 WHERE 谓词：同名同列同 UNIQUE/partial 的错谓词拒绝，写法差异不误判", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-predicate-"));
  const expectCorrupt = async (ctx, indexName) => {
    const state = S.bankSchemaContract(ctx.conn);
    assert.equal(state.ok, false, `${indexName}: 错谓词必须破坏契约`);
    assert.equal(state.code, "bank_schema_corrupt");
    const problem = state.problems.find((p) => p.code === "bank_schema_index_mismatch"
      && p.detail.index === indexName);
    assert.ok(problem, `${indexName}: 必须给出索引谓词不符的结构化问题`);
    await assert.rejects(() => S.ensureBankSchema(ctx.conn, { dbPath: ctx.file }),
      (e) => e.code === "bank_schema_corrupt");
    return problem;
  };

  try {
    // 1) 有效流水部分唯一索引：同名 / 同列 / 同 UNIQUE / 同 partial，只把谓词改错。
    {
      const ctx = await isolatedComponentDb(dir, "predicate-active-txn.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_matches_active_txn`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_matches_active_txn
                         ON bank_matches (transaction_id) WHERE status = 'cancelled'`);
        const problem = await expectCorrupt(ctx, "idx_bank_matches_active_txn");
        assert.equal(problem.detail.expected.where, "status = 'confirmed'");
        assert.notEqual(problem.detail.actual.where, problem.detail.expected.where);
        // 恢复正确谓词，但换成压缩空白 + 双引号标识符：规范化后必须通过（兼容产品实际 DDL）。
        ctx.conn.exec(`DROP INDEX idx_bank_matches_active_txn`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_matches_active_txn
                         ON bank_matches (transaction_id) WHERE "status"  =  'confirmed'`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "空白 / 引号写法差异不得误判为坏索引");
      } finally { ctx.conn.close(); }
    }

    // 2) 有效分录部分唯一索引：谓词改成 status <> 'confirmed'。
    {
      const ctx = await isolatedComponentDb(dir, "predicate-active-entry.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_matches_active_entry`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_matches_active_entry
                         ON bank_matches (account_set_id, entry_id) WHERE status <> 'confirmed'`);
        const problem = await expectCorrupt(ctx, "idx_bank_matches_active_entry");
        assert.equal(problem.detail.expected.where, "status = 'confirmed'");
        ctx.conn.exec(`DROP INDEX idx_bank_matches_active_entry`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_matches_active_entry
                         ON bank_matches (account_set_id, entry_id) WHERE status='confirmed'`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "去掉空格后仍应通过");
      } finally { ctx.conn.close(); }
    }

    // 3) 稳定流水 ID 部分唯一索引：谓词被放宽为恒真条件也必须拒绝。
    {
      const ctx = await isolatedComponentDb(dir, "predicate-txn-ref.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_txn_ref`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_txn_ref
                         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id)
                         WHERE bank_ref_id IS NOT NULL AND 1 = 1`);
        const problem = await expectCorrupt(ctx, "idx_bank_txn_ref");
        assert.equal(problem.detail.expected.where, "bank_ref_id IS NOT NULL");
        ctx.conn.exec(`DROP INDEX idx_bank_txn_ref`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_txn_ref
                         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id)
                         WHERE "bank_ref_id" IS NOT NULL`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "引号标识符写法差异不得误判");
      } finally { ctx.conn.close(); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("外键契约比较完整集合：audit / reconcile-runs 额外或重复外键拒绝，合法结构保留删除后审计证据", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-fk-set-"));
  const countIn = (conn, sql, ...args) => Number(conn.prepare(sql).get(...args).n);
  const rebuildAudit = (ctx, foreignKeys) => {
    ctx.conn.exec("PRAGMA foreign_keys = OFF");
    try {
      ctx.conn.exec(`CREATE TABLE bank_audit_events_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_set_id INTEGER,
        bank_account_id TEXT,
        event_type TEXT NOT NULL,
        subject_type TEXT NOT NULL DEFAULT '',
        subject_id TEXT NOT NULL DEFAULT '',
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
        ${foreignKeys ? `, ${foreignKeys}` : ""}
      )`);
      ctx.conn.exec(`INSERT INTO bank_audit_events_rebuild
                       (id, account_set_id, bank_account_id, event_type, subject_type, subject_id, detail_json, created_at)
                     SELECT id, account_set_id, bank_account_id, event_type, subject_type, subject_id, detail_json, created_at
                       FROM bank_audit_events`);
      ctx.conn.exec(`DROP TABLE bank_audit_events`);
      ctx.conn.exec(`ALTER TABLE bank_audit_events_rebuild RENAME TO bank_audit_events`);
      ctx.conn.exec(`CREATE INDEX idx_bank_audit_scope
                       ON bank_audit_events (account_set_id, bank_account_id, event_type)`);
    } finally {
      ctx.conn.exec("PRAGMA foreign_keys = ON");
    }
  };

  try {
    // 1) 合法结构：真实业务删除账套（与 accounting.deleteAccountSet 相同的 DELETE 语句）后审计证据仍在。
    {
      const ctx = await isolatedComponentDb(dir, "fk-legal.db");
      try {
        const auditId = S.appendAuditEvent(ctx.conn, {
          accountSetId: 1, eventType: "probe_legal", subjectType: "account_set", subjectId: "1",
        });
        assert.ok(auditId > 0);
        ctx.conn.exec(`DELETE FROM account_sets WHERE id=1`);
        assert.equal(countIn(ctx.conn, `SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=1`), 1,
          "无外键的审计表不得随账套删除消失");
        assert.equal(countIn(ctx.conn, `SELECT COUNT(*) AS n FROM bank_accounts WHERE account_set_id=1`), 0,
          "银行业务数据仍按既有外键级联清理");
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "合法结构删除后仍通过契约");
      } finally { ctx.conn.close(); }
    }

    // 2) bank_audit_events 仅增加 account_set_id -> account_sets ON DELETE CASCADE：必须拒绝。
    {
      const ctx = await isolatedComponentDb(dir, "fk-extra-audit.db");
      try {
        S.appendAuditEvent(ctx.conn, {
          accountSetId: 1, eventType: "probe_extra", subjectType: "account_set", subjectId: "1",
        });
        rebuildAudit(ctx, "FOREIGN KEY (account_set_id) REFERENCES account_sets (id) ON DELETE CASCADE");
        const state = S.bankSchemaContract(ctx.conn);
        assert.equal(state.ok, false);
        assert.equal(state.code, "bank_schema_corrupt");
        assert.ok(state.problems.some((p) => p.code === "bank_schema_foreign_key_unexpected"
          && p.detail.table === "bank_audit_events" && p.detail.refTable === "account_sets"
          && p.detail.onDelete === "CASCADE"), "额外外键必须结构化拒绝");
        await assert.rejects(() => S.ensureBankSchema(ctx.conn, { dbPath: ctx.file }),
          (e) => e.code === "bank_schema_corrupt");
        // 真实删除证据：该额外外键会把审计证据级联抹掉，这正是必须拒绝的原因。
        ctx.conn.exec(`DELETE FROM account_sets WHERE id=1`);
        assert.equal(countIn(ctx.conn, `SELECT COUNT(*) AS n FROM bank_audit_events WHERE account_set_id=1`), 0,
          "额外 CASCADE 外键会让审计证据随账套删除消失");
      } finally { ctx.conn.close(); }
    }

    // 3) 重复同目标外键：不能按 refTable 去重掩盖，必须逐条暴露为额外约束。
    {
      const ctx = await isolatedComponentDb(dir, "fk-duplicate-audit.db");
      try {
        rebuildAudit(ctx, `FOREIGN KEY (account_set_id) REFERENCES account_sets (id) ON DELETE CASCADE,
          FOREIGN KEY (account_set_id) REFERENCES account_sets (id) ON DELETE CASCADE`);
        const state = S.bankSchemaContract(ctx.conn);
        assert.equal(state.code, "bank_schema_corrupt");
        const unexpected = state.problems.filter((p) => p.code === "bank_schema_foreign_key_unexpected"
          && p.detail.table === "bank_audit_events" && p.detail.refTable === "account_sets");
        assert.equal(unexpected.length, 2, "重复同目标外键必须逐条暴露，不能被 Map 覆盖");
      } finally { ctx.conn.close(); }
    }

    // 4) bank_reconcile_runs 原本无外键：额外外键同样必须拒绝。
    {
      const ctx = await isolatedComponentDb(dir, "fk-extra-reconcile.db");
      try {
        ctx.conn.exec("PRAGMA foreign_keys = OFF");
        try {
          ctx.conn.exec(`CREATE TABLE bank_reconcile_runs_rebuild (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
            bank_account_id TEXT NOT NULL,
            currency TEXT NOT NULL,
            period TEXT NOT NULL,
            as_of TEXT NOT NULL,
            status TEXT NOT NULL,
            book_close_cents INTEGER NOT NULL,
            adjusted_book_cents INTEGER NOT NULL,
            statement_close_cents INTEGER NOT NULL,
            adjusted_bank_cents INTEGER NOT NULL,
            difference_cents INTEGER NOT NULL,
            result_json TEXT NOT NULL,
            stale INTEGER NOT NULL DEFAULT 0,
            stale_reason TEXT,
            created_at TEXT NOT NULL
          )`);
          ctx.conn.exec(`DROP TABLE bank_reconcile_runs`);
          ctx.conn.exec(`ALTER TABLE bank_reconcile_runs_rebuild RENAME TO bank_reconcile_runs`);
          ctx.conn.exec(`CREATE INDEX idx_bank_reconcile_scope
                           ON bank_reconcile_runs (account_set_id, bank_account_id, period, as_of)`);
        } finally {
          ctx.conn.exec("PRAGMA foreign_keys = ON");
        }
        const state = S.bankSchemaContract(ctx.conn);
        assert.equal(state.code, "bank_schema_corrupt");
        assert.ok(state.problems.some((p) => p.code === "bank_schema_foreign_key_unexpected"
          && p.detail.table === "bank_reconcile_runs" && p.detail.refTable === "account_sets"),
        "运行记录表原本无外键，额外外键必须拒绝");
      } finally { ctx.conn.close(); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("版本表形状缺失：contract / 状态 / 领域入口结构化拒绝，不泄露原始 SQL 错误", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-version-shape-"));
  try {
    const ctx = await isolatedComponentDb(dir, "version-shape.db");
    try {
      // 只损坏版本表形状：version 列被改名。
      ctx.conn.exec(`ALTER TABLE bank_component_migrations RENAME COLUMN version TO broken_version`);
      const tablesBefore = bankTableNames(ctx.conn);
      const rowsBefore = bankRowCounts(ctx.conn);

      let state;
      assert.doesNotThrow(() => { state = S.bankSchemaContract(ctx.conn); },
        "版本表缺列时不得抛原始 SQLite 错误");
      assert.equal(state.ok, false);
      assert.equal(state.code, "bank_schema_corrupt");
      assert.ok(state.problems.some((p) => p.code === "bank_schema_version_table_corrupt"
        && p.detail.table === "bank_component_migrations"
        && p.detail.missing.includes("version")), "必须给出版本表形状损坏的结构化问题");
      assert.equal(state.problems.some((p) => p.code === "bank_schema_version_contradiction"), false,
        "形状损坏不得伪装成版本矛盾");

      assert.doesNotThrow(() => S.bankSchemaVersion(ctx.conn), "版本号读取不得抛原始 SQL 错误");
      assert.equal(S.bankSchemaVersion(ctx.conn), 0, "形状损坏时不得读取 version");
      let schemaState;
      assert.doesNotThrow(() => { schemaState = S.bankSchemaState(ctx.conn); }, "状态自检不得抛原始 SQL 错误");
      assert.equal(schemaState.contract.ok, false);
      assert.ok(schemaState.contract.problemCodes.includes("bank_schema_version_table_corrupt"));

      await assert.rejects(() => S.ensureBankSchema(ctx.conn, { dbPath: ctx.file }),
        (e) => e.code === "bank_schema_corrupt", "初始化必须在损坏版本表上结构化拒绝");
      assert.throws(() => B.registerBankAccount(ctx.conn, {
        accountSetId: 1, bankAccountId: "BANK-VSHAPE", sourceId: "src-1", glAccountCode: "1002",
      }), (e) => e.code === "bank_schema_corrupt", "领域写入必须结构化拒绝");
      assert.throws(() => B.listTransactionsView(ctx.conn, { accountSetId: 1, bankAccountId: "BANK-VSHAPE" }),
        (e) => e.code === "bank_schema_corrupt", "领域只读入口也必须结构化拒绝（非写入拒绝）");

      assert.deepEqual(bankTableNames(ctx.conn), tablesBefore, "拒绝时不得补建 / 改名任何 bank_* 表");
      assert.deepEqual(bankRowCounts(ctx.conn), rowsBefore, "拒绝时不得写入任何 bank_* 数据");
    } finally { ctx.conn.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("失效匹配复核计数先过滤再限条：>500 条已复核前缀不得掩盖后续未复核项", () => {
  const set = createSet("合成失效前缀", []);
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const txn = importCsv(set.id, bank, "INV-PREFIX", csvAmountDirection([
    { date: "2026-01-12", summary: "收款", amount: "10.00", direction: "inflow", refId: "IP-1" },
  ])).transactionIds[0];
  const matchedVoucher = post(set.id, "2026-01-12", bankIn(10));
  const confirmed = B.confirmMatch(db, {
    accountSetId: set.id, bankAccountId: bank, transactionId: txn,
    voucherId: matchedVoucher.id, entryId: entryOfVoucher(matchedVoucher.id), reason: "核对一致",
  });
  assert.equal(confirmed.match.status, "confirmed");
  const unmatchedVoucher = post(set.id, "2026-01-12", bankIn(10));
  const unmatchedEntryId = entryOfVoucher(unmatchedVoucher.id);
  const matchedEntryId = entryOfVoucher(matchedVoucher.id);

  // 制造 >500 条「已复核」失效匹配（其分录当前已有有效匹配），再追加 1 条真正未复核的；
  // 若实现先取一页失效记录再排除已复核项，最后这条未复核项就会被静默漏掉。
  const insertInvalidated = db.prepare(`INSERT INTO bank_matches
      (account_set_id, bank_account_id, currency, transaction_id, voucher_id, entry_id, entry_line_no,
       status, snapshot_json, reason, confirmed_at, invalidated_at, invalidation_reason)
      VALUES (?,?, 'CNY', ?, ?, ?, 1, 'invalidated', '{}', '历史确认', ?, ?, 'voucher_unposted')`);
  for (let i = 0; i < 500; i += 1) {
    insertInvalidated.run(set.id, bank, txn, matchedVoucher.id, matchedEntryId,
      new Date().toISOString(), new Date().toISOString());
  }
  insertInvalidated.run(set.id, bank, null, unmatchedVoucher.id, unmatchedEntryId,
    new Date().toISOString(), new Date().toISOString());

  const result = B.reconcileBank(db, {
    accountSetId: set.id, bankAccountId: bank, period: "2026-01", asOf: "2026-01-31",
    statementOpenCents: 0n, statementCloseCents: 0n,
    coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "合成失效前缀对账单",
  });
  assert.equal(result.matches.invalidatedUnresolved, 1, "未复核的失效匹配必须被计入");
  const issue = result.issues.find((i) => i.code === "match_invalidated");
  assert.ok(issue, "必须给出未复核失效匹配问题");
  assert.equal(issue.details.count, 1);
  assert.equal(issue.details.items.length, 1);
  assert.equal(issue.details.items[0].entryId, unmatchedEntryId);
  assert.equal(result.status, "pending_review");
});


// ------------------------------------------------------------------ 索引键语义（collation / 方向 / 表达式 / 来源）
test("索引键语义契约：collation / 方向 / 表达式 / 额外唯一索引都拒绝，正常大小写不同稳定 ID 仍可导入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-index-keys-"));
  const expectCorrupt = (ctx) => {
    const state = S.bankSchemaContract(ctx.conn);
    assert.equal(state.ok, false, "同名同列同名谓词的键语义漂移必须破坏契约");
    assert.equal(state.code, "bank_schema_corrupt");
    return state;
  };
  const assertIndexRejected = async (ctx, indexName, patch) => {
    const state = expectCorrupt(ctx);
    const problem = state.problems.find((p) => p.code === "bank_schema_index_mismatch"
      && p.detail.index === indexName);
    assert.ok(problem, `${indexName}: 必须给出结构化索引键不符问题`);
    patch?.(problem);
    const rowsBefore = bankRowCounts(ctx.conn);
    for (const [label, call] of contractWriteCalls(ctx.conn)) {
      assert.throws(call, (e) => e.code === "bank_schema_corrupt", `${indexName}: ${label} 必须在写入前拒绝`);
    }
    await assert.rejects(() => S.ensureBankSchema(ctx.conn, { dbPath: ctx.file }),
      (e) => e.code === "bank_schema_corrupt", `${indexName}: 初始化不得静默修补`);
    assert.deepEqual(bankRowCounts(ctx.conn), rowsBefore, `${indexName}: 拒绝时不得写入任何 bank_* 数据`);
  };

  try {
    // 1) 有效流水部分唯一索引：名字 / 列名 / UNIQUE / partial / 谓词全不变，只把最后一个键改成 COLLATE NOCASE。
    {
      const ctx = await isolatedComponentDb(dir, "keys-nocase.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_txn_ref`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_txn_ref
                         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id COLLATE NOCASE)
                         WHERE bank_ref_id IS NOT NULL`);
        await assertIndexRejected(ctx, "idx_bank_txn_ref", (problem) => {
          assert.deepEqual(problem.detail.actual.columns,
            ["account_set_id", "bank_account_id", "source_id", "bank_ref_id"], "列名不变");
          assert.equal(problem.detail.actual.unique, true);
          assert.equal(problem.detail.actual.partial, true);
          assert.equal(problem.detail.actual.where, S.canonicalSqlCondition("bank_ref_id IS NOT NULL"), "谓词仍相同");
          assert.equal(problem.detail.actual.keys.at(-1).collation, "NOCASE");
          assert.equal(problem.detail.expected.keys.at(-1).collation, "BINARY");
          assert.equal(problem.detail.actual.origin, "c", "来源仍是显式 CREATE INDEX");
        });

        // 真实语义对照：同样的两条「只差大小写」的稳定 ID，在 NOCASE 索引下第 2 条必然撞 UNIQUE。
        const now = new Date().toISOString();
        ctx.conn.prepare(`INSERT INTO bank_accounts
            (account_set_id, bank_account_id, source_id, currency, gl_account_code, display_name, bank_account_no, created_at)
            VALUES (1, 'BANK-KEYS', 'src-1', 'CNY', '1002', '', '', ?)`).run(now);
        ctx.conn.prepare(`INSERT INTO bank_batches
            (account_set_id, bank_account_id, source_id, batch_id, currency, period, content_sha256,
             mapping_fingerprint, normalization_version, status, created_at, updated_at)
            VALUES (1, 'BANK-KEYS', 'src-1', 'B-KEYS', 'CNY', '2026-01', 'x', 'y', 'z', 'pending', ?, ?)`)
          .run(now, now);
        const insertTxn = (refId, rowIndex) => ctx.conn.prepare(`INSERT INTO bank_transactions
            (account_set_id, bank_account_id, source_id, currency, txn_date, period, direction,
             amount_cents, summary, bank_ref_id, content_fingerprint, row_fingerprint, batch_id, row_index, origin, created_at)
            VALUES (1, 'BANK-KEYS', 'src-1', 'CNY', '2026-01-05', '2026-01', 'inflow', 1000, '', ?, 'c', 'r', 'B-KEYS', ?, 'imported', ?)`)
          .run(refId, rowIndex, now);
        insertTxn("Ref-A", 0);
        assert.throws(() => insertTxn("ref-a", 1), /UNIQUE|constraint/i,
          "COLLATE NOCASE 会让只差大小写的稳定 ID 在唯一索引里相撞（正常 DDL 不会）");
        ctx.conn.exec(`DELETE FROM bank_transactions`);

        // 恢复产品真实 DDL（BINARY 升序）后契约立即通过。
        ctx.conn.exec(`DROP INDEX idx_bank_txn_ref`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_txn_ref
                         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id)
                         WHERE bank_ref_id IS NOT NULL`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "恢复 BINARY 后必须通过");
      } finally { ctx.conn.close(); }
    }

    // 2) 非唯一普通索引的 RTRIM collation。
    {
      const ctx = await isolatedComponentDb(dir, "keys-rtrim.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_txn_scope_date`);
        ctx.conn.exec(`CREATE INDEX idx_bank_txn_scope_date
                         ON bank_transactions (account_set_id, bank_account_id, txn_date COLLATE RTRIM)`);
        await assertIndexRejected(ctx, "idx_bank_txn_scope_date", (problem) => {
          assert.equal(problem.detail.actual.keys.at(-1).collation, "RTRIM");
          assert.equal(problem.detail.actual.unique, false);
        });
        ctx.conn.exec(`DROP INDEX idx_bank_txn_scope_date`);
        ctx.conn.exec(`CREATE INDEX idx_bank_txn_scope_date
                         ON bank_transactions (account_set_id, bank_account_id, txn_date)`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "恢复普通升序索引后必须通过");
      } finally { ctx.conn.close(); }
    }

    // 3) 最后键改成 DESC（列名 / UNIQUE / 谓词都不变）。
    {
      const ctx = await isolatedComponentDb(dir, "keys-desc.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_txn_batch_row`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_txn_batch_row
                         ON bank_transactions (account_set_id, bank_account_id, batch_id, row_index DESC)`);
        await assertIndexRejected(ctx, "idx_bank_txn_batch_row", (problem) => {
          assert.equal(problem.detail.actual.keys.at(-1).desc, true);
          assert.equal(problem.detail.expected.keys.at(-1).desc, false);
        });
        ctx.conn.exec(`DROP INDEX idx_bank_txn_batch_row`);
        ctx.conn.exec(`CREATE UNIQUE INDEX idx_bank_txn_batch_row
                         ON bank_transactions (account_set_id, bank_account_id, batch_id, row_index)`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "恢复升序后必须通过");
      } finally { ctx.conn.close(); }
    }

    // 4) 表达式键（列名 / 数量看起来一样，实际是 lower(row_fingerprint) 表达式）。
    {
      const ctx = await isolatedComponentDb(dir, "keys-expression.db");
      try {
        ctx.conn.exec(`DROP INDEX idx_bank_txn_fingerprint`);
        ctx.conn.exec(`CREATE INDEX idx_bank_txn_fingerprint
                         ON bank_transactions (account_set_id, bank_account_id, source_id, lower(row_fingerprint))`);
        await assertIndexRejected(ctx, "idx_bank_txn_fingerprint", (problem) => {
          assert.equal(problem.detail.actual.keys.length, 4);
          assert.equal(problem.detail.actual.keys.at(-1).column, null, "表达式键没有列名");
          assert.equal(problem.detail.actual.keys.at(-1).expression, true);
        });
        ctx.conn.exec(`DROP INDEX idx_bank_txn_fingerprint`);
        ctx.conn.exec(`CREATE INDEX idx_bank_txn_fingerprint
                         ON bank_transactions (account_set_id, bank_account_id, source_id, row_fingerprint)`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "恢复列引用后必须通过");
      } finally { ctx.conn.close(); }
    }

    // 5) 契约之外的额外索引：普通列上的额外 UNIQUE 约束同样必须拒绝（不是只看「必需索引都在」）。
    {
      const ctx = await isolatedComponentDb(dir, "keys-extra-unique.db");
      try {
        ctx.conn.exec(`CREATE UNIQUE INDEX bank_probe_extra_unique
                         ON bank_transactions (summary)`);
        const state = expectCorrupt(ctx);
        assert.ok(state.problems.some((p) => p.code === "bank_schema_index_unexpected"
          && p.detail.index === "bank_probe_extra_unique"), "额外 UNIQUE 索引必须结构化拒绝");
        const rowsBefore = bankRowCounts(ctx.conn);
        for (const [label, call] of contractWriteCalls(ctx.conn)) {
          assert.throws(call, (e) => e.code === "bank_schema_corrupt", `额外 UNIQUE: ${label} 必须拒绝`);
        }
        await assert.rejects(() => S.ensureBankSchema(ctx.conn, { dbPath: ctx.file }),
          (e) => e.code === "bank_schema_corrupt", "额外 UNIQUE: 初始化不得静默修补");
        assert.deepEqual(bankRowCounts(ctx.conn), rowsBefore, "额外 UNIQUE: 拒绝时不得写入");
        ctx.conn.exec(`DROP INDEX bank_probe_extra_unique`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "移除额外唯一索引后必须通过");
      } finally { ctx.conn.close(); }
    }

    // 6) 用另一个命名索引重复表级 UNIQUE 的形状：自动索引的来源 / 唯一性集合不得被顶替或放宽。
    {
      const ctx = await isolatedComponentDb(dir, "keys-dup-unique.db");
      try {
        ctx.conn.exec(`CREATE UNIQUE INDEX bank_probe_dup_unique
                         ON bank_batch_rows (account_set_id, bank_account_id, batch_id, row_index)`);
        const state = expectCorrupt(ctx);
        assert.ok(state.problems.some((p) => p.code === "bank_schema_index_unexpected"
          && p.detail.index === "bank_probe_dup_unique"), "重复的表级 UNIQUE 形状必须作为额外索引拒绝");
        ctx.conn.exec(`DROP INDEX bank_probe_dup_unique`);
        assert.equal(S.bankSchemaContract(ctx.conn).ok, true, "移除后必须通过");
      } finally { ctx.conn.close(); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("真实导入对照：只有大小写不同的稳定流水 ID 在正常结构下两条都成功，索引键全部是 BINARY 升序普通列", () => {
  const set = createSet("合成大小写稳定ID", []);
  const bank = register(set.id, uniq("BANK")).account.bank_account_id;
  const contractIndex = S.BANK_SCHEMA_CONTRACT.indexes.find((idx) => idx.index === "idx_bank_txn_ref");
  assert.ok(contractIndex, "契约必须登记 idx_bank_txn_ref");
  assert.deepEqual(contractIndex.keys.map((key) => [key.column, key.collation, key.desc, key.expression]), [
    ["account_set_id", "BINARY", false, false],
    ["bank_account_id", "BINARY", false, false],
    ["source_id", "BINARY", false, false],
    ["bank_ref_id", "BINARY", false, false],
  ], "产品真实 DDL 的键语义必须固定为 BINARY 升序普通列");
  assert.equal(contractIndex.origin, "c");

  const result = importCsv(set.id, bank, uniq("CASE-REF"), csvAmountDirection([
    { date: "2026-01-05", summary: "收款甲", amount: "10.00", direction: "inflow", refId: "Ref-A" },
    { date: "2026-01-06", summary: "收款乙", amount: "20.00", direction: "inflow", refId: "ref-a" },
  ]));
  assert.equal(result.transactionIds.length, 2, "正常结构下只差大小写的稳定 ID 必须两条都导入");
  assert.equal(txnCount(set.id, bank), 2);
  const refs = db.prepare(`SELECT bank_ref_id FROM bank_transactions
                            WHERE account_set_id=? AND bank_account_id=? ORDER BY bank_ref_id`).all(set.id, bank)
    .map((row) => row.bank_ref_id).sort();
  assert.deepEqual(refs, ["Ref-A", "ref-a"], "两条稳定 ID 必须原样保留大小写");
});


// ------------------------------------------------------------------ 事务回滚状态（安装 / 嵌套保存点 / 导入审计）
const ioError = (stage) => {
  const error = new Error(`injected ${stage} I/O error`);
  error.code = "ERR_SQLITE_ERROR";
  return error;
};

/** 未安装 bank_* 的最简真实库；journal=DELETE 时可用另一连接持 SHARED 读锁制造真实 COMMIT busy。 */
function legacyOnlyDb(dir, name, journal = null) {
  const file = join(dir, name);
  const conn = new DatabaseSync(file);
  if (journal) conn.exec(`PRAGMA journal_mode = ${journal}`);
  createLegacySchema(conn);
  conn.exec(`INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
              VALUES (1, '1002', '银行存款', '资产', 'debit', 0, 1)`);
  return { conn, file };
}

test("安装 COMMIT 真实失败（DELETE journal 读事务）：确认回滚后 isTransaction=false、bank 表 0，可重试成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-commit-busy-"));
  const { conn, file } = legacyOnlyDb(dir, "commit-busy.db", "DELETE");
  const reader = new DatabaseSync(file);
  try {
    // 真实读事务：另一连接持 SHARED 锁，安装的 COMMIT 需要 EXCLUSIVE → SQLITE_BUSY。
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM account_sets").get();
    let error = null;
    try { await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) }); } catch (e) { error = e; }
    assert.equal(error?.code, "bank_migration_failed", "真实 COMMIT busy 必须结构化失败，而不是静默成功");
    assert.equal(error?.details?.rolledBack, true, "回滚真实成功后必须明确 rolledBack:true");
    assert.equal(error?.details?.transactionState, "rolled_back");
    assert.equal(conn.isTransaction, false, "确认回滚后连接不得仍持有事务");
    assert.deepEqual(bankTableNames(conn), [], "确认回滚后不得留下 bank_* 表");
    assert.equal(S.bankConnectionState(conn).writable, true, "已确认回滚的连接必须仍可用（不是被永久拉黑）");

    // 释放读锁后同一连接重试必须成功：失败没有污染事务层或结构。
    reader.exec("COMMIT");
    const retried = await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) });
    assert.equal(retried.migrated, true);
    assert.equal(S.bankSchemaContract(conn).ok, true, "重试后组件结构必须完整");
  } finally {
    try { conn.close(); } catch { /* ignore */ }
    try { reader.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("仅注入 ROLLBACK 抛错（单点注入，不是实测磁盘故障）：不得声称已回滚，未知连接拒绝继续银行写入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-rollback-inject-"));
  const { conn, file } = legacyOnlyDb(dir, "rollback-inject.db", "DELETE");
  const reader = new DatabaseSync(file);
  const realExec = conn.exec.bind(conn);
  let injected = 0;
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM account_sets").get();
    // 只让第一次 ROLLBACK 抛 I/O 错误；COMMIT 仍是真实的 SQLITE_BUSY。
    conn.exec = (sql) => {
      if (/^ROLLBACK/i.test(String(sql)) && injected === 0) {
        injected += 1;
        throw ioError("rollback");
      }
      return realExec(sql);
    };
    let error = null;
    try { await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) }); } catch (e) { error = e; }
    assert.equal(injected, 1, "只注入一次 ROLLBACK 失败");
    assert.equal(error?.code, "bank_transaction_rollback_failed", "回滚失败必须与「已确认回滚」区分");
    assert.equal(error?.details?.rolledBack, false, "不得标记 rolledBack:true");
    assert.equal(error?.details?.transactionState, "rollback_unconfirmed");
    assert.equal(error?.details?.transactionActive, true);
    assert.doesNotMatch(String(error?.message), /原库已回滚|安装完成|已确认回滚/, "不得假称业务回滚 / 安装完成");
    assert.equal(conn.isTransaction, true, "单点注入后事务仍活着（真实磁盘故障未实测，此处只验证状态机）");
    // 同连接内确实还有未提交的 10 张 bank_* 表与版本行 —— 这正是不能假装「已回滚」的原因。
    assert.deepEqual(bankTableNames(conn), [...S.BANK_TABLES].sort(), "未知态下未提交的组件结构仍挂在该连接上");
    assert.equal(S.bankSchemaVersion(conn), S.BANK_SCHEMA_VERSION);
    assert.equal(S.bankConnectionState(conn).transactionState, "rollback_unconfirmed");
    assert.equal(S.bankConnectionState(conn).writable, false);

    // 未知态连接禁止继续银行读写（读入口同样拒绝），也不能再开事务。
    for (const [label, call] of contractWriteCalls(conn)) {
      assert.throws(call, (e) => e.code === "bank_connection_state_unknown", `未知态: ${label} 必须拒绝`);
    }
    assert.throws(() => S.inTransaction(conn, () => "noop"), (e) => e.code === "bank_connection_state_unknown");
    await assert.rejects(() => S.ensureBankSchema(conn, { dbPath: file }),
      (e) => e.code === "bank_connection_state_unknown", "未知态连接不得被当成「已初始化 / 可安装」");
    // 恢复前必须拒绝：连接仍持有未决事务。
    assert.throws(() => S.recoverBankConnectionState(conn), (e) => e.code === "bank_connection_recovery_refused");
    // 调用者明确恢复：先真实 ROLLBACK，再显式确认可用。
    conn.exec = realExec;
    realExec("ROLLBACK");
    assert.equal(conn.isTransaction, false);
    assert.deepEqual(bankTableNames(conn), [], "确认回滚后未提交结构必须消失");
    const recovered = S.recoverBankConnectionState(conn);
    assert.equal(recovered.recovered, true);
    assert.equal(S.bankConnectionState(conn).writable, true);

    reader.exec("COMMIT");
    const retried = await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) });
    assert.equal(retried.migrated, true, "恢复后重装必须成功（不是复用未知连接）");
  } finally {
    try { conn.exec = realExec; } catch { /* ignore */ }
    try { conn.close(); } catch { /* ignore */ }
    try { reader.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("新库分支：COMMIT / ROLLBACK 失败都不冒充「原库已回滚 / 安装完成」，确认回滚才可继续", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-fresh-txn-"));
  try {
    // a) COMMIT 与 ROLLBACK 都失败（单点注入）：未知态，不得声称已回滚。
    {
      const file = join(dir, "fresh-unknown.db");
      const receipt = S.claimFreshDatabase({ dbPath: file });
      const { conn } = legacyOnlyDb(dir, "fresh-unknown.db");
      const realExec = conn.exec.bind(conn);
      conn.exec = (sql) => {
        if (/^(COMMIT|ROLLBACK)/i.test(String(sql))) throw ioError("commit-rollback");
        return realExec(sql);
      };
      let error = null;
      try { await S.ensureBankSchema(conn, { dbPath: file, receipt }); } catch (e) { error = e; }
      assert.equal(error?.code, "bank_transaction_rollback_failed", "新库分支同样必须区分回滚失败");
      assert.doesNotMatch(String(error?.message), /原库已回滚|安装完成|已确认回滚|未留下/, "不得假称新库已回滚 / 安装完成");
      assert.equal(error?.details?.rolledBack, false);
      assert.equal(conn.isTransaction, true);
      assert.deepEqual(bankTableNames(conn), [...S.BANK_TABLES].sort(), "未知态下未提交的新库结构仍在连接上");
      conn.exec = realExec;
      realExec("ROLLBACK");
      assert.deepEqual(bankTableNames(conn), [], "确认回滚后新库不得留下半成品");
      S.recoverBankConnectionState(conn);
      const migrated = await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) });
      assert.equal(migrated.migrated, true, "恢复后走已有库路径必须能正常安装");
      conn.close();
    }

    // b) 只有 COMMIT 失败、ROLLBACK 真实成功：明确「已确认回滚」。
    {
      const file = join(dir, "fresh-confirmed.db");
      const receipt = S.claimFreshDatabase({ dbPath: file });
      const { conn } = legacyOnlyDb(dir, "fresh-confirmed.db");
      const realExec = conn.exec.bind(conn);
      conn.exec = (sql) => {
        if (/^COMMIT/i.test(String(sql))) throw ioError("commit");
        return realExec(sql);
      };
      let error = null;
      try { await S.ensureBankSchema(conn, { dbPath: file, receipt }); } catch (e) { error = e; }
      assert.equal(error?.code, "bank_migration_failed");
      assert.equal(error?.details?.rolledBack, true, "确认回滚后才可以说已回滚");
      assert.equal(error?.details?.transactionState, "rolled_back");
      assert.doesNotMatch(String(error?.message), /未确认|未知/, "已确认回滚的错误不得写成未知态");
      assert.equal(conn.isTransaction, false);
      assert.deepEqual(bankTableNames(conn), [], "确认回滚后不得留下半成品");
      conn.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("嵌套 SAVEPOINT 回滚失败：不提交半成品，区分已确认整体回滚与未知态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-nested-savepoint-"));
  const ctx = await isolatedComponentDb(dir, "nested-savepoint.db");
  const conn = ctx.conn;
  const realExec = conn.exec.bind(conn);
  const insertProbe = (label) => conn.prepare(`INSERT INTO bank_audit_events
      (account_set_id, bank_account_id, event_type, subject_type, subject_id, detail_json, created_at)
      VALUES (1, 'BANK-NESTED', ?, '', '', '{}', ?)`).run(label, new Date().toISOString());
  const auditCount = () => Number(conn.prepare(`SELECT COUNT(*) AS n FROM bank_audit_events`).get().n);
  const before = auditCount();
  let injected = 0;
  try {
    // a) 内层 SAVEPOINT 回滚失败、外层整体回滚成功：已确认放弃，不得留下内层半成品。
    conn.exec = (sql) => {
      if (/^ROLLBACK TO/i.test(String(sql)) && injected === 0) {
        injected += 1;
        throw ioError("savepoint-rollback");
      }
      return realExec(sql);
    };
    assert.throws(
      () => S.inTransaction(conn, () => S.inTransaction(conn, () => {
        insertProbe("inner-failure");
        throw new Error("inner-domain-failure");
      })),
      (e) => e.code === "bank_transaction_discarded" && e.details?.rolledBack === true
        && e.details?.transactionState === "rolled_back",
      "内层回滚未确认但外层确认整体回滚时必须给 discarded / rolledBack:true",
    );
    assert.equal(conn.isTransaction, false);
    assert.equal(auditCount(), before, "整体回滚后不得留下内层写入");

    // b) 内层回滚失败被调用方吞掉：外层绝不 COMMIT。
    injected = 0;
    conn.exec = (sql) => {
      if (/^ROLLBACK TO/i.test(String(sql)) && injected === 0) {
        injected += 1;
        throw ioError("savepoint-rollback");
      }
      return realExec(sql);
    };
    assert.throws(
      () => S.inTransaction(conn, () => {
        try {
          S.inTransaction(conn, () => {
            insertProbe("swallowed-failure");
            throw new Error("inner-domain-failure");
          });
        } catch { /* 调用方吞掉内层错误 */ }
        return "would-be-committed";
      }),
      (e) => e.code === "bank_transaction_discarded" && e.details?.rolledBack === true,
      "内层回滚失败被吞掉后外层必须放弃事务，而不是提交半成品",
    );
    assert.equal(conn.isTransaction, false);
    assert.equal(auditCount(), before, "被吞掉的内层失败同样不得留下写入");

    // c) 内层与外层回滚都失败：未知态，禁止继续银行读写，需显式恢复。
    conn.exec = (sql) => {
      if (/^ROLLBACK/i.test(String(sql))) throw ioError("rollback");
      return realExec(sql);
    };
    assert.throws(
      () => S.inTransaction(conn, () => S.inTransaction(conn, () => {
        insertProbe("double-failure");
        throw new Error("inner-domain-failure");
      })),
      (e) => e.code === "bank_transaction_rollback_failed" && e.details?.rolledBack === false,
    );
    assert.equal(conn.isTransaction, true, "外层回滚也失败时事务仍活着，不能声称已回滚");
    assert.equal(S.bankConnectionState(conn).transactionState, "rollback_unconfirmed");
    assert.throws(() => S.inTransaction(conn, () => "noop"), (e) => e.code === "bank_connection_state_unknown");
    assert.throws(() => B.registerBankAccount(conn, {
      accountSetId: 1, bankAccountId: "BANK-NESTED-2", sourceId: "src-1", glAccountCode: "1002",
    }), (e) => e.code === "bank_connection_state_unknown", "未知态连接禁止继续银行写入");
    conn.exec = realExec;
    realExec("ROLLBACK");
    assert.equal(S.recoverBankConnectionState(conn).transactionState, "clean");
    assert.equal(auditCount(), before, "确认回滚后所有未提交写入必须消失");
  } finally {
    try { conn.exec = realExec; } catch { /* ignore */ }
    try { conn.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("导入失败审计：回滚未确认时如实标记未留痕，未知连接禁止成功复用（真实 COMMIT_BUSY + 单点注入）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-import-audit-"));
  const { conn, file } = legacyOnlyDb(dir, "import-audit.db", "DELETE");
  const reader = new DatabaseSync(file);
  try {
    const migrated = await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) });
    assert.equal(migrated.migrated, true);
    B.registerBankAccount(conn, {
      accountSetId: 1, bankAccountId: "BANK-AUDIT", sourceId: "src-1", glAccountCode: "1002",
    });
    const options = {
      accountSetId: 1, bankAccountId: "BANK-AUDIT", sourceId: "src-1", period: "2026-01",
      batchId: "AUDIT-1",
      csvText: csvAmountDirection([{ date: "2026-01-05", summary: "收款", amount: "10.00", direction: "inflow", refId: "AU-1" }]),
      mapping: MAPPING_AMOUNT_DIRECTION,
    };
    const realExec = conn.exec.bind(conn);
    let injected = 0;
    // 真实读事务让导入的 COMMIT 撞 SQLITE_BUSY；再只注入一次 ROLLBACK 的 I/O 错误（非实测磁盘故障）。
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM account_sets").get();
    conn.exec = (sql) => {
      if (/^ROLLBACK/i.test(String(sql)) && injected === 0) {
        injected += 1;
        throw ioError("rollback");
      }
      return realExec(sql);
    };
    let error = null;
    try { B.importBankBatch(conn, options); } catch (e) { error = e; }
    assert.equal(error?.code, "bank_transaction_rollback_failed");
    assert.equal(error?.auditRecorded, false, "回滚未确认时不得声称失败已留痕");
    assert.match(String(error?.auditFailure), /未确认|未写入/, "必须如实说明失败审计未写入");
    assert.equal(conn.isTransaction, true);
    assert.equal(S.bankConnectionState(conn).writable, false);

    // 未知连接不能成功复用：同样参数再导入直接结构化拒绝，而不是「恰好成功」。
    assert.throws(() => B.importBankBatch(conn, options), (e) => e.code === "bank_connection_state_unknown");
    assert.throws(() => B.listTransactionsView(conn, { accountSetId: 1, bankAccountId: "BANK-AUDIT" }),
      (e) => e.code === "bank_connection_state_unknown");

    conn.exec = realExec;
    realExec("ROLLBACK");
    reader.exec("COMMIT");
    assert.equal(S.recoverBankConnectionState(conn).transactionState, "clean");
    assert.equal(Number(conn.prepare(`SELECT COUNT(*) AS n FROM bank_batches WHERE batch_id='AUDIT-1'`).get().n), 0,
      "未知态下不得留下伪造的失败批次 / 审计记录");

    // 恢复后重新导入成功，批次状态是 completed（不是「被记成失败后又冒充成功」）。
    const retried = B.importBankBatch(conn, options);
    assert.equal(retried.replay, false);
    assert.equal(retried.transactionIds.length, 1);
    const batch = S.getBatch(conn, { accountSetId: 1, bankAccountId: "BANK-AUDIT", batchId: "AUDIT-1" });
    assert.equal(batch.status, "completed");
    assert.equal(Number(conn.prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE account_set_id=1 AND bank_account_id='BANK-AUDIT'`).get().n), 1);
  } finally {
    try { conn.close(); } catch { /* ignore */ }
    try { reader.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ------------------------------------------------------------------ 调用方外层事务（未开始 vs 已确认回滚）
test("新库 + 创建回执 + 调用方外层事务：拒绝安装但不提交 / 不回滚调用方事务，不误报回滚，回执保留，结束后恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-fresh-outer-txn-"));
  const file = join(dir, "workbench.db");
  const receipt = S.claimFreshDatabase({ dbPath: file });
  const conn = new DatabaseSync(file);
  try {
    createLegacySchema(conn);
    conn.exec(`INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
                VALUES (1, '1002', '银行存款', '资产', 'debit', 0, 1)`);
    // 调用方自己开事务，并插入 1 条真实未提交账套（未 COMMIT 的 pending 行）。
    conn.exec("BEGIN IMMEDIATE");
    conn.exec(`INSERT INTO account_sets (name, start_period, created_at)
                VALUES ('调用方未提交账套', '2026-01', '2026-01-01T00:00:00.000Z')`);
    const pendingBefore = countIn(conn, `SELECT COUNT(*) AS n FROM account_sets`);

    let error = null;
    try { await S.ensureBankSchema(conn, { dbPath: file, receipt }); } catch (e) { error = e; }
    assert.equal(error?.code, "bank_transaction_conflict",
      "调用方事务里安装必须给事务冲突，而不是「已确认回滚的安装失败」");
    assert.equal(error?.details?.rolledBack, false, "没有发生回滚，绝不能标记 rolledBack:true");
    assert.equal(error?.details?.started, false, "银行没有开始事务");
    assert.equal(error?.details?.transactionState, "external_transaction");
    assert.equal(error?.details?.transactionActive, true);
    assert.equal(error?.details?.bankManaged, false);
    assert.doesNotMatch(String(error?.message), /已回滚|已确认回滚|未留下半成品/, "不得把没回滚说成已回滚");
    assert.doesNotMatch(String(error?.message), /SQLITE|BEGIN|ROLLBACK|\.db/i, "不得回显原始 SQL / 库路径");

    // 调用方事务与未提交行仍在，银行什么都没装。
    assert.equal(conn.isTransaction, true, "银行入口失败不得提交 / 回滚调用方事务");
    assert.equal(countIn(conn, `SELECT COUNT(*) AS n FROM account_sets`), pendingBefore, "调用方未提交行必须仍在");
    assert.equal(countIn(conn, `SELECT COUNT(*) AS n FROM account_sets WHERE name='调用方未提交账套'`), 1);
    assert.deepEqual(bankTableNames(conn), [], "拒绝安装后不得留下任何 bank_* 表");
    const state = S.bankConnectionState(conn);
    assert.equal(state.transactionState, "external_transaction");
    assert.equal(state.externalTransaction, true);
    assert.equal(state.transactionActive, true, "实际活动的外层事务不得被说成 transactionActive:false");
    assert.equal(state.writable, false, "调用方事务进行中，银行不能自称可写");
    assert.equal(S.hasFreshDatabaseClaim(receipt, file), true, "被拒绝的调用不得烧掉创建回执");

    // 调用方明确结束自己的事务（回滚自己那条未提交账套）：同一回执必须还能完成新库安装。
    conn.exec("ROLLBACK");
    assert.equal(conn.isTransaction, false);
    assert.equal(countIn(conn, `SELECT COUNT(*) AS n FROM account_sets`), pendingBefore - 1);
    assert.equal(S.bankConnectionState(conn).writable, true);
    const migrated = await S.ensureBankSchema(conn, { dbPath: file, receipt });
    assert.equal(migrated.migrated, true, "调用方结束后同一回执必须仍可完成新库安装");
    assert.equal(migrated.creation, "fresh-database");
    assert.equal(S.bankSchemaContract(conn).ok, true);
    assert.equal(B.registerBankAccount(conn, {
      accountSetId: 1, bankAccountId: "BANK-OUTER", sourceId: "src-1", glAccountCode: "1002",
    }).created, true, "结束后健康银行操作必须恢复");
  } finally {
    try { conn.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("现库安装 + 调用方外层事务：冲突先于备份 / DDL 与回执消耗，调用方结束后安装恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-existing-outer-txn-"));
  const { conn, file } = legacyOnlyDb(dir, "existing-outer.db");
  try {
    conn.exec("BEGIN IMMEDIATE");
    conn.exec(`INSERT INTO account_sets (name, start_period, created_at)
                VALUES ('现库外层未提交账套', '2026-01', '2026-01-01T00:00:00.000Z')`);
    const pendingBefore = countIn(conn, `SELECT COUNT(*) AS n FROM account_sets`);
    let error = null;
    try { await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) }); } catch (e) { error = e; }
    assert.equal(error?.code, "bank_transaction_conflict", "现库安装同样必须先给事务冲突，而不是锁失败 / 已回滚");
    assert.equal(error?.details?.rolledBack, false);
    assert.equal(error?.details?.started, false);
    assert.equal(error?.details?.transactionState, "external_transaction");
    assert.equal(error?.details?.transactionActive, true);
    assert.equal(conn.isTransaction, true, "不得回滚调用方事务");
    assert.equal(countIn(conn, `SELECT COUNT(*) AS n FROM account_sets`), pendingBefore);
    assert.deepEqual(bankTableNames(conn), []);
    assert.equal(existsSync(join(dir, "bank-component-backups")), false,
      "冲突拒绝必须发生在分配迁移备份目录之前");
    assert.equal(S.bankConnectionState(conn).transactionActive, true);
    assert.equal(S.bankConnectionState(conn).writable, false);
    assert.equal(S.recoverBankConnectionState(conn).transactionState, "external_transaction",
      "没有未知标记时也必须如实报告调用方事务（不能说成 clean）");

    conn.exec("ROLLBACK");
    const migrated = await S.ensureBankSchema(conn, { dbPath: file, backupService: fakeBackupService(file) });
    assert.equal(migrated.migrated, true, "调用方结束后现库安装必须恢复");
    assert.equal(S.bankSchemaContract(conn).ok, true);
  } finally {
    try { conn.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("BEGIN / SAVEPOINT 没建立起来：不冒充已回滚、不拉黑连接，嵌套层整层放弃仍如实标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-begin-failed-"));
  const ctx = await isolatedComponentDb(dir, "begin-failed.db");
  const conn = ctx.conn;
  const realExec = conn.exec.bind(conn);
  try {
    // a) 外层 BEGIN 本身失败（锁忙类）：本层没有开始，也没有可回滚的写入。
    conn.exec = (sql) => {
      if (/^BEGIN/i.test(String(sql))) throw ioError("begin");
      return realExec(sql);
    };
    assert.throws(() => S.inTransaction(conn, () => "noop"),
      (e) => e.code === "bank_transaction_begin_failed" && e.details?.rolledBack === false
        && e.details?.started === false && e.details?.transactionState === "not_started",
      "BEGIN 没建立必须给「未开始」，不能冒充已回滚");
    assert.equal(conn.isTransaction, false, "BEGIN 失败后不得留下事务");
    assert.equal(S.bankConnectionState(conn).writable, true, "没开始过事务的连接不能被拉黑成未知态");

    // b) 嵌套 SAVEPOINT 建立失败：内层未开始，外层确认回滚后整层放弃。
    let injected = 0;
    conn.exec = (sql) => {
      if (/^SAVEPOINT/i.test(String(sql)) && injected === 0) { injected += 1; throw ioError("savepoint"); }
      return realExec(sql);
    };
    assert.throws(() => S.inTransaction(conn, () => S.inTransaction(conn, () => "inner")),
      (e) => e.code === "bank_transaction_discarded" && e.details?.rolledBack === true
        && e.details?.transactionState === "rolled_back",
      "内层保存点没建立、外层已确认回滚时必须给「已确认放弃」");
    assert.equal(injected, 1, "只注入一次 SAVEPOINT 失败");
    assert.equal(conn.isTransaction, false);
    assert.equal(S.bankConnectionState(conn).writable, true);
  } finally {
    try { conn.exec = realExec; } catch { /* ignore */ }
    try { conn.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("导入失败审计不写进调用方事务：如实标记未留痕，调用方结束后正常导入恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bank-audit-outer-txn-"));
  const ctx = await isolatedComponentDb(dir, "audit-outer.db");
  const conn = ctx.conn;
  try {
    B.registerBankAccount(conn, {
      accountSetId: 1, bankAccountId: "BANK-OUTER-AUDIT", sourceId: "src-1", glAccountCode: "1002",
    });
    const options = {
      accountSetId: 1, bankAccountId: "BANK-OUTER-AUDIT", sourceId: "src-1", period: "2026-01",
      batchId: "OUTER-AUDIT-1",
      csvText: csvAmountDirection([{ date: "2026-01-05", summary: "收款", amount: "10.00", direction: "inflow", refId: "OA-1" }]),
      mapping: MAPPING_AMOUNT_DIRECTION,
    };
    const auditBefore = countIn(conn, `SELECT COUNT(*) AS n FROM bank_audit_events`);
    conn.exec("BEGIN IMMEDIATE");
    let error = null;
    try { B.importBankBatch(conn, options); } catch (e) { error = e; }
    assert.equal(error?.code, "bank_transaction_conflict");
    assert.equal(error?.auditRecorded, false, "调用方事务里不得声称失败审计已记录");
    assert.match(String(error?.auditFailure), /调用方事务/);
    assert.doesNotMatch(String(error?.auditFailure), /回滚失败/, "不能把调用方事务说成回滚失败");
    assert.equal(countIn(conn, `SELECT COUNT(*) AS n FROM bank_batches`), 0, "失败审计不得写进调用方事务");
    assert.equal(countIn(conn, `SELECT COUNT(*) AS n FROM bank_audit_events`), auditBefore, "不得新增失败审计");
    assert.equal(conn.isTransaction, true, "调用方事务必须保持原样");

    conn.exec("ROLLBACK");
    const imported = B.importBankBatch(conn, options);
    assert.equal(imported.transactionIds.length, 1, "调用方结束后正常导入必须恢复");
    assert.equal(S.getBatch(conn, { accountSetId: 1, bankAccountId: "BANK-OUTER-AUDIT", batchId: "OUTER-AUDIT-1" }).status,
      "completed");
  } finally {
    try { conn.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
