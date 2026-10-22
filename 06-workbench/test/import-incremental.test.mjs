#!/usr/bin/env node
/**
 * LOCAL-01 增量导入回归（领域层）：完全合成临时库，不连接任何既有业务库。
 *
 * 覆盖：
 *  - 旧 `importAccountSet` 无新增参数的用法兼容（返回结构 / dryRun 缺省 / 不产生身份记录）；
 *  - 有来源 / 企业 / 批次的首次建账、指定已有账套追加、连续两个月；
 *  - 一企一账套：以规范 enterpriseKey 为范围（不是同 source.system 内），跨来源同企业引导到已有账套 /
 *    显式确认来源证据后追加到同一账套；同账套不得绑定另一企业；不同企业各自一个账套互不串账；
 *  - 稳定来源 / 企业身份、批次 ID、来源凭证 ID、规范内容指纹；
 *  - 同批重试不新增账套 / 凭证、不同批相同来源凭证去重、内容修订结构化冲突、绝静默覆盖；
 *  - 本批自身重复、业务凭证字号冲突；
 *  - 来源凭证被本机反过账 / 修改 / 删除后，去重与回放给结构化冲突，不按来源指纹伪报完成；
 *  - 身份不匹配 / 科目不兼容 / 已封账期间 / 期初覆盖 / 同批 ID 内容变化 一律拒绝；
 *  - 预检与正式共用规则且预检不写入；单事务中途故障后原库业务状态不变；
 *  - 已完成批次不被失败审计（markBatchFailed）覆写；
 *  - 独立手算两个月凭证 / 余额 / 利润，未过账不入报表；
 *  - 迁移在备份之后、事务之内建立新结构；迁移失败保护原库、重试重新备份且不复用损坏 / 过期备份；
 *    备份恢复真实包含 WAL 中已提交数据；v1 候选库可逐级升级并回填落库指纹 / 批次关联。
 *
 * 运行：node test/import-incremental.test.mjs（在 06-workbench 目录）
 */
