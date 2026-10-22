#!/usr/bin/env node
/**
 * LOCAL-03a B1 迁移验收：真实 v3 / v4 合成旧库 → v5 profile 迁移、迁移前备份、恢复后由真实 db 入口再升级、
 * 旧业务行 / 指纹 / 旧报表值不变、旧 create 批次跨升级重启原样重放、append 与查询、故障回滚。
 *
 * 备份 / 恢复使用已合并的 local-backup 接口（当前严格支持 v3 / v4；v5 备份归 B2，不在此修改）。
 * 全部为合成临时路径；不覆盖任何真实库、不使用真实账套 / 凭据。
 *
 * 运行：node test/accounting-standards-migration.test.mjs（cwd = 06-workbench）
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const productDir = mkdtempSync(join(tmpdir(), "wb-standards-mig-product-"));
process.env.WORKBENCH_DATA_DIR = productDir;

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
};

// 与产品 db.mjs 的基线结构一致（v5 列由迁移添加，不在基线 DDL 中预先创建）。
const BASE_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE account_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  taxpayer_type TEXT NOT NULL DEFAULT '小规模纳税人',
  accounting_standard TEXT NOT NULL DEFAULT '小企业会计准则',
  start_period TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,
  contra INTEGER NOT NULL DEFAULT 0, is_leaf INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_set_id, code)
);
CREATE TABLE opening_balances (
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  code TEXT NOT NULL, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (account_set_id, code)
);
CREATE TABLE periods (
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', PRIMARY KEY (account_set_id, period)
);
CREATE TABLE vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  period TEXT NOT NULL, voucher_date TEXT NOT NULL, word TEXT NOT NULL DEFAULT '记',
  number INTEGER NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL
);
CREATE TABLE voucher_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL, code TEXT NOT NULL, summary TEXT,
  debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_vouchers_set_period ON vouchers(account_set_id, period, status);
CREATE INDEX idx_entries_voucher ON voucher_entries(voucher_id);
CREATE INDEX idx_entries_code ON voucher_entries(code);
CREATE TABLE asset_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'fixed', name TEXT NOT NULL, original_cost REAL NOT NULL,
  residual_rate REAL NOT NULL DEFAULT 0.05, useful_life_months INTEGER NOT NULL,
  start_period TEXT NOT NULL, asset_account TEXT NOT NULL, accum_account TEXT NOT NULL,
  expense_account TEXT NOT NULL DEFAULT '5602', created_at TEXT NOT NULL
);
CREATE TABLE asset_depreciation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES asset_cards(id) ON DELETE CASCADE,
  period TEXT NOT NULL, amount REAL NOT NULL, voucher_id INTEGER, created_at TEXT NOT NULL,
  UNIQUE (account_set_id, asset_id, period)
);
ALTER TABLE vouchers ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
`;

let S, IM, LB, COA;
let productDb;

const iso = "2025-11-30T00:00:00.000Z";
const ENTERPRISE_KEY = "91350000MIGRATE001X";
const SOURCE = { system: "local-book", enterpriseKey: ENTERPRISE_KEY };
const META = {
  name: "旧V4账套",
  taxpayer_type: "小规模纳税人",
  accounting_standard: "企业会计准则",
  start_period: "2025-11",
};
const OPENINGS = [
  { code: "1002", debit: 10000, credit: 0 },
  { code: "1405", debit: 2000, credit: 0 },
  { code: "3001", debit: 0, credit: 12000 },
];
const PAYLOAD_VOUCHERS = [
  {
    period: "2025-11", date: "2025-11-05", word: "记", number: 1, summary: "旧V4收入",
    sourceVoucherId: "OLD-1",
    entries: [
      { code: "1002", summary: "旧V4收入", debit: 3000, credit: 0 },
      { code: "5001", summary: "旧V4收入", debit: 0, credit: 3000 },
    ],
  },
  {
    period: "2025-11", date: "2025-11-20", word: "记", number: 2, summary: "旧V4成本",
    sourceVoucherId: "OLD-2",
    entries: [
      { code: "5401", summary: "旧V4成本", debit: 1200, credit: 0 },
      { code: "1405", summary: "旧V4成本", debit: 0, credit: 1200 },
    ],
  },
];
const PAYLOAD = {
  account_set: META,
  accounts: [],
  opening_balances: OPENINGS,
  vouchers: PAYLOAD_VOUCHERS,
};

const columnNames = (conn, table) =>
  conn.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
const tableRows = (conn, table, order = "rowid") =>
  conn.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();

const BUSINESS_TABLES = [
  "accounts", "opening_balances", "periods", "vouchers", "voucher_entries",
  "asset_cards", "asset_depreciation_runs",
];
const IMPORT_TABLES = [
  "import_enterprise_account_sets", "import_source_bindings", "import_batches",
  "import_voucher_sources", "import_batch_vouchers",
];
const ACCOUNT_SET_COLUMNS = "id, name, taxpayer_type, accounting_standard, start_period, created_at";

function snapshot(conn) {
  const out = {
    account_sets: conn.prepare(`SELECT ${ACCOUNT_SET_COLUMNS} FROM account_sets ORDER BY id`).all(),
  };
  for (const table of [...BUSINESS_TABLES, ...IMPORT_TABLES]) {
    out[table] = tableRows(conn, table, table === "accounts" ? "id" : "rowid");
  }
  return out;
}

function snapshotFile(file) {
  const conn = new DatabaseSync(file, { readOnly: true });
  try { return snapshot(conn); } finally { conn.close(); }
}

/** 创建 v4 合成旧库：旧业务 + 旧“企业标签 / 小企科目” + 已完成 create 批次（真实指纹）。 */
function makeV4Fixture(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "workbench.db");
  const conn = new DatabaseSync(file);
  conn.exec(BASE_DDL);
  S.ensureImportSchema(conn, { dataDir: dir, targetVersion: 4 });
  assert.equal(S.schemaVersion(conn), 4);
  assert.equal(columnNames(conn, "account_sets").includes("accounting_profile_id"), false);

  const insertSet = conn.prepare(
    `INSERT INTO account_sets (name, taxpayer_type, accounting_standard, start_period, created_at)
     VALUES (?,?,?,?,?)`,
  );
  insertSet.run(META.name, META.taxpayer_type, META.accounting_standard, META.start_period, iso);
  insertSet.run("旧V4小企标签", "小规模纳税人", "小企业会计准则", "2025-11", iso);
  insertSet.run("旧V4未知标签空账套", "小规模纳税人", "某地方历史准则", "2025-11", iso);

  const insAccount = conn.prepare(
    `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (const account of COA) {
    insAccount.run(1, account.code, account.name, account.category, account.direction, account.contra ? 1 : 0, 1);
  }
  const insOpening = conn.prepare(
    `INSERT INTO opening_balances (account_set_id, code, debit, credit) VALUES (?,?,?,?)`,
  );
  for (const opening of OPENINGS) insOpening.run(1, opening.code, opening.debit, opening.credit);
  conn.prepare(`INSERT INTO periods (account_set_id, period, status) VALUES (1, '2025-11', 'open')`).run();

  const insVoucher = conn.prepare(
    `INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, kind, created_at)
     VALUES (1,?,?,?,?,?,'posted','normal',?)`,
  );
  const insEntry = conn.prepare(
    `INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit) VALUES (?,?,?,?,?,?)`,
  );
  const voucherIds = [];
  for (const voucher of PAYLOAD_VOUCHERS) {
    const info = insVoucher.run(
      voucher.period, voucher.date, voucher.word, voucher.number, voucher.summary, iso,
    );
    const voucherId = Number(info.lastInsertRowid);
    voucherIds.push(voucherId);
    voucher.entries.forEach((entry, index) => {
      insEntry.run(voucherId, index + 1, entry.code, entry.summary, entry.debit, entry.credit);
    });
  }
  // v4 资产卡片补项列（旧行语义不变）。
  conn.prepare(
    `INSERT INTO asset_cards (account_set_id, kind, name, original_cost, residual_rate, useful_life_months,
       start_period, asset_account, accum_account, expense_account, created_at,
       acquired_period, opening_accumulated, ledger_status, ledger_note, origin)
     VALUES (1,'fixed','旧V4设备',60000,0.05,60,'2025-11','1601','1602','5602',?, '2025-11',0,'booked','','purchase')`,
  ).run(iso);

  // ---- 已完成 create 批次（真实内容指纹 + 真实落库指纹）----
  const normalized = { account_set: META, accounts: [], opening_balances: OPENINGS, vouchers: PAYLOAD_VOUCHERS };
  const contentFingerprint = IM.batchFingerprint({
    mode: "create",
    targetAccountSetId: null,
    source: SOURCE,
    meta: META,
    normalized,
    vouchers: PAYLOAD_VOUCHERS.map((voucher) => ({
      sourceVoucherId: voucher.sourceVoucherId,
      fingerprint: S.voucherFingerprint(voucher),
    })),
  });
  conn.prepare(
    `INSERT INTO import_enterprise_account_sets (enterprise_key, enterprise_name, account_set_id, bound_at, bound_by)
     VALUES (?,?,?,?,?)`,
  ).run(ENTERPRISE_KEY, "旧V4企业", 1, iso, "import");
  conn.prepare(
    `INSERT INTO import_source_bindings (source_system, enterprise_key, enterprise_name, bound_at, bound_by)
     VALUES (?,?,?,?,?)`,
  ).run(SOURCE.system, ENTERPRISE_KEY, "旧V4企业", iso, "import");
  conn.prepare(
    `INSERT INTO import_batches (batch_id, source_system, enterprise_key, mode, account_set_id,
       content_fingerprint, status, attempts, created_at, updated_at, result_json)
     VALUES ('OLD-CREATE-BATCH',?,?,'create',1,?,'completed',1,?,?,'{"vouchersCreated":2}')`,
  ).run(SOURCE.system, ENTERPRISE_KEY, contentFingerprint, iso, iso);

  const insSource = conn.prepare(
    `INSERT INTO import_voucher_sources (source_system, enterprise_key, source_voucher_id, account_set_id,
       voucher_id, voucher_fingerprint, content_fingerprint, batch_id, created_at)
     VALUES (?,?,?,1,?,?,?,'OLD-CREATE-BATCH',?)`,
  );
  const insLink = conn.prepare(
    `INSERT INTO import_batch_vouchers (batch_id, source_system, enterprise_key, source_voucher_id,
       account_set_id, voucher_id, content_fingerprint, action, created_at)
     VALUES ('OLD-CREATE-BATCH',?,?,?,1,?,?,'created',?)`,
  );
  PAYLOAD_VOUCHERS.forEach((voucher, index) => {
    const voucherId = voucherIds[index];
    const row = conn.prepare(`SELECT * FROM vouchers WHERE id=?`).get(voucherId);
    const entries = conn.prepare(
      `SELECT code, summary, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`,
    ).all(voucherId);
    const content = S.voucherFingerprint(voucher);
    const persisted = S.persistedVoucherFingerprint(row, entries);
    insSource.run(SOURCE.system, ENTERPRISE_KEY, voucher.sourceVoucherId, voucherId, persisted, content, iso);
    insLink.run(SOURCE.system, ENTERPRISE_KEY, voucher.sourceVoucherId, voucherId, content, iso);
  });
  return { dir, file, conn };
}

function runChild(dir, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, WORKBENCH_DATA_DIR: dir },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`child failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const reportScript = `
  const { db } = await import("./server/db.mjs");
  const A = await import("./server/accounting.mjs");
  const S = await import("./server/import-storage.mjs");
  const set = A.getAccountSet(1);
  const bs = A.balanceSheet(1, "2025-11");
  const is = A.incomeStatement(1, "2025-11");
  console.log(JSON.stringify({
    version: S.schemaVersion(db),
    profileId: set.accountingContext.profileId,
    declaredStandard: set.accountingContext.declaredStandard,
    legacy: set.accountingContext.legacy,
    assets: bs.totals.assets,
    equity: bs.totals.equity,
    cash: bs.totals.assets - 800,
    netProfit: is.current["净利润"],
    status: bs.reportStatus.status,
    complete: bs.reportStatus.complete,
    diagnostic: bs.reportStatus.diagnostics[0]?.code,
    columns: db.prepare("PRAGMA table_info(account_sets)").all().map((c) => c.name),
  }));
`;

