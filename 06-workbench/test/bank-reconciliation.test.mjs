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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.deepEqual(globalMigrations.map((m) => Number(m.version)), [1, 2, 3], "不得写 LOCAL-01 的 schema_migrations");

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
        createBackup: () => ({ backupDir: join(dir, "fake-backup") }),
        verifyBackup: () => ({ ok: false, status: "corrupt" }),
      };
      await assert.rejects(
        () => S.ensureBankSchema(conn2, { dbPath: file2, backupService: invalid }),
        (e) => e.code === "migration_backup_invalid",
      );
      assert.equal(countIn(conn2, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'bank_%'`), 0);

      // 仅顺序验证（不是 LOCAL-06 真实迁移验收）：DDL 只在备份校验返回 ok 之后发生。
      const calls = [];
      const fake = {
        createBackup: ({ dbPath: p, outDir }) => {
          calls.push("createBackup");
          return { backupDir: join(outDir, "fake-backup"), bytes: 1 };
        },
        verifyBackup: () => { calls.push("verifyBackup"); return { ok: true }; },
      };
      const migrated = await S.ensureBankSchema(conn2, { dbPath: file2, backupService: fake });
      assert.equal(migrated.migrated, true);
      assert.equal(migrated.creation, "existing-database");
      assert.deepEqual(calls, ["createBackup", "verifyBackup"]);
      assert.equal(S.bankSchemaVersion(conn2), 1);
    } finally { conn2.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