import { mkdtempSync, rmSync, copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const dataDir = mkdtempSync(join(tmpdir(), "wb-inc-"));
process.env.WORKBENCH_DATA_DIR = dataDir;

let db, A, IM, S;
const results = [];
const test = (name, fn) => {
  try { fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const BUSINESS_TABLES = ["account_sets", "accounts", "opening_balances", "periods", "vouchers", "voucher_entries"];
const IMPORT_TABLES = ["import_enterprise_account_sets", "import_source_bindings", "import_batches", "import_voucher_sources", "import_batch_vouchers"];

/** 业务状态快照：既有业务表全部行的内容，用于证明失败 / 预检不污染数据。 */
const businessSnapshot = () => ({
  account_sets: db.prepare(`SELECT * FROM account_sets ORDER BY id`).all(),
  accounts: db.prepare(`SELECT * FROM accounts ORDER BY id`).all(),
  opening_balances: db.prepare(`SELECT * FROM opening_balances ORDER BY account_set_id, code`).all(),
  periods: db.prepare(`SELECT * FROM periods ORDER BY account_set_id, period`).all(),
  vouchers: db.prepare(`SELECT * FROM vouchers ORDER BY id`).all(),
  voucher_entries: db.prepare(`SELECT * FROM voucher_entries ORDER BY id`).all(),
});
/** 全库快照（含新增的身份 / 批次 / 来源追踪表）：预检必须连审计表都不写。 */
const fullSnapshot = () => ({
  ...businessSnapshot(),
  import_enterprise_account_sets: db.prepare(`SELECT * FROM import_enterprise_account_sets ORDER BY enterprise_key`).all(),
  import_source_bindings: db.prepare(`SELECT * FROM import_source_bindings ORDER BY id`).all(),
  import_batches: db.prepare(`SELECT * FROM import_batches ORDER BY batch_id`).all(),
  import_voucher_sources: db.prepare(`SELECT * FROM import_voucher_sources ORDER BY id`).all(),
  import_batch_vouchers: db.prepare(`SELECT * FROM import_batch_vouchers ORDER BY id`).all(),
});

const SOURCE_A = { system: "local-book", enterpriseKey: "91350000TEST0001X", enterpriseName: "合成甲公司" };
const SOURCE_B = { system: "local-book", enterpriseKey: "91350000TEST0002Y", enterpriseName: "合成乙公司" };
const SOURCE_C = { system: "local-book", enterpriseKey: "91350000TEST0003Z", enterpriseName: "合成丙公司" };
const SOURCE_D = { system: "local-book", enterpriseKey: "91350000TEST0004D", enterpriseName: "合成丁公司" };

const meta = (name, over = {}) => ({
  name, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01", ...over,
});
const journal = (period, date, number, summary, entries, sourceVoucherId) => ({
  period, date, word: "记", number, summary, entries,
  ...(sourceVoucherId ? { sourceVoucherId } : {}),
});

// ---- Set A：连续两个月（独立手算数值的基准场景） ----
const OPENINGS_A = [
  { code: "1002", debit: 100000, credit: 0 },
  { code: "1405", debit: 6000, credit: 0 },
  { code: "3001", debit: 0, credit: 106000 },
];
const payloadCreateA = () => ({
  account_set: meta("合成甲公司"),
  opening_balances: OPENINGS_A.map((o) => ({ ...o })),
  vouchers: [
    journal("2026-01", "2026-01-10", 1, "销售商品", [
      { code: "1122", debit: 11300, credit: 0 },
      { code: "5001", debit: 0, credit: 10000 },
      { code: "2221", debit: 0, credit: 1300 },
    ], "SRC-A-2026-01-0001"),
    journal("2026-01", "2026-01-20", 2, "支付办公费", [
      { code: "5602", debit: 2000, credit: 0 },
      { code: "1002", debit: 0, credit: 2000 },
    ], "SRC-A-2026-01-0002"),
  ],
});
const payloadAppendFebA = () => ({
  account_set: meta("合成甲公司"),
  vouchers: [
    journal("2026-02", "2026-02-12", 1, "收回货款", [
      { code: "1002", debit: 11300, credit: 0 },
      { code: "1122", debit: 0, credit: 11300 },
    ], "SRC-A-2026-02-0001"),
    journal("2026-02", "2026-02-28", 2, "结转成本", [
      { code: "5401", debit: 6000, credit: 0 },
      { code: "1405", debit: 0, credit: 6000 },
    ], "SRC-A-2026-02-0002"),
  ],
});

// ---- Set D：来源凭证状态核验（反过账 / 修改 / 删除）专用 ----
const vouchersD = () => [
  journal("2026-01", "2026-01-05", 1, "D1", [
    { code: "5602", debit: 10, credit: 0 }, { code: "1002", debit: 0, credit: 10 },
  ], "SRC-D-1"),
  journal("2026-01", "2026-01-06", 2, "D2", [
    { code: "5602", debit: 20, credit: 0 }, { code: "1002", debit: 0, credit: 20 },
  ], "SRC-D-2"),
];
const payloadCreateD = () => ({ account_set: meta("合成丁公司"), vouchers: vouchersD() });
const payloadAppendD = () => ({ account_set: meta("合成丁公司"), vouchers: vouchersD() });

const balanceOf = (setId, period, code) => A.accountBalances(setId, period).get(code);

// ---------------------------------------------------------------- 合成旧库
/** 旧库 DDL（迁移前的历史结构子集）：只用于验证「迁移前备份 / 迁移失败保护」。 */
function createLegacyDb(file) {
  const conn = new DatabaseSync(file);
  conn.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE account_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      taxpayer_type TEXT NOT NULL DEFAULT '小规模纳税人',
      accounting_standard TEXT NOT NULL DEFAULT '小企业会计准则',
      start_period TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
      period TEXT NOT NULL, voucher_date TEXT NOT NULL, word TEXT NOT NULL DEFAULT '记', number INTEGER NOT NULL,
      summary TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'normal'
    );
    CREATE TABLE voucher_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL, code TEXT NOT NULL, summary TEXT,
      debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0
    );
    INSERT INTO account_sets (name, start_period, created_at) VALUES ('旧库合成公司', '2025-12', '2025-12-01T00:00:00.000Z');
    INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, created_at)
      VALUES (1, '2025-12', '2025-12-05', '记', 1, '旧库历史凭证', 'posted', '2025-12-05T00:00:00.000Z');
    INSERT INTO voucher_entries (voucher_id, line_no, code, debit, credit) VALUES (1, 1, '1002', 5000, 0);
    INSERT INTO voucher_entries (voucher_id, line_no, code, debit, credit) VALUES (1, 2, '3001', 0, 5000);
  `);
  return conn;
}

try {
  ({ db } = await import("../server/db.mjs"));
  A = await import("../server/accounting.mjs");
  IM = await import("../server/import-incremental.mjs");
  S = await import("../server/import-storage.mjs");

  console.log("\nLOCAL-01 增量导入（领域层）回归测试\n");

  // ================================================================ 迁移 / 备份
  await test("迁移：带未 checkpoint WAL 的合成旧库，迁移前生成一致备份并可恢复", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-inc-mig-"));
    const file = join(dir, "workbench.db");
    let writer, migrator;
    try {
      writer = createLegacyDb(file);
      // WAL 中已有已提交数据但未 checkpoint：这正是「重启前」的真实状态。
      const wal = `${file}-wal`;
      assert.ok(existsSync(wal) && statSync(wal).size > 0, "旧库应存在未 checkpoint 的 WAL");

      migrator = new DatabaseSync(file);
      migrator.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON`);
      assert.equal(S.schemaVersion(migrator), 0, "旧库迁移前版本应为 0");
      const out = S.ensureImportSchema(migrator, { dataDir: dir });
      assert.equal(out.migrated, true);
      assert.equal(out.from, 0);
      assert.equal(out.to, S.IMPORT_SCHEMA_VERSION);
      assert.ok(out.backup?.path && existsSync(out.backup.path), "必须留下备份文件");

      // 备份必须是单文件一致快照：包含 WAL 中的已提交数据，且完整性检查通过。
      const backup = new DatabaseSync(out.backup.path, { readOnly: true });
      try {
        assert.equal(backup.prepare(`PRAGMA integrity_check`).get().integrity_check, "ok");
        assert.equal(backup.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, 1);
        assert.equal(backup.prepare(`SELECT summary FROM vouchers`).get().summary, "旧库历史凭证");
        // 回退方式：把备份文件复制到新路径即可作为一个完整库打开（不依赖原 -wal）。
        const restored = join(dir, "restored.db");
        copyFileSync(out.backup.path, restored);
        const restoredDb = new DatabaseSync(restored, { readOnly: true });
        try {
          assert.equal(restoredDb.prepare(`PRAGMA integrity_check`).get().integrity_check, "ok");
          assert.equal(restoredDb.prepare(`SELECT COUNT(*) n FROM voucher_entries`).get().n, 2);
          // 备份保持迁移前结构：新表不存在。
          assert.equal(restoredDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_batches'`).get(),
            undefined, "备份应保持迁移前结构（没有新表）");
        } finally { restoredDb.close(); }
      } finally { backup.close(); }

      // 新表已建立，旧数据未被破坏。
      assert.equal(S.schemaVersion(migrator), S.IMPORT_SCHEMA_VERSION);
      for (const t of S.IMPORT_TABLES) {
        assert.ok(migrator.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), `缺少表 ${t}`);
      }
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 1, "迁移不得改动旧业务数据");
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, 1);

      // 重复启动不重复备份：同版本已有备份即复用。
      const again = S.ensureImportSchema(migrator, { dataDir: dir });
      assert.equal(again.migrated, false);
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM schema_backups`).get().n, 1, "同版本只应备份一次");
    } finally {
      try { migrator?.close(); } catch { /* ignore */ }
      try { writer?.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("迁移失败：先备份后迁移，失败回滚原库 schema / 业务数据不变；重试重新备份且不复用损坏旧备份", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-inc-migfail-"));
    const file = join(dir, "workbench.db");
    let writer, migrator;
    try {
      writer = createLegacyDb(file);
      // 故障注入：预置一个结构不兼容的 import_batches（模拟不可直接接续的候选库结构），
      // 让迁移事务在创建索引时真实失败；不给生产代码留后门。
      writer.exec(`CREATE TABLE import_batches (id INTEGER PRIMARY KEY, note TEXT)`);

      migrator = new DatabaseSync(file);
      migrator.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON`);
      let thrown = null;
      try { S.ensureImportSchema(migrator, { dataDir: dir }); } catch (e) { thrown = e; }
      assert.ok(thrown, "迁移失败必须抛出，不能静默成功");
      assert.equal(thrown.message, "migration_failed");
      assert.equal(thrown.details?.from, 0);
      const firstBackup = thrown.details?.backupPath;
      assert.ok(firstBackup && existsSync(firstBackup), "失败时备份文件必须保留");

      // 原库 schema / 业务数据不变：版本仍 0、没有半途创建的新表、旧业务数据完好。
      assert.equal(S.schemaVersion(migrator), 0);
      assert.equal(!!migrator.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_source_bindings'`).get(), false,
        "失败的 DDL 必须随事务回滚");
      assert.equal(!!migrator.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_enterprise_account_sets'`).get(), false);
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 1);
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM voucher_entries`).get().n, 2);

      // 备份在迁移事务之前生成：保持迁移前结构（没有 schema_migrations / schema_backups / 导入新表）。
      const firstBackupDb = new DatabaseSync(firstBackup, { readOnly: true });
      try {
        assert.equal(firstBackupDb.prepare(`PRAGMA integrity_check`).get().integrity_check, "ok");
        assert.equal(firstBackupDb.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 1);
        assert.equal(!!firstBackupDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).get(), false);
        assert.equal(!!firstBackupDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_backups'`).get(), false);
        assert.equal(!!firstBackupDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_enterprise_account_sets'`).get(), false);
        assert.equal(!!firstBackupDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_source_bindings'`).get(), false);
      } finally { firstBackupDb.close(); }

      // 损坏旧备份：写成非零垃圾字节，仅按 size>0 判断的实现会误复用它。
      writeFileSync(firstBackup, Buffer.alloc(4096, 0x7a));

      // 原库随后又提交了新业务（仍在 WAL 中）：重试的备份必须包含它。
      writer.exec(`INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, created_at)
                   VALUES (1, '2026-01', '2026-01-09', '记', 9, '失败后新增的合成业务', 'posted', '2026-01-09T00:00:00.000Z')`);
      writer.exec(`INSERT INTO voucher_entries (voucher_id, line_no, code, debit, credit)
                   VALUES ((SELECT MAX(id) FROM vouchers), 1, '1002', 777, 0)`);
      writer.exec(`INSERT INTO voucher_entries (voucher_id, line_no, code, debit, credit)
                   VALUES ((SELECT MAX(id) FROM vouchers), 2, '3001', 0, 777)`);

      // 移除不兼容结构后重试：重新备份（不复用损坏 / 过期备份），迁移成功。
      writer.exec(`DROP TABLE import_batches`);
      const retry = S.ensureImportSchema(migrator, { dataDir: dir });
      assert.equal(retry.migrated, true);
      assert.equal(retry.reusedBackup, false, "失败重试必须重新备份，不能复用旧快照");
      assert.notEqual(retry.backup.path, firstBackup, "损坏的旧备份不得被复用");
      assert.ok(existsSync(retry.backup.path));

      const fresh = new DatabaseSync(retry.backup.path, { readOnly: true });
      try {
        assert.equal(fresh.prepare(`PRAGMA integrity_check`).get().integrity_check, "ok");
        assert.equal(fresh.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, 2, "新备份必须包含失败后新增的已提交业务");
        assert.equal(fresh.prepare(`SELECT summary FROM vouchers WHERE number=9`).get().summary, "失败后新增的合成业务");
        assert.equal(!!fresh.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_source_bindings'`).get(), false,
          "新备份仍应保持迁移前结构");
      } finally { fresh.close(); }

      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM schema_backups`).get().n, 1, "只有成功迁移的备份被登记");
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM schema_migrations`).get().n, S.IMPORT_SCHEMA_VERSION);
      // 成功后再次启动：版本已达目标，不再备份。
      const again = S.ensureImportSchema(migrator, { dataDir: dir });
      assert.equal(again.migrated, false);
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM schema_backups`).get().n, 1, "成功后重启不重复备份");
    } finally {
      try { migrator?.close(); } catch { /* ignore */ }
      try { writer?.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("候选库兼容：v1 合成库逐级升级到当前版本，回填落库指纹 / 批次关联并启用一企一账套唯一关系", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-inc-v1v2-"));
    const file = join(dir, "workbench.db");
    let writer, migrator;
    try {
      writer = createLegacyDb(file);
      migrator = new DatabaseSync(file);
      migrator.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON`);
      const v1 = S.ensureImportSchema(migrator, { dataDir: dir, targetVersion: 1 });
      assert.equal(v1.to, 1);
      migrator.prepare(`INSERT INTO import_source_bindings
                          (source_system, enterprise_key, enterprise_name, account_set_id, bound_at, bound_by)
                        VALUES ('local-book','91350000V1TEST001X','v1 合成企业',1,'2025-12-31T00:00:00.000Z','import')`).run();
      const vid = Number(migrator.prepare(`INSERT INTO vouchers
                          (account_set_id, period, voucher_date, word, number, summary, status, created_at)
                        VALUES (1,'2025-12','2025-12-05','记',1,'v1 历史凭证','posted','2025-12-05T00:00:00.000Z')`).run().lastInsertRowid);
      migrator.prepare(`INSERT INTO voucher_entries (voucher_id,line_no,code,summary,debit,credit) VALUES (?,1,'1002','',5000,0)`).run(vid);
      migrator.prepare(`INSERT INTO voucher_entries (voucher_id,line_no,code,summary,debit,credit) VALUES (?,2,'3001','',0,5000)`).run(vid);
      migrator.prepare(`INSERT INTO import_voucher_sources
                          (source_system,enterprise_key,source_voucher_id,account_set_id,voucher_id,content_fingerprint,batch_id,created_at)
                        VALUES ('local-book','91350000V1TEST001X','V1-SRC-1',1,?,'fp-v1','V1-BATCH','2025-12-31T00:00:00.000Z')`).run(vid);

      const v2 = S.ensureImportSchema(migrator, { dataDir: dir, targetVersion: 2 });
      assert.equal(v2.from, 1);
      assert.equal(v2.to, 2);
      assert.equal(v2.reusedBackup, false);
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM schema_backups`).get().n, 2, "每个版本各一份迁移前备份");
      const canonical = migrator.prepare(`SELECT * FROM import_enterprise_account_sets`).get();
      assert.equal(canonical.enterprise_key, "91350000V1TEST001X");
      assert.equal(canonical.account_set_id, 1);
      const src = migrator.prepare(`SELECT * FROM import_voucher_sources WHERE source_voucher_id='V1-SRC-1'`).get();
      assert.match(src.voucher_fingerprint, /^[a-f0-9]{64}$/, "v1 历史登记必须回填落库指纹");
      const voucher = migrator.prepare(`SELECT * FROM vouchers WHERE id=?`).get(vid);
      const entries = migrator.prepare(`SELECT code,summary,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`).all(vid);
      assert.equal(src.voucher_fingerprint, S.persistedVoucherFingerprint(voucher, entries));

      // 唯一关系：一家企业只能一个账套；一个账套只能一家企业。
      migrator.prepare(`INSERT INTO account_sets (name,start_period,created_at)
                        VALUES ('v1 第二本合成账套','2025-12','2025-12-01T00:00:00.000Z')`).run();
      assert.throws(() => migrator.prepare(`INSERT INTO import_enterprise_account_sets
                          (enterprise_key, enterprise_name, account_set_id, bound_at)
                        VALUES ('91350000V1TEST001X','dup',2,'2025-12-31T00:00:00.000Z')`).run(), /UNIQUE/);
      assert.throws(() => migrator.prepare(`INSERT INTO import_enterprise_account_sets
                          (enterprise_key, enterprise_name, account_set_id, bound_at)
                        VALUES ('91350000OTHER001X','other',1,'2025-12-31T00:00:00.000Z')`).run(), /UNIQUE/);

      // v2 -> v3：历史逐张来源登记回填为「批次 -> 来源凭证」关联（历史批次一律按 created）。
      const v3 = S.ensureImportSchema(migrator, { dataDir: dir });
      assert.equal(v3.from, 2);
      assert.equal(v3.to, S.IMPORT_SCHEMA_VERSION);
      assert.equal(migrator.prepare(`SELECT COUNT(*) n FROM schema_backups`).get().n, 3, "v3 也应先备份再建新结构");
      const link = migrator.prepare(`SELECT * FROM import_batch_vouchers WHERE batch_id='V1-BATCH'`).get();
      assert.ok(link, "v2 历史批次必须回填逐张关联");
      assert.equal(link.source_voucher_id, "V1-SRC-1");
      assert.equal(link.voucher_id, vid);
      assert.equal(link.account_set_id, 1);
      assert.equal(link.action, "created");
      assert.equal(link.content_fingerprint, "fp-v1");
    } finally {
      try { migrator?.close(); } catch { /* ignore */ }
      try { writer?.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("启动接线：db.mjs 已应用导入 schema 版本且记录了迁移备份", () => {
    const state = S.schemaState(db);
    assert.equal(state.version, S.IMPORT_SCHEMA_VERSION);
    for (const t of S.IMPORT_TABLES) assert.ok(state.tables.includes(t), `缺少表 ${t}`);
    assert.ok(state.backups.length >= 1, "首次启动应留下迁移备份记录");
    assert.ok(existsSync(state.backups[0].path));
  });

  // ================================================================ 旧导入兼容
  await test("旧 importAccountSet 用法兼容：域层 dryRun 缺省不变、正式导入返回原结构、不产生身份记录", () => {
    const legacyPayload = {
      account_set: meta("旧接口合成公司"),
      opening_balances: [{ code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 }],
      vouchers: [journal("2026-01", "2026-01-05", 1, "旧接口凭证", [
        { code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 },
      ])],
    };
    const before = fullSnapshot();
    const dry = A.importAccountSet(legacyPayload, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.validation.ok, true, JSON.stringify(dry.validation.errors));
    assert.equal(dry.created, null);
    assert.deepEqual(fullSnapshot(), before, "旧接口 dryRun 不得写入（含新增审计表）");

    // 域层缺省仍是 dryRun=false（既有行为，不因本包改变）；HTTP / Agent / MCP 入口才默认预检。
    const formal = A.importAccountSet(legacyPayload);
    assert.equal(formal.dryRun, false);
    assert.equal(formal.validation.ok, true, JSON.stringify(formal.validation.errors));
    assert.deepEqual(Object.keys(formal).sort(), ["created", "dryRun", "validation"]);
    assert.equal(formal.created.name, "旧接口合成公司");
    assert.equal(formal.created.vouchers, 1);
    assert.ok(formal.created.id > 0);
    // 旧入口不写来源身份 / 批次：两者互不影响。
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_source_bindings`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_batches`).get().n, 0);
    A.deleteAccountSet(formal.created.id);
  });

  // ================================================================ 首次建账（有身份）
  let setId = null;
  await test("预检：有来源 / 企业 / 批次的首次建账只读，不写任何表", () => {
    const before = fullSnapshot();
    const r = IM.importIncremental({
      payload: payloadCreateA(), batchId: "A-2026-01", source: SOURCE_A,
    });
    assert.equal(r.status, IM.STATUS.PREVIEW);
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.created, null);
    assert.equal(r.accountSetId, null);
    assert.equal(r.planned.accountSetCreated, true);
    assert.deepEqual(r.planned.vouchersToCreate, ["SRC-A-2026-01-0001", "SRC-A-2026-01-0002"]);
    assert.equal(r.validation.summary.vouchers, 2);
    assert.ok(r.sourceTrace.every((t) => t.status === "would_create"));
    assert.deepEqual(fullSnapshot(), before, "预检不得写入任何表");
  });

  await test("正式建账：账套 / 期初 / 凭证 / 来源绑定 / 批次 / 逐张来源追踪一次到位", () => {
    const r = IM.importIncremental({
      payload: payloadCreateA(), batchId: "A-2026-01", source: SOURCE_A, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    assert.equal(r.ok, true);
    assert.equal(r.created.accountSetCreated, true);
    assert.equal(r.created.vouchersCreated, 2);
    assert.equal(r.created.openingBalancesApplied, 3);
    setId = r.created.accountSetId;
    assert.ok(setId > 0);
    assert.equal(r.batch.status, "completed");
    assert.match(r.batch.contentFingerprint, /^[a-f0-9]{64}$/);

    const canonical = db.prepare(`SELECT * FROM import_enterprise_account_sets`).get();
    assert.equal(canonical.account_set_id, setId);
    assert.equal(canonical.enterprise_key, SOURCE_A.enterpriseKey);
    assert.equal(canonical.bound_by, "import");
    const sourceBinding = db.prepare(`SELECT * FROM import_source_bindings WHERE enterprise_key=?`).get(SOURCE_A.enterpriseKey);
    assert.equal(sourceBinding.source_system, "local-book");
    assert.equal(sourceBinding.bound_by, "import");

    const trace = db.prepare(`SELECT * FROM import_voucher_sources ORDER BY id`).all();
    assert.equal(trace.length, 2);
    assert.deepEqual(trace.map((t) => t.source_voucher_id),
      ["SRC-A-2026-01-0001", "SRC-A-2026-01-0002"]);
    for (const t of trace) {
      assert.equal(t.account_set_id, setId);
      assert.equal(t.batch_id, "A-2026-01");
      assert.match(t.content_fingerprint, /^[a-f0-9]{64}$/);
      assert.match(t.voucher_fingerprint, /^[a-f0-9]{64}$/);
    }
    assert.equal(A.listVouchers(setId, { period: "2026-01" }).filter((v) => v.status === "posted").length, 2);
  });

  await test("同批重试：不新增账套 / 凭证 / 期初，回放既有结果（含进程重启后）", () => {
    const before = fullSnapshot();
    const r = IM.importIncremental({
      payload: payloadCreateA(), batchId: "A-2026-01", source: SOURCE_A, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.REPLAY);
    assert.equal(r.replayed, true);
    assert.equal(r.created.vouchersCreated, 0);
    assert.equal(r.created.previouslyCreated, 2);
    assert.equal(r.created.vouchersDeduplicated, 2);
    assert.equal(r.accountSetId, setId);
    assert.equal(r.sourceTrace.length, 2);
    assert.deepEqual(fullSnapshot(), before, "同批重试不得写入任何表");
    // 批次记录持久在库里，重启后仍可识别：直接读库验证。
    const stored = IM.getImportBatch("A-2026-01");
    assert.equal(stored.batch.status, "completed");
    assert.equal(stored.batch.contentFingerprint, r.batch.contentFingerprint ?? stored.batch.contentFingerprint);
    assert.equal(stored.voucherCount, 2);
  });

  await test("同批 ID 但内容变化：结构化冲突，不覆盖既有数据", () => {
    const changed = payloadCreateA();
    changed.vouchers[0].entries = [{ code: "1122", debit: 1000, credit: 0 }, { code: "5001", debit: 0, credit: 1000 }];
    const before = fullSnapshot();
    const r = IM.importIncremental({
      payload: changed, batchId: "A-2026-01", source: SOURCE_A, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.CONFLICT);
    assert.ok(r.conflicts.some((c) => c.code === "batch_content_changed"), JSON.stringify(r.conflicts));
    assert.deepEqual(fullSnapshot(), before, "内容变化的同批 ID 不得写入");
  });

  await test("同一企业身份重复建账被拒绝（同一绑定范围不得重复建账）", () => {
    const r = IM.importIncremental({
      payload: payloadCreateA(), batchId: "A-2026-01-dup", source: SOURCE_A, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.CONFLICT);
    assert.ok(r.conflicts.some((c) => c.code === "enterprise_already_bound"), JSON.stringify(r.conflicts));
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets WHERE name='合成甲公司'`).get().n, 1);
  });

  await test("账套名称不能充当企业身份：enterpriseKey 与账套名相同直接拒绝", () => {
    const r = IM.importIncremental({
      payload: payloadCreateA(),
      batchId: "A-name-as-key",
      source: { system: "local-book", enterpriseKey: "合成甲公司" },
    });
    assert.equal(r.status, IM.STATUS.CONFLICT);
    assert.ok(r.conflicts.some((c) => c.code === "enterprise_key_is_account_set_name"), JSON.stringify(r.conflicts));
  });

  // ================================================================ 追加已有账套
  await test("追加：指定已有账套写入第二个月，账套不重建、来源绑定不变", () => {
    const beforeSets = db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n;
    const r = IM.importIncremental({
      payload: payloadAppendFebA(), batchId: "A-2026-02", source: SOURCE_A,
      mode: "append", accountSetId: setId, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    assert.equal(r.accountSetId, setId);
    assert.equal(r.created.accountSetCreated, false);
    assert.equal(r.created.vouchersCreated, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, beforeSets, "追加不得新建账套");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_enterprise_account_sets`).get().n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_source_bindings`).get().n, 1);
    assert.equal(A.listPeriods(setId).map((p) => p.period).sort().join(","), "2026-01,2026-02");
  });

  await test("跨批重叠：不同批次重复提交同一来源凭证 → 去重不重复记账", () => {
    const r = IM.importIncremental({
      payload: payloadAppendFebA(), batchId: "A-2026-02-repeat", source: SOURCE_A,
      mode: "append", accountSetId: setId, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    assert.equal(r.created.vouchersCreated, 0);
    assert.equal(r.created.vouchersDeduplicated, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setId).n, 4,
      "跨批重叠不得新增凭证");
    assert.equal(r.sourceTrace.filter((t) => t.status === "deduplicated").length, 2);
  });

  await test("内容修订：同一来源凭证 ID 内容变化 → source_voucher_content_changed，绝不覆盖", () => {
    const revised = payloadAppendFebA();
    revised.vouchers[0].entries = [{ code: "1002", debit: 11200, credit: 0 }, { code: "1122", debit: 0, credit: 11200 }];
    const before = fullSnapshot();
    const r = IM.importIncremental({
      payload: revised, batchId: "A-2026-02-revise", source: SOURCE_A,
      mode: "append", accountSetId: setId, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.CONFLICT);
    const c = r.conflicts.find((x) => x.code === "source_voucher_content_changed");
    assert.ok(c, JSON.stringify(r.conflicts));
    assert.equal(c.sourceVoucherId, "SRC-A-2026-02-0001");
    assert.match(c.registeredFingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(c.registeredFingerprint, c.incomingFingerprint);
    assert.deepEqual(fullSnapshot(), before, "内容修订冲突不得改写既有凭证");
  });

  // ================================================================ 手算数值
  await test("两个月余额 / 利润（独立手算）与未过账不入报表", () => {
    // ---- 独立手算：期初 1002=100000 1405=6000 3001=106000 ----
    // 2026-01：1122 +11300 / 5001 +10000 / 2221 +1300；5602 +2000 / 1002 -2000
    // 2026-02：1002 +11300 / 1122 -11300；5401 +6000 / 1405 -6000
    assert.equal(balanceOf(setId, "2026-01", "1002").net, 98000);
    assert.equal(balanceOf(setId, "2026-01", "1122").net, 11300);
    assert.equal(balanceOf(setId, "2026-01", "2221").net, -1300);

    const tbJan = A.trialBalance(setId, "2026-01").totals;
    assert.equal(tbJan.closing_debit, 117300);   // 98000 + 11300 + 6000 + 2000
    assert.equal(tbJan.closing_credit, 117300);  // 1300 + 106000 + 10000

    const jan = A.incomeStatement(setId, "2026-01");
    assert.equal(jan.current["营业收入"], 10000);
    assert.equal(jan.current["营业成本"], 0);
    assert.equal(jan.current["管理费用"], 2000);
    assert.equal(jan.current["净利润"], 8000);
    assert.equal(jan.ytd["净利润"], 8000);

    // 2026-02 月末：1002 = 100000 - 2000 + 11300 = 109300；1122 = 0；1405 = 0
    assert.equal(balanceOf(setId, "2026-02", "1002").net, 109300);
    assert.equal(balanceOf(setId, "2026-02", "1122").net, 0);
    assert.equal(balanceOf(setId, "2026-02", "1405").net, 0);

    const tbFeb = A.trialBalance(setId, "2026-02").totals;
    assert.equal(tbFeb.closing_debit, 117300);    // 109300 + 5401 6000 + 5602 2000
    assert.equal(tbFeb.closing_credit, 117300);   // 1300 + 106000 + 5001 10000

    const feb = A.incomeStatement(setId, "2026-02");
    assert.equal(feb.current["营业收入"], 0);
    assert.equal(feb.current["营业成本"], 6000);
    assert.equal(feb.current["净利润"], -6000);
    assert.equal(feb.ytd["营业收入"], 10000);
    assert.equal(feb.ytd["营业成本"], 6000);
    assert.equal(feb.ytd["管理费用"], 2000);
    assert.equal(feb.ytd["净利润"], 2000);

    const bs = A.balanceSheet(setId, "2026-02");
    const asset = bs.assets.find((l) => l.label === "资产总计").value;
    const liab = bs.liabilities.find((l) => l.label === "负债合计").value;
    const equity = bs.liabilities.find((l) => l.label === "所有者权益合计").value;
    assert.equal(asset, 109300);
    assert.equal(liab, 1300);
    assert.equal(equity, 108000);   // 106000 实收资本 + 2000 未分配利润（本年利润）
    assert.equal(bs.balanced, true);

    // ---- 未过账（草稿）不入报表 ----
    const draft = A.createVoucher(setId, {
      period: "2026-02", voucher_date: "2026-02-15", summary: "草稿不应入报表",
      entries: [{ code: "5602", debit: 500, credit: 0 }, { code: "1002", debit: 0, credit: 500 }],
    });
    assert.equal(draft.status, "draft");
    assert.equal(balanceOf(setId, "2026-02", "1002").net, 109300, "草稿不得影响余额");
    assert.equal(A.trialBalance(setId, "2026-02").totals.closing_debit, 117300, "草稿不得影响试算");
    assert.equal(A.incomeStatement(setId, "2026-02").ytd["净利润"], 2000, "草稿不得影响利润");
    A.deleteVoucher(setId, draft.id);
  });

  // ================================================================ 冲突场景（独立账套）
  let setB = null;
  await test("建立 Set B（另一企业身份）用于冲突场景", () => {
    const r = IM.importIncremental({
      payload: { account_set: meta("合成乙公司", { start_period: "2026-01" }), vouchers: [] },
      batchId: "B-2026-01", source: SOURCE_B, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    setB = r.created.accountSetId;
    assert.ok(setB > 0);
  });

  // ================================================================ 一企一账套（跨来源 / 跨企业）
  await test("跨来源同一企业：create 必须引导到已有账套，不得新建第二本", () => {
    const beforeSets = db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n;
    const r = IM.importIncremental({
      payload: payloadCreateA(), batchId: "A-2026-01-other-src",
      source: { system: "other-book", enterpriseKey: SOURCE_A.enterpriseKey, enterpriseName: "合成甲公司" },
      dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.CONFLICT, JSON.stringify(r.conflicts));
    const c = r.conflicts.find((x) => x.code === "enterprise_already_bound");
    assert.ok(c, JSON.stringify(r.conflicts));
    assert.equal(c.accountSetId, setId, "必须指出已有目标账套");
    assert.deepEqual(c.boundSources, ["local-book"]);
    assert.equal(c.guidance, "mode=append");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, beforeSets, "不得新建第二本账套");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_enterprise_account_sets WHERE enterprise_key=?`)
      .get(SOURCE_A.enterpriseKey).n, 1);
  });

  await test("跨来源同一企业：显式确认来源证据后追加到同一账套，不新建第二本", () => {
    const other = { system: "other-book", enterpriseKey: SOURCE_A.enterpriseKey, enterpriseName: "合成甲公司" };
    const payload = {
      account_set: meta("合成甲公司"),
      vouchers: [journal("2026-03", "2026-03-05", 1, "另一来源补充", [
        { code: "5602", debit: 50, credit: 0 }, { code: "1002", debit: 0, credit: 50 },
      ], "SRC-A-OTHER-0001")],
    };
    const needConfirm = IM.importIncremental({
      payload, batchId: "A-2026-03-other-src",
      source: other, mode: "append", accountSetId: setId, dryRun: false,
    });
    assert.equal(needConfirm.status, IM.STATUS.CONFLICT, JSON.stringify(needConfirm.conflicts));
    assert.ok(needConfirm.conflicts.some((x) => x.code === "account_set_binding_confirmation_required"),
      JSON.stringify(needConfirm.conflicts));

    const applied = IM.importIncremental({
      payload, batchId: "A-2026-03-other-src", source: other,
      mode: "append", accountSetId: setId, confirmNewBinding: true, dryRun: false,
    });
    assert.equal(applied.status, IM.STATUS.APPLIED, JSON.stringify(applied.conflicts));
    assert.equal(applied.planned.bindingAction, "append_confirm");
    assert.equal(applied.created.accountSetCreated, false);
    assert.equal(applied.created.vouchersCreated, 1);
    assert.equal(applied.created.vouchersDeduplicated, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets WHERE name='合成甲公司'`).get().n, 1);

    const bindings = db.prepare(`SELECT * FROM import_source_bindings WHERE enterprise_key=? ORDER BY id`)
      .all(SOURCE_A.enterpriseKey);
    assert.deepEqual(bindings.map((b) => b.source_system), ["local-book", "other-book"],
      "同企业可以来自多个来源，但都指向同一账套");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_enterprise_account_sets WHERE enterprise_key=?`)
      .get(SOURCE_A.enterpriseKey).n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_enterprise_account_sets WHERE account_set_id=?`)
      .get(setId).n, 1);

    // 已登记来源证据后重试不再需要确认，同批回放幂等。
    const replay = IM.importIncremental({
      payload, batchId: "A-2026-03-other-src", source: other,
      mode: "append", accountSetId: setId, dryRun: false,
    });
    assert.equal(replay.status, IM.STATUS.REPLAY, JSON.stringify(replay.conflicts));
    assert.equal(replay.created.vouchersCreated, 0);
  });

  await test("追加到未绑定账套必须显式确认，且不能默认为任意企业可写", () => {
    const payload = {
      account_set: meta("合成乙公司"),
      vouchers: [journal("2026-01", "2026-01-15", 1, "未确认绑定", [
        { code: "5602", debit: 1000, credit: 0 }, { code: "1002", debit: 0, credit: 1000 },
      ])],
    };
    // 先用一个新来源系统（尚无任何绑定）验证「显式确认」这一关。
    const fresh = { system: "other-book", enterpriseKey: "91350000TEST0002Y" };
    const needConfirm = IM.importIncremental({
      payload, batchId: "B-noconfirm", source: fresh, mode: "append", accountSetId: setB,
    });
    assert.equal(needConfirm.status, IM.STATUS.CONFLICT);
    assert.ok(needConfirm.conflicts.some((c) => c.code === "account_set_binding_confirmation_required"),
      JSON.stringify(needConfirm.conflicts));

    const confirmed = IM.importIncremental({
      payload, batchId: "B-confirm", source: fresh, mode: "append", accountSetId: setB,
      confirmNewBinding: true, dryRun: false,
    });
    assert.equal(confirmed.status, IM.STATUS.APPLIED, JSON.stringify(confirmed.conflicts));
    assert.equal(confirmed.planned.bindingAction, "append_confirm");
    const binding = db.prepare(`SELECT * FROM import_source_bindings WHERE source_system='other-book' AND enterprise_key=?`)
      .get(SOURCE_B.enterpriseKey);
    assert.equal(binding.enterprise_key, SOURCE_B.enterpriseKey);
    assert.equal(binding.bound_by, "append_confirm");
    const canonical = db.prepare(`SELECT * FROM import_enterprise_account_sets WHERE enterprise_key=?`)
      .get(SOURCE_B.enterpriseKey);
    assert.equal(canonical.account_set_id, setB);

    // 账套已绑定 other-book 的来源企业后，另一个企业身份不能再写入。
    const otherEnterprise = IM.importIncremental({
      payload, batchId: "B-other-enterprise",
      source: { system: "other-book", enterpriseKey: "91350000TEST9999Q" },
      mode: "append", accountSetId: setB, confirmNewBinding: true,
    });
    assert.equal(otherEnterprise.status, IM.STATUS.CONFLICT);
    assert.ok(otherEnterprise.conflicts.some((c) => c.code === "account_set_bound_to_other_enterprise"),
      JSON.stringify(otherEnterprise.conflicts));

    // 该企业身份若已绑定别的账套，也不能再写入本账套。
    const crossSet = IM.importIncremental({
      payload: { account_set: meta("合成甲公司"), vouchers: [] },
      batchId: "B-cross-set", source: fresh, mode: "append", accountSetId: setId,
    });
    assert.equal(crossSet.status, IM.STATUS.CONFLICT);
    assert.ok(crossSet.conflicts.some((c) => c.code === "enterprise_bound_to_other_account_set"),
      JSON.stringify(crossSet.conflicts));
  });

  await test("同账套不得绑定另一企业；不同企业各自一个账套互不串账", () => {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_enterprise_account_sets`).get().n, 2);

    const cIntoA = IM.importIncremental({
      payload: payloadAppendFebA(), batchId: "C-into-A",
      source: { system: "local-book", enterpriseKey: SOURCE_C.enterpriseKey },
      mode: "append", accountSetId: setId, confirmNewBinding: true, dryRun: false,
    });
    assert.equal(cIntoA.status, IM.STATUS.CONFLICT, JSON.stringify(cIntoA.conflicts));
    assert.ok(cIntoA.conflicts.some((c) => c.code === "account_set_bound_to_other_enterprise"),
      JSON.stringify(cIntoA.conflicts));

    const bIntoA = IM.importIncremental({
      payload: payloadAppendFebA(), batchId: "B-into-A",
      source: { system: "local-book", enterpriseKey: SOURCE_B.enterpriseKey },
      mode: "append", accountSetId: setId, confirmNewBinding: true, dryRun: false,
    });
    assert.equal(bIntoA.status, IM.STATUS.CONFLICT, JSON.stringify(bIntoA.conflicts));
    assert.ok(bIntoA.conflicts.some((c) => c.code === "enterprise_bound_to_other_account_set"),
      JSON.stringify(bIntoA.conflicts));

    // 两家企业两个账套，凭证各归各的账套。
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setId).n, 5);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setB).n, 1);
  });

  await test("科目不兼容：与账套既有科目类别 / 方向冲突时拒绝", () => {
    const payload = {
      account_set: meta("合成乙公司"),
      accounts: [{ code: "1002", name: "银行存款", category: "负债", direction: "credit" }],
      vouchers: [],
    };
    const before = businessSnapshot();
    const r = IM.importIncremental({
      payload, batchId: "B-account-incompatible", source: SOURCE_B, mode: "append", accountSetId: setB,
      dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.CONFLICT);
    assert.ok(r.conflicts.some((c) => c.code === "account_incompatible"
      && c.accountCode === "1002" && c.field === "category"), JSON.stringify(r.conflicts));
    assert.deepEqual(businessSnapshot(), before);
  });

  await test("期初覆盖：追加时写入期初被拒绝", () => {
    const payload = {
      account_set: meta("合成乙公司"),
      opening_balances: [{ code: "1002", debit: 500, credit: 0 }, { code: "3001", debit: 0, credit: 500 }],
      vouchers: [],
    };
    const before = businessSnapshot();
    const r = IM.importIncremental({
      payload, batchId: "B-opening-overwrite", source: SOURCE_B, mode: "append", accountSetId: setB,
      dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.CONFLICT);
    assert.ok(r.conflicts.some((c) => c.code === "opening_rewrite_after_posting"), JSON.stringify(r.conflicts));
    assert.deepEqual(businessSnapshot(), before);
  });

  await test("已封账期间拒绝新增凭证；反结账后可正常追加", () => {
    // Set B 已有 2026-01 已过账凭证，可结账。LOCAL-02：本期有损益发生，封账前先结转本期损益。
    A.carryForwardProfit(setB, "2026-01");
    A.setPeriodStatus(setB, "2026-01", "closed");
    const payload = {
      account_set: meta("合成乙公司"),
      vouchers: [journal("2026-01", "2026-01-20", 5, "封账后补记", [
        { code: "5602", debit: 300, credit: 0 }, { code: "1002", debit: 0, credit: 300 },
      ], "SRC-B-CLOSED")],
    };
    const before = businessSnapshot();
    const blocked = IM.importIncremental({
      payload, batchId: "B-closed", source: SOURCE_B, mode: "append", accountSetId: setB, dryRun: false,
    });
    assert.equal(blocked.status, IM.STATUS.CONFLICT);
    assert.ok(blocked.conflicts.some((c) => c.code === "period_closed"), JSON.stringify(blocked.conflicts));
    assert.deepEqual(businessSnapshot(), before, "封账拒绝不得写入");

    A.setPeriodStatus(setB, "2026-01", "open");
    const reopened = IM.importIncremental({
      payload, batchId: "B-closed", source: SOURCE_B, mode: "append", accountSetId: setB, dryRun: false,
    });
    assert.equal(reopened.status, IM.STATUS.APPLIED, JSON.stringify(reopened.conflicts));
    assert.equal(reopened.created.vouchersCreated, 1);
  });

  await test("业务凭证字号冲突：既有凭证占用同一 期间+字号+号码 时拒绝", () => {
    const payload = {
      account_set: meta("合成乙公司"),
      vouchers: [journal("2026-01", "2026-01-21", 1, "字号冲突", [
        { code: "5602", debit: 111, credit: 0 }, { code: "1002", debit: 0, credit: 111 },
      ], "SRC-B-NUMBER-CLASH")],
    };
    const before = businessSnapshot();
    const r = IM.importIncremental({
      payload, batchId: "B-number-clash", source: SOURCE_B, mode: "append", accountSetId: setB, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.CONFLICT);
    assert.ok(r.conflicts.some((c) => c.code === "voucher_number_conflict"), JSON.stringify(r.conflicts));
    assert.deepEqual(businessSnapshot(), before);
  });

  await test("本批自身重复：同一来源凭证 ID / 同一凭证字号重复都被拒绝", () => {
    const dupSource = {
      account_set: meta("合成乙公司"),
      vouchers: [
        journal("2026-03", "2026-03-05", 1, "批内重复来源", [
          { code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 },
        ], "SRC-B-DUP"),
        journal("2026-03", "2026-03-06", 2, "批内重复来源", [
          { code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 },
        ], "SRC-B-DUP"),
      ],
    };
    const r1 = IM.importIncremental({
      payload: dupSource, batchId: "B-dup-source", source: SOURCE_B, mode: "append", accountSetId: setB,
    });
    assert.equal(r1.status, IM.STATUS.CONFLICT);
    assert.ok(r1.conflicts.some((c) => c.code === "source_voucher_duplicate_in_batch"), JSON.stringify(r1.conflicts));

    const dupNumber = {
      account_set: meta("合成乙公司"),
      vouchers: [
        journal("2026-03", "2026-03-05", 1, "批内重复字号 A", [
          { code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 },
        ], "SRC-B-N1"),
        journal("2026-03", "2026-03-06", 1, "批内重复字号 B", [
          { code: "5602", debit: 200, credit: 0 }, { code: "1002", debit: 0, credit: 200 },
        ], "SRC-B-N2"),
      ],
    };
    const r2 = IM.importIncremental({
      payload: dupNumber, batchId: "B-dup-number", source: SOURCE_B, mode: "append", accountSetId: setB,
    });
    assert.equal(r2.status, IM.STATUS.CONFLICT);
    assert.ok(r2.conflicts.some((c) => c.code === "voucher_number_duplicate_in_batch"), JSON.stringify(r2.conflicts));
  });

  await test("严格校验不降低：非法金额 / 非法日期在增量入口同样拒绝且不落库", () => {
    const badAmount = {
      account_set: meta("合成乙公司"),
      vouchers: [journal("2026-03", "2026-03-05", 9, "非法金额", [
        { code: "5602", debit: "abc", credit: 0 }, { code: "1002", debit: 0, credit: 100 },
      ], "SRC-B-BAD-AMOUNT")],
    };
    const before = fullSnapshot();
    const r1 = IM.importIncremental({
      payload: badAmount, batchId: "B-bad-amount", source: SOURCE_B, mode: "append", accountSetId: setB,
      dryRun: false,
    });
    assert.equal(r1.status, IM.STATUS.REJECTED);
    assert.ok(r1.errors.some((e) => e.includes("非法")), JSON.stringify(r1.errors));
    assert.deepEqual(fullSnapshot(), before);

    const badDate = {
      account_set: meta("合成乙公司"),
      vouchers: [journal("2026-03", "2026-02-30", 9, "非法日期", [
        { code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 },
      ], "SRC-B-BAD-DATE")],
    };
    const r2 = IM.importIncremental({
      payload: badDate, batchId: "B-bad-date", source: SOURCE_B, mode: "append", accountSetId: setB,
      dryRun: false,
    });
    assert.equal(r2.status, IM.STATUS.REJECTED);
    assert.ok(r2.errors.some((e) => e.includes("日期")), JSON.stringify(r2.errors));
    assert.deepEqual(fullSnapshot(), before);
  });

  await test("缺少稳定身份 / 批次 / 目标账套等参数一律拒绝并说明原因", () => {
    const cases = [
      [{ payload: payloadCreateA(), source: SOURCE_C }, "batchId"],
      [{ payload: payloadCreateA(), batchId: "x-1" }, "source"],
      [{ payload: payloadCreateA(), batchId: "x-2", source: { system: "local-book" } }, "enterpriseKey"],
      [{ payload: payloadCreateA(), batchId: "x-3", source: SOURCE_C, mode: "append" }, "accountSetId"],
      [{ payload: payloadCreateA(), batchId: "x-4", source: SOURCE_C, mode: "create", accountSetId: setId }, "不得提供 accountSetId"],
      [{ batchId: "x-5", source: SOURCE_C }, "payload"],
    ];
    const before = fullSnapshot();
    for (const [args, needle] of cases) {
      const r = IM.importIncremental(args);
      assert.equal(r.status, IM.STATUS.REJECTED, `${needle}: ${JSON.stringify(r.errors)}`);
      assert.ok(r.errors.join("\n").includes(needle), `${needle}: ${JSON.stringify(r.errors)}`);
    }
    assert.deepEqual(fullSnapshot(), before);
  });

  await test("目标账套不存在：抛出可诊断错误（不静默建账）", () => {
    let thrown = null;
    try {
      IM.importIncremental({
        payload: payloadAppendFebA(), batchId: "A-missing-set", source: SOURCE_A,
        mode: "append", accountSetId: 987654,
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.equal(thrown.code, "account_set_not_found");
  });

  await test("事务中途故障：全程回滚、原库业务状态不变、失败批次留审计且不吞错误", () => {
    // 故障注入：临时触发器让指定摘要的凭证插入失败（不加生产后门）。
    db.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON vouchers
             WHEN NEW.summary = '注入失败' BEGIN SELECT RAISE(ABORT, 'injected_voucher_failure'); END`);
    try {
      const payload = {
        account_set: meta("合成丙公司", { start_period: "2026-01" }),
        opening_balances: [{ code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 }],
        vouchers: [
          journal("2026-01", "2026-01-10", 1, "正常凭证", [
            { code: "5602", debit: 10, credit: 0 }, { code: "1002", debit: 0, credit: 10 },
          ], "SRC-C-OK"),
          journal("2026-01", "2026-01-11", 2, "注入失败", [
            { code: "5602", debit: 20, credit: 0 }, { code: "1002", debit: 0, credit: 20 },
          ], "SRC-C-FAIL"),
        ],
      };
      const before = businessSnapshot();
      const beforeSets = db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n;
      let thrown = null;
      try {
        IM.importIncremental({ payload, batchId: "C-failure", source: SOURCE_C, dryRun: false });
      } catch (e) { thrown = e; }
      assert.ok(thrown, "中途故障必须抛出，不能吞错当成功");
      assert.match(String(thrown.message), /injected_voucher_failure/);
      assert.deepEqual(businessSnapshot(), before, "回滚后业务状态必须完全不变");
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, beforeSets);
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_source_bindings WHERE source_system='local-book' AND enterprise_key=?`)
        .get(SOURCE_C.enterpriseKey).n, 0, "回滚必须连来源绑定一起撤销");
      const failed = IM.getImportBatch("C-failure");
      assert.equal(failed.batch.status, "failed");
      assert.equal(failed.batch.accountSetId, null);
      assert.match(String(failed.batch.errorCode) + String(failed.batch.result), /injected|ERR_/);
      assert.equal(failed.voucherCount, 0);

      // 故障移除后同一批次 ID 可以正常重试（内容未变 → 不是冲突）。
      db.exec(`DROP TRIGGER inject_failure`);
      const retry = IM.importIncremental({ payload, batchId: "C-failure", source: SOURCE_C, dryRun: false });
      assert.equal(retry.status, IM.STATUS.APPLIED, JSON.stringify(retry.conflicts));
      assert.equal(retry.created.vouchersCreated, 2);
      assert.equal(IM.getImportBatch("C-failure").batch.status, "completed");
    } finally {
      try { db.exec(`DROP TRIGGER inject_failure`); } catch { /* 已删除 */ }
    }
  });

  // ================================================================ 来源凭证状态核验（反过账 / 修改 / 删除）
  let setD = null;
  const batchD = "D-2026-01";
  await test("准备 Set D：来源凭证状态核验的合成账套", () => {
    const r = IM.importIncremental({
      payload: payloadCreateD(), batchId: batchD, source: SOURCE_D, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    setD = r.created.accountSetId;
    assert.ok(setD > 0);
    assert.equal(r.created.vouchersCreated, 2);
  });

  await test("本机反过账后：批次回放 / 去重不得伪报完成，已完成批次不被覆写", () => {
    const voucher = A.listVouchers(setD, { period: "2026-01" }).find((v) => v.number === 1);
    A.unpostVoucher(setD, voucher.id);
    const before = fullSnapshot();
    const r = IM.importIncremental({ payload: payloadCreateD(), batchId: batchD, source: SOURCE_D, dryRun: false });
    assert.equal(r.status, IM.STATUS.CONFLICT, JSON.stringify(r.conflicts));
    const c = r.conflicts.find((x) => x.code === "source_voucher_voucher_unposted");
    assert.ok(c, JSON.stringify(r.conflicts));
    assert.equal(c.voucherState, "unposted");
    assert.equal(c.registeredVoucherId, voucher.id);
    assert.deepEqual(fullSnapshot(), before, "状态核验冲突不得写入任何表");
    assert.equal(IM.getImportBatch(batchD).batch.status, "completed", "失败不得把已完成批次标记为 failed");
    assert.equal(IM.getImportBatch(batchD).sourceTrace.find((t) => t.sourceVoucherId === "SRC-D-1").state, "unposted");

    // 重新过账后恢复幂等回放（证明不是永久误报）。
    A.postVoucher(setD, voucher.id);
    const replay = IM.importIncremental({ payload: payloadCreateD(), batchId: batchD, source: SOURCE_D, dryRun: false });
    assert.equal(replay.status, IM.STATUS.REPLAY, JSON.stringify(replay.conflicts));
    assert.equal(replay.sourceTrace.every((t) => t.state === "ok"), true);
  });

  await test("本机修改凭证内容后：同批回放 / 跨批去重都给结构化冲突，不伪报完成", () => {
    const voucher = A.listVouchers(setD, { period: "2026-01" }).find((v) => v.number === 2);
    db.prepare(`UPDATE vouchers SET summary='人工改摘要' WHERE id=?`).run(voucher.id);

    const replay = IM.importIncremental({ payload: payloadCreateD(), batchId: batchD, source: SOURCE_D, dryRun: false });
    assert.equal(replay.status, IM.STATUS.CONFLICT, JSON.stringify(replay.conflicts));
    assert.ok(replay.conflicts.some((x) => x.code === "source_voucher_voucher_modified"),
      JSON.stringify(replay.conflicts));

    const cross = IM.importIncremental({
      payload: payloadAppendD(), batchId: "D-dup", source: SOURCE_D,
      mode: "append", accountSetId: setD, dryRun: false,
    });
    assert.equal(cross.status, IM.STATUS.CONFLICT, JSON.stringify(cross.conflicts));
    assert.ok(cross.conflicts.some((x) => x.code === "source_voucher_voucher_modified"),
      JSON.stringify(cross.conflicts));

    // 恢复原内容后再次回放成功（区分「合法修改」与「内容未变」）。
    db.prepare(`UPDATE vouchers SET summary='D2' WHERE id=?`).run(voucher.id);
    const ok = IM.importIncremental({ payload: payloadCreateD(), batchId: batchD, source: SOURCE_D, dryRun: false });
    assert.equal(ok.status, IM.STATUS.REPLAY, JSON.stringify(ok.conflicts));
  });

  await test("删除本机凭证后保留来源追踪：重试给结构化冲突，不静默重新入账", () => {
    const voucher = A.listVouchers(setD, { period: "2026-01" }).find((v) => v.number === 1);
    A.unpostVoucher(setD, voucher.id);
    A.deleteVoucher(setD, voucher.id);

    const trace = db.prepare(`SELECT * FROM import_voucher_sources
                              WHERE enterprise_key=? AND source_voucher_id='SRC-D-1'`).get(SOURCE_D.enterpriseKey);
    assert.ok(trace, "删除凭证后来源登记必须保留可追踪信息");
    assert.equal(trace.voucher_id, voucher.id, "删除后仍指向被删除的凭证 ID，供人工核对");

    const before = businessSnapshot();
    const r = IM.importIncremental({ payload: payloadCreateD(), batchId: batchD, source: SOURCE_D, dryRun: false });
    assert.equal(r.status, IM.STATUS.CONFLICT, JSON.stringify(r.conflicts));
    const c = r.conflicts.find((x) => x.code === "source_voucher_voucher_missing");
    assert.ok(c, JSON.stringify(r.conflicts));
    assert.equal(c.registeredVoucherId, voucher.id);
    assert.deepEqual(businessSnapshot(), before, "删除后重试不得静默重新入账");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setD).n, 1,
      "不得为已删除的来源凭证重新创建凭证");
    assert.equal(IM.getImportBatch(batchD).batch.status, "completed");
  });

  await test("已完成批次不被失败审计覆写（markBatchFailed 带状态保护）", () => {
    const before = IM.getImportBatch(batchD).batch;
    S.markBatchFailed(db, {
      batchId: batchD,
      sourceSystem: SOURCE_D.system,
      enterpriseKey: SOURCE_D.enterpriseKey,
      mode: "create",
      accountSetId: setD,
      contentFingerprint: before.contentFingerprint,
      errorCode: "injected_failure",
      errorMessage: "不允许覆写已完成批次",
    });
    const after = IM.getImportBatch(batchD).batch;
    assert.equal(after.status, "completed", "已完成批次必须保持 completed");
    assert.equal(after.errorCode, null);
    assert.equal(after.attempts, before.attempts);
  });

  await test("来源追踪查询：批次结果 + 逐张来源凭证可核对，未知批次明确报错", () => {
    const info = IM.getImportBatch("A-2026-02");
    assert.equal(info.batch.status, "completed");
    assert.equal(info.source.enterpriseKey, SOURCE_A.enterpriseKey);
    assert.equal(info.voucherCount, 2);
    for (const t of info.sourceTrace) {
      assert.equal(t.accountSetId, setId);
      assert.match(t.contentFingerprint, /^[a-f0-9]{64}$/);
      assert.ok(t.voucherId > 0);
    }
    let thrown = null;
    try { IM.getImportBatch("no-such-batch"); } catch (e) { thrown = e; }
    assert.equal(thrown?.code, "batch_not_found");
  });

  // ================================================================ 填空账套首次追加期初 + 同批重试（第二轮独审 P1-1）
  const SOURCE_EMPTY = { system: "local-book", enterpriseKey: "91350000TEST0005E", enterpriseName: "填空合成公司" };
  const SOURCE_EMPTY2 = { system: "local-book", enterpriseKey: "91350000TEST0005F", enterpriseName: "填空合成公司二" };
  const cashEntries = (amount) => [
    { code: "5602", debit: amount, credit: 0 },
    { code: "1002", debit: 0, credit: amount },
  ];
  const openingPayload = (name, vouchers = [], openings = [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }]) => ({
    account_set: meta(name),
    opening_balances: openings.map((o) => ({ ...o })),
    vouchers,
  });

  await test("填空题：account_set_create 新空账套 + append 确认绑定写期初（无凭证）→ applied；同批重试 idempotent_replay 且零写入", () => {
    // 等价于先调 account_set_create：空账套、无期初、无凭证、无企业绑定。
    const set = A.createAccountSet({
      name: "填空合成公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    assert.equal(A.getOpeningBalances(set.id).length, 0);
    assert.equal(A.listVouchers(set.id).length, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_enterprise_account_sets WHERE account_set_id=?`).get(set.id).n, 0);

    const args = {
      payload: openingPayload("填空合成公司"), batchId: "EMPTY-open-2026", source: SOURCE_EMPTY,
      mode: "append", accountSetId: set.id, confirmNewBinding: true, dryRun: false,
    };
    const first = IM.importIncremental(args);
    assert.equal(first.status, IM.STATUS.APPLIED, JSON.stringify(first.conflicts));
    assert.equal(first.created.openingBalancesApplied, 2);
    assert.equal(first.created.vouchersCreated, 0);
    assert.deepEqual(A.getOpeningBalances(set.id).map((o) => [o.code, o.debit, o.credit]),
      [["1002", 100, 0], ["3001", 0, 100]]);
    const binding = db.prepare(`SELECT * FROM import_enterprise_account_sets WHERE account_set_id=?`).get(set.id);
    assert.equal(binding.enterprise_key, SOURCE_EMPTY.enterpriseKey);

    const before = fullSnapshot();
    const retry = IM.importIncremental(args);
    assert.equal(retry.status, IM.STATUS.REPLAY, JSON.stringify(retry.conflicts));
    assert.equal(retry.replayed, true);
    assert.equal(retry.accountSetId, set.id);
    assert.equal(retry.created.openingBalancesApplied, 0);
    assert.equal(retry.created.vouchersCreated, 0);
    assert.deepEqual(fullSnapshot(), before, "同批重试不得写入任何表（含期初 / 批次 / 逐张关联）");
  });

  await test("填空题：空账套首调同时写期初 + 凭证，同批重试幂等；真正改期初 / 库内期初被改动仍被拒绝", () => {
    const set = A.createAccountSet({
      name: "填空合成公司二", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    const voucher = journal("2026-01", "2026-01-05", 1, "填空首张凭证", cashEntries(10), "EMPTY2-SRC-1");
    const args = {
      payload: openingPayload("填空合成公司二", [voucher]), batchId: "EMPTY2-open-2026", source: SOURCE_EMPTY2,
      mode: "append", accountSetId: set.id, confirmNewBinding: true, dryRun: false,
    };
    const first = IM.importIncremental(args);
    assert.equal(first.status, IM.STATUS.APPLIED, JSON.stringify(first.conflicts));
    assert.equal(first.created.openingBalancesApplied, 2);
    assert.equal(first.created.vouchersCreated, 1);

    const before = fullSnapshot();
    const retry = IM.importIncremental(args);
    assert.equal(retry.status, IM.STATUS.REPLAY, JSON.stringify(retry.conflicts));
    assert.deepEqual(fullSnapshot(), before, "含凭证的填空批次重试也不得写入");

    // 不豁免真正的期初覆盖：换一个批次改期初（账套已有已过账凭证）仍被拒绝。
    const overwrite = IM.importIncremental({
      ...args,
      payload: openingPayload("填空合成公司二", [voucher], [{ code: "1002", debit: 999, credit: 0 }, { code: "3001", debit: 0, credit: 999 }]),
      batchId: "EMPTY2-overwrite",
    });
    assert.equal(overwrite.status, IM.STATUS.CONFLICT, JSON.stringify(overwrite.conflicts));
    assert.ok(overwrite.conflicts.some((c) => c.code === "opening_balance_overwrite_refused" || c.code === "opening_rewrite_after_posting"),
      JSON.stringify(overwrite.conflicts));
    assert.deepEqual(A.getOpeningBalances(set.id).map((o) => [o.code, o.debit]), [["1002", 100], ["3001", 0]]);

    // 不豁免「库内实际期初已被改动」：回放前核验实际落库状态，不一致就拒绝只读回放。
    db.prepare(`UPDATE opening_balances SET debit=? WHERE account_set_id=? AND code='1002'`).run(777, set.id);
    const tampered = fullSnapshot();
    const replay = IM.importIncremental(args);
    assert.equal(replay.status, IM.STATUS.CONFLICT, JSON.stringify(replay.conflicts));
    const c = replay.conflicts.find((x) => x.code === "batch_replay_state_incomplete");
    assert.ok(c, JSON.stringify(replay.conflicts));
    assert.equal(c.reason, "opening_balances_mismatch");
    assert.deepEqual(c.mismatched.map((m) => m.code), ["1002"]);
    assert.deepEqual(fullSnapshot(), tampered, "回放不一致拒绝时不得改写库内数据");

    // 恢复一致后重新识别为幂等回放（证明不是永久误报）。
    db.prepare(`UPDATE opening_balances SET debit=? WHERE account_set_id=? AND code='1002'`).run(100, set.id);
    const ok = IM.importIncremental(args);
    assert.equal(ok.status, IM.STATUS.REPLAY, JSON.stringify(ok.conflicts));
  });

  // ================================================================ create 同批回放的期初核验（第三轮独审）
  const SOURCE_CREATE_OPEN = { system: "local-book", enterpriseKey: "91350000TEST0008K", enterpriseName: "首次建账期初合成公司" };
  const SOURCE_CREATE_OPEN_V = { system: "local-book", enterpriseKey: "91350000TEST0008L", enterpriseName: "首次建账期初凭证合成公司" };
  const SOURCE_CREATE_NOOPEN = { system: "local-book", enterpriseKey: "91350000TEST0008M", enterpriseName: "首次建账无期初合成公司" };
  const createOpenPayload = (name) => ({
    account_set: meta(name),
    opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
    vouchers: [],
  });

  await test("create 仅期初：合法 API 改期初后同批回放给结构化冲突；未改 / 恢复后仍幂等且零写入", () => {
    const args = {
      payload: createOpenPayload("首次建账期初合成公司"), batchId: "CREATE-open-2026",
      source: SOURCE_CREATE_OPEN, dryRun: false,
    };
    const first = IM.importIncremental(args);
    assert.equal(first.status, IM.STATUS.APPLIED, JSON.stringify(first.conflicts));
    assert.equal(first.created.accountSetCreated, true);
    assert.equal(first.created.openingBalancesApplied, 2);
    const setId = first.created.accountSetId;

    // 未改期初：同批回放仍是正例，且零写入。
    const before = fullSnapshot();
    const replay = IM.importIncremental(args);
    assert.equal(replay.status, IM.STATUS.REPLAY, JSON.stringify(replay.conflicts));
    assert.equal(replay.accountSetId, setId, "create 回放必须仍指向批次创建的账套");
    assert.deepEqual(fullSnapshot(), before, "未改期初的同批回放不得写入任何表");

    // 合法 API 改期初（空账套、无凭证，允许）：当前真实值已与批次导入值不同。
    A.setOpeningBalances(setId, [{ code: "1002", debit: 200, credit: 0 }, { code: "3001", debit: 0, credit: 200 }]);
    const changedSnapshot = fullSnapshot();
    const changed = IM.importIncremental(args);
    assert.equal(changed.status, IM.STATUS.CONFLICT, JSON.stringify(changed.conflicts));
    const c = changed.conflicts.find((x) => x.code === "batch_replay_state_incomplete");
    assert.ok(c, JSON.stringify(changed.conflicts));
    assert.equal(c.reason, "opening_balances_mismatch");
    assert.equal(c.accountSetId, setId);
    assert.deepEqual(c.mismatched.map((m) => m.code), ["1002", "3001"]);
    assert.deepEqual(fullSnapshot(), changedSnapshot, "期初不一致的 create 回放不得写入");

    // 恢复原值后重新识别为幂等回放（证明不是永久误报）。
    A.setOpeningBalances(setId, createOpenPayload("首次建账期初合成公司").opening_balances);
    const restored = IM.importIncremental(args);
    assert.equal(restored.status, IM.STATUS.REPLAY, JSON.stringify(restored.conflicts));
  });

  await test("create 含凭证：库内期初被改动后同批回放也拒绝；恢复后幂等", () => {
    const args = {
      payload: {
        account_set: meta("首次建账期初凭证合成公司"),
        opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
        vouchers: [journal("2026-01", "2026-01-05", 1, "create 期初凭证", cashEntries(10), "CREATE-OPEN-V-1")],
      },
      batchId: "CREATE-open-voucher-2026", source: SOURCE_CREATE_OPEN_V, dryRun: false,
    };
    const first = IM.importIncremental(args);
    assert.equal(first.status, IM.STATUS.APPLIED, JSON.stringify(first.conflicts));
    const setId = first.created.accountSetId;

    // 有已过账凭证时 A.setOpeningBalances 会拒绝，这里直接改库模拟「库内期初被改动」的不一致状态。
    db.prepare(`UPDATE opening_balances SET debit=? WHERE account_set_id=? AND code='1002'`).run(555, setId);
    const tampered = fullSnapshot();
    const replay = IM.importIncremental(args);
    assert.equal(replay.status, IM.STATUS.CONFLICT, JSON.stringify(replay.conflicts));
    const c = replay.conflicts.find((x) => x.code === "batch_replay_state_incomplete");
    assert.ok(c, JSON.stringify(replay.conflicts));
    assert.equal(c.reason, "opening_balances_mismatch");
    assert.deepEqual(c.mismatched.map((m) => m.code), ["1002"]);
    assert.deepEqual(fullSnapshot(), tampered, "不一致拒绝时不得改写库内数据");

    db.prepare(`UPDATE opening_balances SET debit=? WHERE account_set_id=? AND code='1002'`).run(100, setId);
    const ok = IM.importIncremental(args);
    assert.equal(ok.status, IM.STATUS.REPLAY, JSON.stringify(ok.conflicts));
  });

  await test("create 无期初批次：后续合法写入期初不被凭空当作本批快照，同批回放仍幂等", () => {
    const args = {
      payload: { account_set: meta("首次建账无期初合成公司"), vouchers: [] },
      batchId: "CREATE-noopening-2026", source: SOURCE_CREATE_NOOPEN, dryRun: false,
    };
    const first = IM.importIncremental(args);
    assert.equal(first.status, IM.STATUS.APPLIED, JSON.stringify(first.conflicts));
    const setId = first.created.accountSetId;

    // 本批从未导入期初字段：后期合法写入期初不能要求与本批「快照」一致。
    A.setOpeningBalances(setId, [{ code: "1002", debit: 300, credit: 0 }, { code: "3001", debit: 0, credit: 300 }]);
    const replay = IM.importIncremental(args);
    assert.equal(replay.status, IM.STATUS.REPLAY, JSON.stringify(replay.conflicts));
  });

  // ================================================================ 自动取号与显式编号混用（第二轮独审 P1-2）
  const SOURCE_AUTO1 = { system: "local-book", enterpriseKey: "91350000TEST0006F", enterpriseName: "自动取号合成公司" };
  let autoSetId = null;

  await test("自动取号 + 显式编号混用（自动在前）：预检即预分配唯一号码，正式落库不产生同字号重号", () => {
    const payload = {
      account_set: meta("自动取号合成公司"),
      vouchers: [
        journal("2026-01", "2026-01-05", undefined, "自动取号", cashEntries(10), "AUTO-1"),
        journal("2026-01", "2026-01-06", 1, "显式取号", cashEntries(20), "EXPLICIT-1"),
      ],
    };
    const preview = IM.importIncremental({ payload, batchId: "AUTO-preview", source: SOURCE_AUTO1 });
    assert.equal(preview.status, IM.STATUS.PREVIEW, JSON.stringify(preview.errors));
    const plan = new Map(preview.planned.voucherNumbers.map((n) => [n.sourceVoucherId, n]));
    assert.equal(plan.get("EXPLICIT-1").number, 1, "显式编号原样保留");
    assert.equal(plan.get("AUTO-1").number, 2, "自动取号必须跳过本批显式号");
    assert.equal(plan.get("AUTO-1").autoNumbered, true);

    const applied = IM.importIncremental({ payload, batchId: "AUTO-batch", source: SOURCE_AUTO1, dryRun: false });
    assert.equal(applied.status, IM.STATUS.APPLIED, JSON.stringify(applied.conflicts));
    assert.equal(applied.created.vouchersCreated, 2);
    autoSetId = applied.created.accountSetId;

    // 独立真实 db 断言：落库号码与预检计划一致，且账套内不存在任何重复字号。
    const persisted = db.prepare(
      `SELECT s.source_voucher_id AS sid, v.number AS number
         FROM import_voucher_sources s JOIN vouchers v ON v.id = s.voucher_id
        WHERE s.account_set_id=? ORDER BY v.number`,
    ).all(autoSetId);
    assert.deepEqual(persisted.map((r) => [r.sid, r.number]), [["EXPLICIT-1", 1], ["AUTO-1", 2]]);
    assert.deepEqual(
      db.prepare(`SELECT period, word, number, COUNT(*) n FROM vouchers WHERE account_set_id=?
                   GROUP BY period, word, number HAVING n > 1`).all(autoSetId),
      [],
      "不得存在同期间同字号同号码的两张凭证",
    );
  });

  await test("自动取号反序（显式在前）与多个自动 / 不同字期间：仍然唯一且可预测", () => {
    const cases = [
      {
        key: "91350000TEST0006G", name: "自动取号反序公司",
        vouchers: [
          journal("2026-01", "2026-01-06", 1, "显式在前", cashEntries(20), "REV-EXPLICIT-1"),
          journal("2026-01", "2026-01-05", undefined, "自动在后", cashEntries(10), "REV-AUTO"),
        ],
        expected: [["REV-EXPLICIT-1", 1], ["REV-AUTO", 2]],
      },
      {
        key: "91350000TEST0006H", name: "多自动号公司",
        vouchers: [
          journal("2026-01", "2026-01-05", undefined, "自动一", cashEntries(10), "MANY-A"),
          journal("2026-01", "2026-01-06", undefined, "自动二", cashEntries(20), "MANY-B"),
          journal("2026-01", "2026-01-07", undefined, "自动三", cashEntries(30), "MANY-C"),
        ],
        expected: [["MANY-A", 1], ["MANY-B", 2], ["MANY-C", 3]],
      },
      {
        key: "91350000TEST0006J", name: "不同字期间公司",
        vouchers: [
          journal("2026-01", "2026-01-05", undefined, "记字自动", cashEntries(10), "MIX-JI"),
          { ...journal("2026-01", "2026-01-06", 1, "转字显式", cashEntries(20), "MIX-ZHUAN-1"), word: "转" },
          { ...journal("2026-01", "2026-01-07", undefined, "转字自动", cashEntries(30), "MIX-ZHUAN-AUTO"), word: "转" },
          journal("2026-02", "2026-02-05", undefined, "二月自动", cashEntries(40), "MIX-FEB"),
        ],
        // 2026-01/记 与 2026-02/记 各自独立；2026-01/转 的自动号跳过本组显式 1 → 2。
        expected: [["MIX-JI", 1], ["MIX-ZHUAN-1", 1], ["MIX-ZHUAN-AUTO", 2], ["MIX-FEB", 1]],
      },
    ];
    for (const c of cases) {
      const source = { system: "local-book", enterpriseKey: c.key, enterpriseName: c.name };
      const payload = { account_set: meta(c.name), vouchers: c.vouchers };
      const applied = IM.importIncremental({ payload, batchId: `${c.key}-batch`, source, dryRun: false });
      assert.equal(applied.status, IM.STATUS.APPLIED, `${c.name}: ${JSON.stringify(applied.conflicts)}`);
      const setId = applied.created.accountSetId;
      const persisted = db.prepare(
        `SELECT s.source_voucher_id AS sid, v.number AS number
           FROM import_voucher_sources s JOIN vouchers v ON v.id = s.voucher_id
          WHERE s.account_set_id=? ORDER BY s.id`,
      ).all(setId);
      assert.deepEqual(persisted.map((r) => [r.sid, r.number]), c.expected, c.name);
      assert.deepEqual(
        db.prepare(`SELECT period, word, number, COUNT(*) n FROM vouchers WHERE account_set_id=?
                     GROUP BY period, word, number HAVING n > 1`).all(setId),
        [],
        `${c.name}：不得重号`,
      );
    }
  });

  await test("追加时自动取号跳过既有号与本批显式号（不同期间独立）", () => {
    const payload = {
      account_set: meta("自动取号合成公司"),
      vouchers: [
        journal("2026-01", "2026-01-09", undefined, "续号自动", cashEntries(30), "AUTO-2"),
        journal("2026-01", "2026-01-10", 10, "显式跳号", cashEntries(40), "EXPLICIT-10"),
        journal("2026-02", "2026-02-01", 1, "另一期间显式", cashEntries(50), "EXPLICIT-FEB-1"),
        journal("2026-02", "2026-02-02", undefined, "另一期间自动", cashEntries(60), "AUTO-FEB"),
      ],
    };
    const preview = IM.importIncremental({ payload, batchId: "AUTO-append-preview", source: SOURCE_AUTO1, mode: "append", accountSetId: autoSetId });
    assert.equal(preview.status, IM.STATUS.PREVIEW, JSON.stringify(preview.conflicts));
    const plan = new Map(preview.planned.voucherNumbers.map((n) => [n.sourceVoucherId, n.number]));
    assert.equal(plan.get("AUTO-2"), 3, "既有 1/2 之后续号，且跳过本批显式 10");
    assert.equal(plan.get("EXPLICIT-10"), 10);
    assert.equal(plan.get("EXPLICIT-FEB-1"), 1);
    assert.equal(plan.get("AUTO-FEB"), 2, "另一期间自动号跳过本批该期间显式 1");

    const applied = IM.importIncremental({ payload, batchId: "AUTO-append", source: SOURCE_AUTO1, mode: "append", accountSetId: autoSetId, dryRun: false });
    assert.equal(applied.status, IM.STATUS.APPLIED, JSON.stringify(applied.conflicts));
    const janNumbers = A.listVouchers(autoSetId, { period: "2026-01" }).map((v) => `${v.word}-${v.number}`).sort();
    assert.deepEqual(janNumbers, ["记-1", "记-10", "记-2", "记-3"]);
    const febNumbers = A.listVouchers(autoSetId, { period: "2026-02" }).map((v) => v.number).sort((a, b) => a - b);
    assert.deepEqual(febNumbers, [1, 2]);
    assert.deepEqual(
      db.prepare(`SELECT period, word, number, COUNT(*) n FROM vouchers WHERE account_set_id=?
                   GROUP BY period, word, number HAVING n > 1`).all(autoSetId),
      [],
    );
  });

  await test("自动取号批次事务失败回滚后重试：号码计划可复用且不重号", () => {
    const source = { system: "local-book", enterpriseKey: "91350000TEST0006K", enterpriseName: "自动取号失败合成公司" };
    const payload = {
      account_set: meta("自动取号失败合成公司"),
      vouchers: [
        journal("2026-01", "2026-01-05", undefined, "自动一", cashEntries(10), "FAIL-AUTO-1"),
        journal("2026-01", "2026-01-06", undefined, "注入自动失败", cashEntries(20), "FAIL-AUTO-2"),
      ],
    };
    db.exec(`CREATE TRIGGER inject_auto_failure BEFORE INSERT ON vouchers
             WHEN NEW.summary = '注入自动失败' BEGIN SELECT RAISE(ABORT, 'injected_auto_failure'); END`);
    try {
      const before = businessSnapshot();
      let thrown = null;
      try { IM.importIncremental({ payload, batchId: "FAIL-AUTO", source, dryRun: false }); } catch (e) { thrown = e; }
      assert.ok(thrown, "中途故障必须抛出");
      assert.match(String(thrown.message), /injected_auto_failure/);
      assert.deepEqual(businessSnapshot(), before, "回滚后业务状态完全不变（含已插入的第一张）");
      const failedBatch = IM.getImportBatch("FAIL-AUTO");
      assert.equal(failedBatch.batch.status, "failed");
      assert.equal(failedBatch.voucherCount, 0, "失败批次不得残留逐张关联");
    } finally {
      try { db.exec(`DROP TRIGGER inject_auto_failure`); } catch { /* 已删除 */ }
    }
    const retry = IM.importIncremental({ payload, batchId: "FAIL-AUTO", source, dryRun: false });
    assert.equal(retry.status, IM.STATUS.APPLIED, JSON.stringify(retry.conflicts));
    const setId = retry.created.accountSetId;
    const numbers = A.listVouchers(setId, { period: "2026-01" }).map((v) => v.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2]);
    assert.equal(new Set(numbers).size, numbers.length, "重试后不得重号");
  });

  // ================================================================ 跨批去重逐张批次追踪（第二轮独审 P2-3）
  const SOURCE_TRACK = { system: "local-book", enterpriseKey: "91350000TEST0007G", enterpriseName: "跨批追踪合成公司" };
  const trackV1 = () => journal("2026-01", "2026-01-05", 1, "V1 原始", cashEntries(10), "V1");
  const trackV2 = (amount = 20) => journal("2026-01", "2026-01-06", 2, "V2 新增", cashEntries(amount), "V2");
  let setTrack = null;
  let trackV1VoucherId = null;

  await test("准备跨批追踪：trace-A 创建 V1", () => {
    const r = IM.importIncremental({
      payload: { account_set: meta("跨批追踪合成公司"), vouchers: [trackV1()] },
      batchId: "trace-A", source: SOURCE_TRACK, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    setTrack = r.created.accountSetId;
    trackV1VoucherId = r.sourceTrace[0].voucherId;
    assert.ok(setTrack > 0 && trackV1VoucherId > 0);
    // 首调 applied 与批次查询必须是同一份逐张 DTO（含 action / status / state 全部字段）。
    assert.equal(r.sourceTrace[0].action, "created");
    assert.deepEqual(r.sourceTrace, IM.getImportBatch("trace-A").sourceTrace,
      "新建批次首调与查询的逐张 DTO 必须一致");
  });

  await test("跨批去重保留逐张批次追踪：trace-B 首调 applied + deduplicated，查询与回放看到同一份关联", () => {
    const args = {
      payload: { account_set: meta("跨批追踪合成公司"), vouchers: [trackV1()] },
      batchId: "trace-B", source: SOURCE_TRACK, mode: "append", accountSetId: setTrack, dryRun: false,
    };
    const first = IM.importIncremental(args);
    assert.equal(first.status, IM.STATUS.APPLIED, JSON.stringify(first.conflicts));
    assert.equal(first.created.vouchersCreated, 0);
    assert.equal(first.created.vouchersDeduplicated, 1);
    assert.equal(first.sourceTrace.length, 1);
    assert.equal(first.sourceTrace[0].status, "deduplicated");
    assert.equal(first.sourceTrace[0].action, "deduplicated");

    // 查询：批次追踪不能因为「本批没新建凭证」就变成空。
    const queried = IM.getImportBatch("trace-B");
    assert.equal(queried.voucherCount, 1, "去重批次也必须能查到逐张来源凭证");
    assert.equal(queried.sourceTrace.length, 1);
    const t = queried.sourceTrace[0];
    assert.equal(t.sourceVoucherId, "V1");
    assert.equal(t.status, "deduplicated");
    assert.equal(t.action, "deduplicated");
    assert.equal(t.state, "ok");
    assert.equal(t.voucherId, trackV1VoucherId, "必须指向既有来源凭证，而不是伪造第二张");
    assert.equal(t.accountSetId, setTrack);
    assert.deepEqual(first.sourceTrace, queried.sourceTrace,
      "纯去重批次首调 applied 与查询的逐张 DTO 必须一致（含 action / state）");

    // 不伪造第二个来源 / 第二张凭证；关联表按批次留痕且作用域与批次一致。
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_voucher_sources
                              WHERE source_system=? AND enterprise_key=? AND source_voucher_id='V1'`)
      .get(SOURCE_TRACK.system, SOURCE_TRACK.enterpriseKey).n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setTrack).n, 1);
    const link = db.prepare(`SELECT * FROM import_batch_vouchers WHERE batch_id='trace-B'`).get();
    assert.equal(link.source_system, SOURCE_TRACK.system);
    assert.equal(link.enterprise_key, SOURCE_TRACK.enterpriseKey);
    assert.equal(link.account_set_id, setTrack);
    assert.equal(link.voucher_id, trackV1VoucherId);
    assert.match(link.content_fingerprint, /^[a-f0-9]{64}$/);

    // 同批回放：trace 与查询一致，且零写入。
    const before = fullSnapshot();
    const replay = IM.importIncremental(args);
    assert.equal(replay.status, IM.STATUS.REPLAY, JSON.stringify(replay.conflicts));
    assert.deepEqual(replay.sourceTrace, queried.sourceTrace, "回放与查询必须是同一份逐张关联");
    assert.deepEqual(fullSnapshot(), before, "同批回放不得写入");
  });

  await test("混合新增 + 去重：trace-C 逐张动作分别留痕，统计与 trace 一致", () => {
    const r = IM.importIncremental({
      payload: { account_set: meta("跨批追踪合成公司"), vouchers: [trackV1(), trackV2()] },
      batchId: "trace-C", source: SOURCE_TRACK, mode: "append", accountSetId: setTrack, dryRun: false,
    });
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    assert.equal(r.created.vouchersCreated, 1);
    assert.equal(r.created.vouchersDeduplicated, 1);
    assert.equal(r.sourceTrace.find((x) => x.sourceVoucherId === "V1").status, "deduplicated");
    assert.equal(r.sourceTrace.find((x) => x.sourceVoucherId === "V2").status, "created");

    const queried = IM.getImportBatch("trace-C");
    assert.equal(queried.voucherCount, 2);
    assert.deepEqual(queried.sourceTrace.map((x) => [x.sourceVoucherId, x.status]),
      [["V1", "deduplicated"], ["V2", "created"]]);
    assert.deepEqual(r.sourceTrace, queried.sourceTrace,
      "混合批次首调 applied 与查询的逐张 DTO 必须一致（含 action / state）");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setTrack).n, 2,
      "去重命中不得新增第二张凭证");
    const replay = IM.importIncremental({
      payload: { account_set: meta("跨批追踪合成公司"), vouchers: [trackV1(), trackV2()] },
      batchId: "trace-C", source: SOURCE_TRACK, mode: "append", accountSetId: setTrack, dryRun: false,
    });
    assert.equal(replay.status, IM.STATUS.REPLAY, JSON.stringify(replay.conflicts));
    assert.deepEqual(replay.sourceTrace, queried.sourceTrace);
  });

  await test("纯去重批次：trace-D 首调 applied 且查询不是 voucherCount 0", () => {
    const args = {
      payload: { account_set: meta("跨批追踪合成公司"), vouchers: [trackV1(), trackV2()] },
      batchId: "trace-D", source: SOURCE_TRACK, mode: "append", accountSetId: setTrack, dryRun: false,
    };
    const r = IM.importIncremental(args);
    assert.equal(r.status, IM.STATUS.APPLIED, JSON.stringify(r.conflicts));
    assert.equal(r.created.vouchersCreated, 0);
    assert.equal(r.created.vouchersDeduplicated, 2);
    assert.equal(r.sourceTrace.length, 2);

    const queried = IM.getImportBatch("trace-D");
    assert.equal(queried.voucherCount, 2, "纯去重批次也必须保留逐张追踪");
    assert.deepEqual(r.sourceTrace, queried.sourceTrace,
      "纯去重批次首调 applied 与查询的逐张 DTO 必须一致（含 action / state）");
    assert.deepEqual(queried.sourceTrace.map((x) => x.action), ["deduplicated", "deduplicated"]);
    assert.deepEqual(queried.sourceTrace.map((x) => x.voucherId).sort((a, b) => a - b).length, 2);
    const replay = IM.importIncremental(args);
    assert.equal(replay.status, IM.STATUS.REPLAY);
    assert.deepEqual(replay.sourceTrace, queried.sourceTrace);
  });

  await test("逐张追踪的失败原子性：trace-E 混入失败的新增凭证后整批回滚，重试才留痕", () => {
    const failing = journal("2026-01", "2026-01-07", 3, "注入追踪失败", cashEntries(30), "V3");
    const args = {
      payload: { account_set: meta("跨批追踪合成公司"), vouchers: [trackV1(), failing] },
      batchId: "trace-E", source: SOURCE_TRACK, mode: "append", accountSetId: setTrack, dryRun: false,
    };
    db.exec(`CREATE TRIGGER inject_track_failure BEFORE INSERT ON vouchers
             WHEN NEW.summary = '注入追踪失败' BEGIN SELECT RAISE(ABORT, 'injected_track_failure'); END`);
    try {
      const before = businessSnapshot();
      let thrown = null;
      try { IM.importIncremental(args); } catch (e) { thrown = e; }
      assert.ok(thrown, "中途故障必须抛出");
      assert.deepEqual(businessSnapshot(), before, "回滚后业务状态不得部分残留");
      const failedBatch = IM.getImportBatch("trace-E");
      assert.equal(failedBatch.batch.status, "failed");
      assert.equal(failedBatch.voucherCount, 0, "失败批次不得残留去重命中的关联");
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_batch_vouchers WHERE batch_id='trace-E'`).get().n, 0);
    } finally {
      try { db.exec(`DROP TRIGGER inject_track_failure`); } catch { /* 已删除 */ }
    }

    const retry = IM.importIncremental(args);
    assert.equal(retry.status, IM.STATUS.APPLIED, JSON.stringify(retry.conflicts));
    assert.equal(retry.created.vouchersCreated, 1);
    assert.equal(retry.created.vouchersDeduplicated, 1);
    const queried = IM.getImportBatch("trace-E");
    assert.equal(queried.batch.status, "completed");
    assert.equal(queried.voucherCount, 2);
    assert.deepEqual(queried.sourceTrace.map((x) => [x.sourceVoucherId, x.action]),
      [["V1", "deduplicated"], ["V3", "created"]]);
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e);
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* ignore */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