const replayScript = (options) => `
  const { db } = await import("./server/db.mjs");
  const IM = await import("./server/import-incremental.mjs");
  const result = IM.importIncremental(${JSON.stringify(options)});
  console.log(JSON.stringify({
    ok: result.ok,
    status: result.status,
    accountSetId: result.accountSetId,
    conflicts: result.conflicts.map((c) => c.code),
    errors: result.errors,
    created: result.created,
    vouchers: db.prepare("SELECT COUNT(*) n FROM vouchers").get().n,
    sets: db.prepare("SELECT COUNT(*) n FROM account_sets").get().n,
  }));
`;

const queryScript = (batchId) => `
  const { db } = await import("./server/db.mjs");
  const IM = await import("./server/import-incremental.mjs");
  const state = IM.getImportBatch(${JSON.stringify(batchId)});
  console.log(JSON.stringify({
    status: state.batch.status,
    voucherCount: state.voucherCount,
    states: state.sourceTrace.map((item) => item.state),
    vouchers: db.prepare("SELECT COUNT(*) n FROM vouchers").get().n,
  }));
`;

try {
  S = await import("../server/import-storage.mjs");
  IM = await import("../server/import-incremental.mjs");
  LB = await import("../server/local-backup.mjs");
  ({ COA } = await import("../server/coa.mjs"));
  ({ db: productDb } = await import("../server/db.mjs"));

  console.log("\nLOCAL-03a B1 迁移 / 旧批次兼容验收\n");

  await test("迁移前 v4 合成库：生成当前已验备份并实际 restore-new 到全新目录（v5 备份归 B2）", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mig-v4-"));
    const fixture = makeV4Fixture(join(root, "source"));
    const backupDir = join(root, "backup");
    try {
      // 备份前 checkpoint 只影响本测试的合成源库；迁移本身仍覆盖 WAL 已提交数据（见下一项）。
      fixture.conn.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
      const backup = LB.createBackup({ dbPath: fixture.file, outDir: backupDir });
      assert.equal(backup.ok, true, JSON.stringify(backup));
      assert.equal(backup.backupMeta.schemaVersion, 4, "迁移前备份必须保持 v4 结构");
      const verify = LB.verifyBackup({ backupDir });
      assert.equal(verify.ok, true, JSON.stringify(verify));
      const restored = LB.restoreNew({ backupDir, targetDir: join(root, "restored") });
      assert.equal(restored.ok, true, JSON.stringify(restored));
      assert.equal(restored.summary.schemaVersion, 4);
      const restoredPath = join(restored.targetDir, "workbench.db");
      assert.ok(existsSync(restoredPath));
      const restoredConn = new DatabaseSync(restoredPath, { readOnly: true });
      try {
        assert.equal(columnNames(restoredConn, "account_sets").includes("accounting_profile_id"), false,
          "恢复的迁移前快照不得预先含 v5 列");
        assert.equal(restoredConn.prepare(`SELECT accounting_standard FROM account_sets WHERE id=1`).get().accounting_standard,
          "企业会计准则");
        assert.equal(restoredConn.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 2);
        assert.equal(restoredConn.prepare(`SELECT COUNT(*) n FROM import_batch_vouchers`).get().n, 2);
        assert.equal(restoredConn.prepare(`SELECT status FROM import_batches WHERE batch_id='OLD-CREATE-BATCH'`).get().status,
          "completed");
      } finally { restoredConn.close(); }

      // 恢复库由真实 db.mjs 入口再升级到 v5，并核对旧报表值 / legacy 状态。
      const report = runChild(restored.targetDir, reportScript);
      assert.equal(report.version, S.IMPORT_SCHEMA_VERSION);
      assert.equal(report.columns.includes("accounting_profile_id"), true);
      assert.equal(report.profileId, "legacy-small-coa-v1");
      assert.equal(report.declaredStandard, "企业会计准则");
      assert.equal(report.legacy, true);
      assert.equal(report.assets, 13800, "旧兼容报表资产（银行 13000 + 库存 800）");
      assert.equal(report.equity, 13800);
      assert.equal(report.netProfit, 1800, "旧兼容利润（3000 - 1200）");
      assert.equal(report.status, "legacy_compatibility");
      assert.equal(report.complete, false);
      assert.equal(report.diagnostic, "legacy_profile_compatibility");
    } finally {
      try { fixture.conn.close(); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  await test("v4 → v5 迁移：备份含 WAL 已提交批次、旧业务 / 指纹原样、所有旧标签账套均为 legacy", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mig-upgrade-"));
    const fixture = makeV4Fixture(join(root, "source"));
    try {
      const before = snapshot(fixture.conn);
      // 迁移前批次行仍在 WAL 中（未 checkpoint）；迁移备份必须包含它。
      assert.ok(existsSync(`${fixture.file}-wal`));
      const out = S.ensureImportSchema(fixture.conn, { dataDir: fixture.dir });
      assert.equal(out.from, 4);
      assert.equal(out.to, 5);
      assert.ok(out.backup?.path && existsSync(out.backup.path));
      const backupConn = new DatabaseSync(out.backup.path, { readOnly: true });
      try {
        assert.equal(backupConn.prepare(`SELECT status FROM import_batches WHERE batch_id='OLD-CREATE-BATCH'`).get().status,
          "completed", "迁移前备份必须包含 WAL 中已提交的批次");
        assert.equal(columnNames(backupConn, "account_sets").includes("accounting_profile_id"), false,
          "备份必须是迁移前结构");
      } finally { backupConn.close(); }

      assert.equal(S.schemaVersion(fixture.conn), 5);
      assert.ok(columnNames(fixture.conn, "account_sets").includes("accounting_profile_id"));
      const profiles = fixture.conn.prepare(`SELECT id, accounting_standard, accounting_profile_id FROM account_sets ORDER BY id`).all();
      assert.deepEqual(profiles.map((row) => row.accounting_profile_id),
        ["legacy-small-coa-v1", "legacy-small-coa-v1", "legacy-small-coa-v1"]);
      assert.deepEqual(profiles.map((row) => row.accounting_standard),
        ["企业会计准则", "小企业会计准则", "某地方历史准则"], "原 accounting_standard 字符串必须保留");
      assert.deepEqual(snapshot(fixture.conn), before, "业务行 / 指纹 / 来源批次不得被迁移改写");
    } finally {
      try { fixture.conn.close(); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  await test("旧 create 批次：跨升级 / 新进程原样重放、内容变化冲突、append 与查询", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mig-replay-"));
    const fixture = makeV4Fixture(join(root, "source"));
    try {
      S.ensureImportSchema(fixture.conn, { dataDir: fixture.dir });
      fixture.conn.close();
      const before = snapshotFile(fixture.file);
      const replayOptions = {
        batchId: "OLD-CREATE-BATCH", source: SOURCE, mode: "create", dryRun: false, payload: PAYLOAD,
      };
      const replay = runChild(fixture.dir, replayScript(replayOptions));
      assert.equal(replay.ok, true, JSON.stringify(replay.conflicts));
      assert.equal(replay.status, "idempotent_replay");
      assert.equal(replay.accountSetId, 1);
      assert.equal(replay.sets, before.account_sets.length);
      assert.equal(replay.vouchers, before.vouchers.length);
      const afterReplay = snapshotFile(fixture.file);
      assert.deepEqual(afterReplay, before, "重放不得新增账套 / 凭证 / 批次");

      const changed = JSON.parse(JSON.stringify(PAYLOAD));
      changed.vouchers[0].entries[0].debit = 3001;
      changed.vouchers[0].entries[1].credit = 3001;
      const conflict = runChild(fixture.dir, replayScript({ ...replayOptions, payload: changed }));
      assert.equal(conflict.ok, false);
      assert.equal(conflict.status, "conflict");
      assert.ok(conflict.conflicts.includes("batch_content_changed"));

      const appendPayload = {
        account_set: { name: META.name, start_period: "2025-11", accounting_standard: "企业会计准则" },
        opening_balances: [],
        vouchers: [{
          period: "2025-12", date: "2025-12-10", word: "记", number: 1, summary: "旧账套追加",
          sourceVoucherId: "OLD-3",
          entries: [
            { code: "1002", summary: "旧账套追加", debit: 500, credit: 0 },
            { code: "5001", summary: "旧账套追加", debit: 0, credit: 500 },
          ],
        }],
      };
      const appended = runChild(fixture.dir, replayScript({
        batchId: "OLD-APPEND-BATCH",
        source: SOURCE,
        mode: "append",
        accountSetId: 1,
        dryRun: false,
        payload: appendPayload,
      }));
      assert.equal(appended.ok, true, JSON.stringify(appended.errors));
      assert.equal(appended.status, "applied");
      assert.equal(appended.vouchers, before.vouchers.length + 1);
      // 重启后查询：批次 / 来源追踪一致。
      const queried = runChild(fixture.dir, queryScript("OLD-APPEND-BATCH"));
      assert.equal(queried.status, "completed");
      assert.equal(queried.voucherCount, 1);
      assert.deepEqual(queried.states, ["ok"]);
      // 旧账套 profile 仍为 legacy（append 的准则标签不改 profile）。
      const conn = new DatabaseSync(fixture.file, { readOnly: true });
      try {
        assert.equal(conn.prepare(`SELECT accounting_profile_id FROM account_sets WHERE id=1`).get().accounting_profile_id,
          "legacy-small-coa-v1");
        assert.equal(conn.prepare(`SELECT accounting_standard FROM account_sets WHERE id=1`).get().accounting_standard,
          "企业会计准则");
      } finally { conn.close(); }
    } finally {
      try { fixture.conn.close(); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  await test("v3 → v5：旧小企标签 / 空账套全部 legacy，业务行与旧报表值不变", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mig-v3-"));
    const dir = join(root, "source");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "workbench.db");
    const conn = new DatabaseSync(file);
    conn.exec(BASE_DDL);
    S.ensureImportSchema(conn, { dataDir: dir, targetVersion: 3 });
    try {
      conn.prepare(
        `INSERT INTO account_sets (name, taxpayer_type, accounting_standard, start_period, created_at)
         VALUES ('v3 小企', '小规模纳税人', '小企业会计准则', '2025-12', ?)`,
      ).run(iso);
      conn.prepare(`INSERT INTO opening_balances (account_set_id, code, debit, credit) VALUES (1,'1002',1000,0)`).run();
      conn.prepare(`INSERT INTO opening_balances (account_set_id, code, debit, credit) VALUES (1,'3001',0,1000)`).run();
      conn.prepare(`INSERT INTO periods (account_set_id, period, status) VALUES (1,'2025-12','open')`).run();
      conn.prepare(
        `INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, kind, created_at)
         VALUES (1,'2025-12','2025-12-10','记',1,'v3 收入','posted','normal',?)`,
      ).run(iso);
      conn.prepare(`INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit)
                    VALUES (1,1,'1002','v3 收入',300,0)`).run();
      conn.prepare(`INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit)
                    VALUES (1,2,'5001','v3 收入',0,300)`).run();
      const before = snapshot(conn);
      const out = S.ensureImportSchema(conn, { dataDir: dir });
      assert.equal(out.from, 3);
      assert.equal(out.to, 5);
      assert.equal(conn.prepare(`SELECT accounting_profile_id FROM account_sets WHERE id=1`).get().accounting_profile_id,
        "legacy-small-coa-v1");
      assert.equal(conn.prepare(`SELECT accounting_standard FROM account_sets WHERE id=1`).get().accounting_standard,
        "小企业会计准则");
      assert.ok(columnNames(conn, "asset_cards").includes("ledger_status"), "v3 升级仍需补齐 v4 列");
      assert.deepEqual(snapshot(conn), before);
    } finally {
      try { conn.close(); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  await test("迁移故障注入：v5 加列失败整体回滚（版本 / 结构 / 业务不变），重试重新备份", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mig-fail-"));
    const fixture = makeV4Fixture(join(root, "source"));
    try {
      const before = snapshot(fixture.conn);
      const originalExec = fixture.conn.exec.bind(fixture.conn);
      let injected = false;
      fixture.conn.exec = (sql) => {
        if (!injected && /ALTER TABLE account_sets ADD COLUMN accounting_profile_id/.test(sql)) {
          injected = true;
          throw new Error("inject_v5_fail");
        }
        return originalExec(sql);
      };
      let error = null;
      try { S.ensureImportSchema(fixture.conn, { dataDir: fixture.dir }); } catch (e) { error = e; }
      fixture.conn.exec = originalExec;
      assert.ok(error);
      assert.equal(error.message, "migration_failed");
      assert.equal(S.schemaVersion(fixture.conn), 4, "失败后版本必须回滚");
      assert.equal(columnNames(fixture.conn, "account_sets").includes("accounting_profile_id"), false);
      assert.ok(error.details.backupPath && existsSync(error.details.backupPath), "失败也保留迁移前备份");
      assert.deepEqual(snapshot(fixture.conn), before);
      const retry = S.ensureImportSchema(fixture.conn, { dataDir: fixture.dir });
      assert.equal(retry.to, 5);
      assert.notEqual(retry.backup.path, error.details.backupPath, "重试必须重新备份");
      assert.equal(columnNames(fixture.conn, "account_sets").includes("accounting_profile_id"), true);
      assert.deepEqual(snapshot(fixture.conn), before);
    } finally {
      try { fixture.conn.close(); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  await test("未知 / 损坏 profile：正常业务结构化拒绝，只读原始行仍可核对（不 fallback 新小企）", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mig-badprofile-"));
    const fixture = makeV4Fixture(join(root, "source"));
    try {
      S.ensureImportSchema(fixture.conn, { dataDir: fixture.dir });
      fixture.conn.prepare(`UPDATE account_sets SET accounting_profile_id='future-profile-v9' WHERE id=1`).run();
      fixture.conn.close();
      const script = `
        const { db } = await import("./server/db.mjs");
        const A = await import("./server/accounting.mjs");
        const raw = db.prepare("SELECT id, accounting_standard, accounting_profile_id FROM account_sets WHERE id=1").get();
        let code = null; let details = null;
        try { A.balanceSheet(1, "2025-11"); } catch (error) { code = error.code; details = error.details; }
        let periodCode = null; let periodDetails = null;
        try { A.periodEndCheck(1, "2025-11"); } catch (error) { periodCode = error.code; periodDetails = error.details; }
        console.log(JSON.stringify({ raw, code, details, periodCode, periodDetails }));
      `;
      const result = runChild(fixture.dir, script);
      assert.equal(result.raw.accounting_profile_id, "future-profile-v9");
      assert.equal(result.code, "accounting_profile_unknown");
      assert.equal(result.periodCode, "accounting_profile_unknown");
      // 未知 profile 只回固定 field / reason，不回显库内任意原始字符串（也不 fallback）。
      for (const [label, details] of [["report", result.details], ["period-end", result.periodDetails]]) {
        assert.deepEqual(Object.keys(details).sort(), ["field", "reason"], `${label} 只回固定字段`);
        assert.equal(details.field, "accounting_profile_id");
        assert.equal(details.reason, "profile-not-registered");
        assert.equal(JSON.stringify(details).includes("future-profile-v9"), false, `${label} 不得回显原始 profile`);
      }
    } finally {
      try { fixture.conn.close(); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error("测试初始化失败：", error);
  process.exitCode = 1;
} finally {
  try { productDb?.close(); } catch { /* ignore */ }
  try { rmSync(productDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}
