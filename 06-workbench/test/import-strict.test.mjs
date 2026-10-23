#!/usr/bin/env node
// Fixed synthetic test identities, independent of display names and production defaults.
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-import-strict-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
const identityFixtureImport = (A, payload, options = {}) => A.importAccountSet(payload, { enterprise: identityFixture(), ...options });
const identityFixtureValidate = (A, payload, options = {}) => A.validateImportPayload(payload, { enterprise: identityFixture(), ...options });
/**
 * IMPORT-STRICT 导入严格校验回归：独立临时库，直接调用领域函数。
 * 覆盖：JSON/CSV 非法金额（垃圾文本、部分可解析、NaN/Infinity、超界）、合法金额与空白策略、
 * 日期/期间约束、科目/期初/凭证会计约束、预检与正式写入同一套约束、失败不落库、事务回滚。
 * 运行：node test/import-strict.test.mjs（在 06-workbench 目录）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const dataDir = mkdtempSync(join(tmpdir(), "wb-import-"));
process.env.WORKBENCH_DATA_DIR = dataDir;

let db, A;
const results = [];
const test = (name, fn) => {
  try { fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};

// 完整内容快照：不只比行数，而是比相关业务表全部行的内容，证明既有记录未被污染。
const snapshot = () => ({
  account_sets: db.prepare(`SELECT * FROM account_sets ORDER BY id`).all(),
  accounts: db.prepare(`SELECT * FROM accounts ORDER BY id`).all(),
  opening_balances: db.prepare(`SELECT * FROM opening_balances ORDER BY account_set_id, code`).all(),
  periods: db.prepare(`SELECT * FROM periods ORDER BY account_set_id, period`).all(),
  vouchers: db.prepare(`SELECT * FROM vouchers ORDER BY id`).all(),
  voucher_entries: db.prepare(`SELECT * FROM voucher_entries ORDER BY id`).all(),
});

const metaText = (name = "严格测试公司") =>
  `键,值\n账套名称,${name}\n纳税人性质,小规模纳税人\n会计准则,小企业会计准则\n启用期间,2026-01\n`;
const GOOD_ACCOUNTS = "科目编码,科目名称,类别,方向\n6602,管理费用,损益,借\n";
const GOOD_OPENINGS = "科目编码,借方,贷方\n1002,1000,0\n3001,0,1000\n";
const GOOD_VOUCHERS = "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
  + "2026-01,2026-01-10,记,1,报销办公费,6602,100,0\n"
  + "2026-01,2026-01-10,记,1,报销办公费,1002,0,100\n";
const texts = (over = {}) => ({
  meta: metaText(), accounts: GOOD_ACCOUNTS, openings: GOOD_OPENINGS, vouchers: GOOD_VOUCHERS, ...over,
});

/** 同一失败输入：dryRun 与正式导入都必须失败，且库中无任何新增/污染。 */
const assertNoWrite = (label, payload) => {
  const before = snapshot();
  const dry = identityFixtureImport(A, payload, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.validation.ok, false, `${label}: dryRun 必须失败`);
  assert.equal(dry.created, null, `${label}: dryRun 不得返回 created`);
  const formal = identityFixtureImport(A, payload, { dryRun: false });
  assert.equal(formal.validation.ok, false, `${label}: 正式导入必须失败`);
  assert.equal(formal.created, null, `${label}: 正式导入不得返回 created`);
  assert.deepEqual(snapshot(), before, `${label}: 失败输入不得写入任何账套/科目/期初/凭证/期间`);
};

try {
  ({ db } = await import("../server/db.mjs"));
  A = await import("../server/accounting.mjs");

  console.log("\nIMPORT-STRICT 导入严格校验回归测试\n");

  // ---------- 1. 金额文本解析：合法 / 非法 / 空白 ----------
  await test("金额：合法文本（千分位/货币符/空白/四舍五入/上限）", () => {
    assert.equal(A.parseImportAmount("1000").value, 1000);
    assert.equal(A.parseImportAmount("1,000.50").value, 1000.5);
    assert.equal(A.parseImportAmount("¥2,000").value, 2000);
    assert.equal(A.parseImportAmount("￥1,234.5").value, 1234.5);
    assert.equal(A.parseImportAmount("  50  ").value, 50);
    assert.equal(A.parseImportAmount("").value, 0);
    assert.equal(A.parseImportAmount(undefined).value, 0);
    assert.equal(A.parseImportAmount(null).value, 0);
    assert.equal(A.parseImportAmount(123.456).value, 123.46);
    assert.equal(A.parseImportAmount(1000).value, 1000);
    assert.equal(A.parseImportAmount("999999999999.99").value, 999999999999.99);
  });

  await test("金额：垃圾/部分可解析/NaN/Infinity/超界一律拒绝，不归 0", () => {
    for (const bad of ["abc", "100元", "12abc", "1.2.3", "1 000", "NaN", "Infinity", "1,00", "1e3", "¥", "--1"]) {
      const r = A.parseImportAmount(bad);
      assert.equal(r.ok, false, `${bad} 应被拒绝`);
      assert.match(r.error, /金额/);
    }
    for (const bad of [NaN, Infinity, -Infinity, 1e12, -1e12]) {
      assert.equal(A.parseImportAmount(bad).ok, false, `${bad} 应被拒绝`);
    }
    assert.equal(A.parseImportAmount("1000000000000").ok, false, "文本超界应被拒绝");
  });

  // ---------- 2. CSV 非法金额：预检与正式导入都失败且不落库 ----------
  const badAmounts = [
    ["垃圾文本", "abc"], ["部分可解析", "100元"], ["拼接数字", "12abc"],
    ["NaN 文本", "NaN"], ["Infinity 文本", "Infinity"], ["多个小数点", "1.2.3"],
    ["内部空白", "1 000"], ["超界", "1000000000000"],
  ];
  for (const [label, bad] of badAmounts) {
    test(`CSV 期初非法金额（${label}）dryRun/正式均失败且不落库`, () => {
      const payload = A.parseImportTexts(texts({ openings: `科目编码,借方,贷方\n1002,${bad},0\n3001,0,1000\n` }));
      assert.equal(typeof payload.opening_balances[0].debit, "string", "解析阶段必须保留原始文本，不得先归 0");
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => e.includes("期初余额第 1 行") && e.includes("借方金额非法")), JSON.stringify(v.errors));
      assertNoWrite(`期初-${label}`, payload);
    });
  }

  await test("CSV 凭证非法金额 dryRun/正式均失败且不落库", () => {
    const payload = A.parseImportTexts(texts({
      vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
        + "2026-01,2026-01-10,记,1,测试,6602,abc,0\n"
        + "2026-01,2026-01-10,记,1,测试,1002,0,100\n",
    }));
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("凭证第 1 张") && e.includes("第 1 行") && e.includes("借方金额非法")), JSON.stringify(v.errors));
    assertNoWrite("凭证-垃圾金额", payload);
  });

  // ---------- 3. JSON 非法数值（含 number 型 NaN/Infinity/超界） ----------
  const jsonPayload = (debit) => ({
    account_set: { name: "JSON严格测试", start_period: "2026-01" },
    opening_balances: [{ code: "1002", debit, credit: 0 }, { code: "3001", debit: 0, credit: 1000 }],
  });
  for (const [label, bad] of [["NaN", NaN], ["Infinity", Infinity], ["垃圾文本", "abc"],
    ["部分可解析", "10.5万"], ["超界 number", 1e12], ["超界文本", "1000000000000"]]) {
    test(`JSON 期初非法金额（${label}）dryRun/正式均失败且不落库`, () => {
      const payload = jsonPayload(bad);
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => e.includes("期初余额第 1 行") && e.includes("借方金额非法")), JSON.stringify(v.errors));
      assertNoWrite(`JSON-${label}`, payload);
    });
  }

  await test("JSON 凭证非法金额（number 型 NaN/Infinity/垃圾/超界）dryRun/正式均失败且不落库", () => {
    const mk = (debit) => ({
      account_set: { name: "JSON凭证测试", start_period: "2026-01" },
      accounts: [{ code: "6602", name: "管理费用", category: "损益", direction: "debit" }],
      vouchers: [{ period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "测试",
        entries: [{ code: "6602", debit, credit: 0 }, { code: "1002", debit: 0, credit: 100 }] }],
    });
    for (const [label, bad] of [["NaN", NaN], ["Infinity", Infinity], ["垃圾文本", "abc"], ["超界", "1000000000000"]]) {
      const payload = mk(bad);
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false, `${label} 应失败`);
      assert.ok(v.errors.some((e) => e.includes("凭证第 1 张") && e.includes("借方金额非法")), `${label}: ${JSON.stringify(v.errors)}`);
      assertNoWrite(`JSON凭证-${label}`, payload);
    }
  });

  // ---------- 4. 空白/缺失值策略 ----------
  await test("空白/缺失金额按 0 处理：合法空期初与 JSON 缺字段", () => {
    const payload = A.parseImportTexts(texts({ openings: "科目编码,借方,贷方\n1002,1000,\n3001,,1000\n" }));
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const json = { account_set: { name: "缺字段测试", start_period: "2026-01" },
      opening_balances: [{ code: "1002", debit: 1000 }, { code: "3001", credit: 1000 }] };
    assert.equal(identityFixtureValidate(A, json).ok, true);
  });

  await test("空白金额按 0：凭证整行 0 金额被拒绝", () => {
    const payload = A.parseImportTexts(texts({
      vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
        + "2026-01,2026-01-10,记,1,测试,6602,,0\n"
        + "2026-01,2026-01-10,记,1,测试,1002,0,100\n",
    }));
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("金额不能为 0")), JSON.stringify(v.errors));
    assertNoWrite("凭证-零金额", payload);
  });

  // ---------- 5. 日期 / 期间约束 ----------
  await test("期间：启用期间月份非法/格式非法被拒绝", () => {
    assertNoWrite("启用-13月", A.parseImportTexts(texts({ meta: metaText().replace("2026-01", "2026-13") })));
    assertNoWrite("启用-单数字", A.parseImportTexts(texts({ meta: metaText().replace("2026-01", "2026-1") })));
  });

  await test("期间：凭证月份非法/早于启用期间被拒绝", () => {
    const badMonth = A.parseImportTexts(texts({
      vouchers: GOOD_VOUCHERS.replaceAll("2026-01,2026-01-10", "2026-13,2026-13-10"),
    }));
    const v1 = identityFixtureValidate(A, badMonth);
    assert.ok(v1.errors.some((e) => e.includes("期间非法")), JSON.stringify(v1.errors));
    assertNoWrite("凭证-13月", badMonth);

    const beforeStart = A.parseImportTexts(texts({
      vouchers: GOOD_VOUCHERS.replaceAll("2026-01,2026-01-10", "2025-12,2025-12-10"),
    }));
    const v2 = identityFixtureValidate(A, beforeStart);
    assert.ok(v2.errors.some((e) => e.includes("不得早于启用期间")), JSON.stringify(v2.errors));
    assertNoWrite("凭证-早于启用", beforeStart);
  });

  await test("日期：格式非法/非真实日历日被拒绝", () => {
    for (const [label, badDate] of [["斜杠", "2026/01/10"], ["点号", "2026.01.10"], ["不存在的日期", "2026-02-30"]]) {
      const payload = A.parseImportTexts(texts({ vouchers: GOOD_VOUCHERS.replaceAll("2026-01-10", badDate) }));
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false, `${label} 应失败`);
      assert.ok(v.errors.some((e) => e.includes("日期非法")), JSON.stringify(v.errors));
      assertNoWrite(`日期-${label}`, payload);
    }
  });

  // ---------- 6. 科目 / 期初 / 凭证会计约束 ----------
  await test("科目：新增科目缺方向/类别（预检必须拦住，否则正式写入会失败）", () => {
    const noDir = A.parseImportTexts(texts({ accounts: "科目编码,科目名称,类别,方向\n6602,管理费用,损益,\n" }));
    assert.equal(identityFixtureValidate(A, noDir).ok, false);
    assertNoWrite("科目-缺方向", noDir);

    const noCat = A.parseImportTexts(texts({ accounts: "科目编码,科目名称,类别,方向\n6602,管理费用,,借\n" }));
    assert.equal(identityFixtureValidate(A, noCat).ok, false);
    assertNoWrite("科目-缺类别", noCat);
  });

  await test("科目：标准科目缺方向/类别可跳过新增，保持历史输入兼容", () => {
    const payload = A.parseImportTexts({
      meta: metaText("标准科目跳过"), accounts: "科目编码,科目名称,类别,方向\n1002,银行存款,,\n",
      openings: GOOD_OPENINGS, vouchers: "",
    });
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.ok(v.warnings.some((w) => w.includes("标准科目")));
  });

  await test("科目：导入内重复编码保留首行并给 warnings，正式导入不失败", () => {
    const payload = A.parseImportTexts(texts({ accounts: "科目编码,科目名称,类别,方向\n6602,管理费用,损益,借\n6602,重复名称,损益,借\n" }));
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.ok(v.warnings.some((w) => w.includes("重复出现")), JSON.stringify(v.warnings));
    const before = snapshot();
    const r = identityFixtureImport(A, payload, { dryRun: false });
    assert.equal(r.dryRun, false, "预检通过后不得因重复科目而失败");
    const dup = A.listAccounts(r.created.id).filter((a) => a.code === "6602");
    assert.equal(dup.length, 1);
    assert.equal(dup[0].name, "管理费用");
    assert.equal(snapshot().account_sets.length, before.account_sets.length + 1);
  });

  await test("期初：借贷不平/负数/单行双向/科目不存在被拒绝", () => {
    const cases = [
      ["不平", "科目编码,借方,贷方\n1002,5000,0\n3001,0,4000\n", "期初余额借贷不平"],
      ["负数", "科目编码,借方,贷方\n1002,-1,0\n3001,0,1000\n", "不能为负"],
      ["单行双向", "科目编码,借方,贷方\n1002,100,100\n3001,0,1000\n", "借贷不能同时有值"],
      ["科目不存在", "科目编码,借方,贷方\n9999,1000,0\n3001,0,1000\n", "科目不存在"],
    ];
    for (const [label, csv, needle] of cases) {
      const payload = A.parseImportTexts(texts({ openings: csv }));
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false, `${label} 应失败`);
      assert.ok(v.errors.some((e) => e.includes(needle)), `${label}: ${JSON.stringify(v.errors)}`);
      assertNoWrite(`期初-${label}`, payload);
    }
  });

  await test("凭证：分录不足/零金额/单行双向/不平/科目不存在被拒绝", () => {
    const cases = [
      ["分录不足", "2026-01,2026-01-10,记,1,测试,6602,100,0\n", "至少两条分录"],
      ["单行双向", "2026-01,2026-01-10,记,1,测试,6602,100,100\n2026-01,2026-01-10,记,1,测试,1002,0,100\n", "借贷不能同时有值"],
      ["不平", "2026-01,2026-01-10,记,1,测试,6602,100,0\n2026-01,2026-01-10,记,1,测试,1002,0,90\n", "借贷不平"],
      ["科目不存在", "2026-01,2026-01-10,记,1,测试,9999,100,0\n2026-01,2026-01-10,记,1,测试,1002,0,100\n", "科目不存在"],
    ];
    for (const [label, csv, needle] of cases) {
      const payload = A.parseImportTexts(texts({
        vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n" + csv,
      }));
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false, `${label} 应失败`);
      assert.ok(v.errors.some((e) => e.includes(needle)), `${label}: ${JSON.stringify(v.errors)}`);
      assertNoWrite(`凭证-${label}`, payload);
    }
  });

  // ---------- 7. 事务回滚 ----------
  await test("事务回滚：正式导入中途数据库失败不残留账套/科目/期初/凭证/期间", () => {
    const payload = A.parseImportTexts(texts({ meta: metaText("回滚测试公司") }));
    const before = snapshot();
    db.exec(`CREATE TRIGGER import_strict_block BEFORE INSERT ON vouchers
             BEGIN SELECT RAISE(ABORT, 'import_strict_block'); END;`);
    let err;
    try { identityFixtureImport(A, payload, { dryRun: false }); } catch (e) { err = e; }
    finally { db.exec(`DROP TRIGGER IF EXISTS import_strict_block`); }
    assert.ok(err, "触发器错误应向外抛出");
    assert.deepEqual(snapshot(), before, "事务必须完整回滚");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets WHERE name='回滚测试公司'`).get().n, 0);
  });

  // ---------- 8. 有效输入：预检与正式结果一致 ----------
  await test("有效输入：预检无写入，正式结果与预检统计/归一化值一致", () => {
    const payload = A.parseImportTexts(texts({ meta: metaText("一致性测试公司") }));
    const before = snapshot();
    const dry = identityFixtureImport(A, payload, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.validation.ok, true, JSON.stringify(dry.validation.errors));
    assert.equal(dry.created, null);
    assert.deepEqual(snapshot(), before, "预检不得有任何写入");

    const formal = identityFixtureImport(A, payload, { dryRun: false });
    assert.equal(formal.dryRun, false);
    assert.equal(formal.validation.ok, true);
    assert.equal(formal.created.name, "一致性测试公司");
    assert.equal(formal.created.vouchers, dry.validation.summary.vouchers);
    assert.equal(formal.created.opening_balances, dry.validation.summary.opening_balances);
    assert.equal(formal.created.start_period, "2026-01");

    const setId = formal.created.id;
    const ob = A.getOpeningBalances(setId).find((o) => o.code === "1002");
    assert.equal(ob.debit, 1000);
    const vouchers = A.listVouchers(setId);
    assert.equal(vouchers.length, 1);
    assert.equal(vouchers[0].total_debit, 100);
    assert.equal(vouchers[0].total_credit, 100);
    assert.equal(vouchers[0].voucher_date, "2026-01-10");
    assert.ok(A.listAccounts(setId).some((a) => a.code === "6602"), "新增科目应落库");
    assert.ok(A.listPeriods(setId).some((p) => p.period === "2026-01"));
  });

  await test("已存在同名账套：失败输入与同名正式导入都不会污染既有账套数据", () => {
    const existing = identityFixtureCreate(A, { name: "一致性测试公司", start_period: "2026-01" });
    A.setOpeningBalances(existing.id, [{ code: "1002", debit: 5000, credit: 0 }, { code: "3001", debit: 0, credit: 5000 }]);
    const existingBefore = {
      accounts: A.listAccounts(existing.id).length,
      openings: A.getOpeningBalances(existing.id),
      vouchers: A.listVouchers(existing.id).length,
    };
    const bad = A.parseImportTexts(texts({
      meta: metaText("一致性测试公司"),
      openings: "科目编码,借方,贷方\n1002,abc,0\n3001,0,1000\n",
    }));
    assert.equal(identityFixtureImport(A, bad, { dryRun: false }).created, null);
    const good = identityFixtureImport(A, A.parseImportTexts(texts({ meta: metaText("一致性测试公司") })), { dryRun: false });
    assert.equal(good.dryRun, false);
    assert.notEqual(good.created.id, existing.id, "同名导入应新建账套，不合并到既有账套");
    assert.equal(A.listAccounts(existing.id).length, existingBefore.accounts);
    assert.deepEqual(A.getOpeningBalances(existing.id), existingBefore.openings);
    assert.equal(A.listVouchers(existing.id).length, existingBefore.vouchers);
  });

  await test("预置既有合成账套：失败导入后完整内容快照（全部行）不变", () => {
    const s = identityFixtureCreate(A, { name: "既有合成账套", start_period: "2026-01" });
    A.setOpeningBalances(s.id, [{ code: "1002", debit: 5000, credit: 0 }, { code: "3001", debit: 0, credit: 5000 }]);
    A.createVoucher(s.id, { period: "2026-01", voucher_date: "2026-01-05", word: "记", number: 1, status: "posted",
      entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }] });
    const before = snapshot();
    const bad = { account_set: { name: "坏导入", start_period: "2026-01" },
      opening_balances: [{ code: "1002", debit: 100 }, { code: "1002", debit: 100 }, { code: "3001", credit: 200 }] };
    assert.equal(identityFixtureImport(A, bad, { dryRun: false }).created, null);
    assert.deepEqual(snapshot(), before, "既有合成账套的全部行内容（含既有凭证/期初）不得变化");
  });

  // ---------- 9. 返工 1：负数在 r2 前校验 / 超界原值不得因舍入被接受 ----------
  await test("金额：-0.001 等极小负值在 r2 前被拒绝（JSON number/string 与 CSV）", () => {
    for (const bad of [-0.001, "-0.001", -0.004, "-0.004"]) {
      const payload = { account_set: { name: `负值-${bad}`, start_period: "2026-01" }, opening_balances: [{ code: "1002", debit: bad }] };
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false, `期初 ${bad} 应被拒绝`);
      assert.ok(v.errors.some((e) => e.includes("不能为负")), JSON.stringify(v.errors));
      assertNoWrite(`期初负值-${bad}`, payload);
    }
    const csv = A.parseImportTexts(texts({ openings: "科目编码,借方,贷方\n1002,-0.001,0\n3001,0,0\n" }));
    assert.equal(identityFixtureValidate(A, csv).ok, false);
    assertNoWrite("CSV 期初负值", csv);
  });

  await test("金额：超界原值不得因舍入被接受（number 与文本）", () => {
    for (const bad of [999999999999.994, "999999999999.994", 999999999999.995, "999999999999.995"]) {
      const r = A.parseImportAmount(bad);
      assert.equal(r.ok, false, `${bad} 应被拒绝`);
      assert.match(r.error, /超界/);
    }
    assert.equal(A.parseImportAmount(999999999999.99).ok, true, "边界值本身仍合法");
  });

  await test("凭证：非零另一侧的极小负值也不能被吞掉", () => {
    const payload = {
      account_set: { name: "非零负值", start_period: "2026-01" },
      vouchers: [{ period: "2026-01", number: 1, entries: [
        { code: "1002", debit: 100.001, credit: -0.001 },
        { code: "3001", debit: 0, credit: 100 },
      ] }],
    };
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("贷方不能为负")), JSON.stringify(v.errors));
    assertNoWrite("凭证非零负值", payload);
  });

  // ---------- 10. 重复期初规则 ----------
  await test("期初：重复科目预检即拒绝（不汇总），预检与正式一致且不落库", () => {
    const payload = {
      account_set: { name: "重复期初", start_period: "2026-01" },
      opening_balances: [{ code: "1002", debit: 100 }, { code: "1002", debit: 100 }, { code: "3001", credit: 200 }],
    };
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false, "重复期初必须预检失败");
    assert.ok(v.errors.some((e) => e.includes("期初余额第 2 行") && e.includes("重复出现")), JSON.stringify(v.errors));
    assertNoWrite("重复期初", payload);
  });

  // ---------- 11. 形状校验 ----------
  await test("形状：payload/account_set/三个集合/集合元素/entries 显式错误类型必须拒绝", () => {
    const base = { account_set: { name: "形状", start_period: "2026-01" } };
    const cases = [
      ["payload 非对象", "bad"],
      ["account_set 非对象", { ...base, account_set: "bad" }],
      ["accounts 非数组", { ...base, accounts: "bad" }],
      ["opening_balances 非数组", { ...base, opening_balances: "bad" }],
      ["vouchers 非数组", { ...base, vouchers: "bad" }],
      ["accounts 元素非对象", { ...base, accounts: [100] }],
      ["opening_balances 元素非对象", { ...base, opening_balances: ["bad"] }],
      ["vouchers 元素非对象", { ...base, vouchers: ["bad"] }],
      ["entries 非数组", { ...base, vouchers: [{ period: "2026-01", number: 1, entries: "bad" }] }],
      ["entries 元素非对象", { ...base, vouchers: [{ period: "2026-01", number: 1, entries: [1, 2] }] }],
    ];
    for (const [label, payload] of cases) {
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false, `${label} 应被拒绝`);
      if (typeof payload === "object" && payload !== null) assertNoWrite(label, payload);
    }
  });

  await test("形状：集合缺失默认为空；金额数组/布尔/对象被拒绝", () => {
    const v = identityFixtureValidate(A, { account_set: { name: "缺集合", start_period: "2026-01" } });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(v.summary.accounts, 0);
    for (const bad of [[100], [], true, {}]) assert.equal(A.parseImportAmount(bad).ok, false, `${JSON.stringify(bad)} 应被拒绝`);
  });

  // ---------- 12. meta 字段类型 ----------
  await test("meta：taxpayer_type/accounting_standard/name/start_period 错误类型预检失败且不落库", () => {
    const cases = [
      ["taxpayer_type 对象", { name: "m1", start_period: "2026-01", taxpayer_type: { bad: 1 } }],
      ["accounting_standard 对象", { name: "m2", start_period: "2026-01", accounting_standard: { bad: 1 } }],
      ["name 对象", { name: { bad: 1 }, start_period: "2026-01" }],
      ["start_period 数组", { name: "m4", start_period: ["2026-01"] }],
    ];
    for (const [label, account_set] of cases) {
      const payload = { account_set };
      assert.equal(identityFixtureValidate(A, payload).ok, false, `${label} 应被拒绝`);
      assertNoWrite(label, payload);
    }
  });

  // ---------- 13. CSV 日期/凭证号逐行校验 ----------
  await test("CSV 凭证：同一凭证后续行的非法日期不能被首行遮蔽", () => {
    const payload = A.parseImportTexts(texts({
      vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
        + "2026-01,2026-01-10,记,1,x,1002,100,0\n"
        + "2026-01,BADDATE,记,1,x,3001,0,100\n",
    }));
    assert.deepEqual(payload.vouchers[0].dates, ["2026-01-10", "BADDATE"]);
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("日期非法") && e.includes("BADDATE")), JSON.stringify(v.errors));
    assertNoWrite("CSV 后续行非法日期", payload);
  });

  await test("CSV 凭证：非法凭证号不再被 parseInt 吞掉", () => {
    for (const bad of ["1oops", "0", "-1", "1.5", "1e3"]) {
      const payload = A.parseImportTexts(texts({
        vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
          + `2026-01,2026-01-10,记,${bad},x,1002,100,0\n`
          + `2026-01,2026-01-10,记,${bad},x,3001,0,100\n`,
      }));
      const v = identityFixtureValidate(A, payload);
      assert.equal(v.ok, false, `编号 ${bad} 应被拒绝`);
      assert.ok(v.errors.some((e) => e.includes("凭证编号非法")), `${bad}: ${JSON.stringify(v.errors)}`);
      assertNoWrite(`CSV 非法编号-${bad}`, payload);
    }
  });

  await test("CSV 凭证：显式合法正整数可用；缺省编号保持默认 1", () => {
    const explicit = A.parseImportTexts(texts({
      vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
        + "2026-01,2026-01-10,记,7,x,1002,100,0\n"
        + "2026-01,2026-01-10,记,7,x,3001,0,100\n",
    }));
    assert.equal(identityFixtureValidate(A, explicit).ok, true, JSON.stringify(identityFixtureValidate(A, explicit).errors));
    assert.equal(explicit.vouchers[0].number, 7);

    const missing = A.parseImportTexts(texts({
      vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
        + "2026-01,2026-01-10,记,,x,1002,100,0\n"
        + "2026-01,2026-01-10,记,,x,3001,0,100\n",
    }));
    assert.equal(missing.vouchers[0].number, 1);
    assert.equal(identityFixtureValidate(A, missing).ok, true);
  });

  await test("CSV 凭证：同一凭证日期不一致要报错，不静默丢弃后续值", () => {
    const payload = A.parseImportTexts(texts({
      vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
        + "2026-01,2026-01-10,记,1,x,1002,100,0\n"
        + "2026-01,2026-02-11,记,1,x,3001,0,100\n",
    }));
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("日期不一致")), JSON.stringify(v.errors));
    assertNoWrite("CSV 日期不一致", payload);
  });

  // ---------- 14. 大金额累计浮点一致性（共享 sumMoney） ----------
  await test("浮点累计：1000 条 0.1 借方与 100 贷方，预检与正式写入一致", () => {
    const entries = [];
    for (let i = 0; i < 1000; i++) entries.push({ code: "1002", debit: 0.1, credit: 0 });
    entries.push({ code: "3001", debit: 0, credit: 100 });
    const payload = { account_set: { name: "浮点累计", start_period: "2026-01" },
      vouchers: [{ period: "2026-01", number: 1, entries }] };
    const dry = identityFixtureImport(A, payload, { dryRun: true });
    assert.equal(dry.validation.ok, true, JSON.stringify(dry.validation.errors));
    const formal = identityFixtureImport(A, payload, { dryRun: false });
    assert.equal(formal.dryRun, false, "预检通过后正式写入不得因同一静态约束失败");
    const v = A.listVouchers(formal.created.id)[0];
    assert.equal(v.total_debit, 100);
    assert.equal(v.total_credit, 100);
  });

  // ---------- 15. 辅助字段（dates / numberRaw）不得绕开原始校验 ----------
  const auxVoucher = (over = {}) => ({
    account_set: { name: "辅助字段测试", start_period: "2026-01" },
    vouchers: [{
      period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "测试",
      entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      ...over,
    }],
  });

  await test("辅助字段：JSON date 非法不得被 dates 覆盖/替代", () => {
    const payload = auxVoucher({ date: "garbage", dates: [] });
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false, "date 非法必须被拒绝");
    assert.ok(v.errors.some((e) => e.includes("日期非法")), JSON.stringify(v.errors));
    assertNoWrite("dates覆盖date", payload);
  });

  await test("辅助字段：dates 非数组 / 逐项非法 / 与 date 不一致均被拒绝", () => {
    const notArray = auxVoucher({ date: "2026-01-10", dates: "2026-01-10" });
    const v1 = identityFixtureValidate(A, notArray);
    assert.equal(v1.ok, false);
    assert.ok(v1.errors.some((e) => e.includes("dates") && e.includes("格式非法")), JSON.stringify(v1.errors));
    assertNoWrite("dates非数组", notArray);

    const badItem = auxVoucher({ date: "2026-01-10", dates: ["2026-01-10", "BADDATE"] });
    const v2 = identityFixtureValidate(A, badItem);
    assert.equal(v2.ok, false);
    assert.ok(v2.errors.some((e) => e.includes("日期非法") && e.includes("BADDATE")), JSON.stringify(v2.errors));
    assertNoWrite("dates逐项非法", badItem);

    const inconsistent = auxVoucher({ date: "2026-01-10", dates: ["2026-01-10", "2026-02-11"] });
    const v3 = identityFixtureValidate(A, inconsistent);
    assert.equal(v3.ok, false);
    assert.ok(v3.errors.some((e) => e.includes("日期不一致")), JSON.stringify(v3.errors));
    assertNoWrite("dates与date不一致", inconsistent);
  });

  await test("辅助字段：JSON numberRaw 不得掩盖 number 错误，且自身类型必须为文本", () => {
    const payload = auxVoucher({ number: "bad", numberRaw: [1] });
    const v = identityFixtureValidate(A, payload);
    assert.equal(v.ok, false, "number 与 numberRaw 都必须被校验");
    assert.ok(v.errors.some((e) => e.includes("凭证编号非法")), JSON.stringify(v.errors));
    assert.ok(v.errors.some((e) => e.includes("numberRaw") && e.includes("类型非法")), JSON.stringify(v.errors));
    assertNoWrite("numberRaw掩盖number", payload);
  });

  await test("辅助字段：number 与 numberRaw 同时存在必须一致", () => {
    const mismatch = auxVoucher({ number: 2, numberRaw: "1" });
    const v = identityFixtureValidate(A, mismatch);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("不一致")), JSON.stringify(v.errors));
    assertNoWrite("numberRaw不一致", mismatch);

    const consistent = auxVoucher({ number: 1, numberRaw: "1" });
    const vc = identityFixtureValidate(A, consistent);
    assert.equal(vc.ok, true, JSON.stringify(vc.errors));
  });

  await test("辅助字段：CSV 合法 parse->JSON 序列化往返后正式导入成功（dates/numberRaw 不误报）", () => {
    const parsed = A.parseImportTexts(texts({ meta: metaText("往返测试公司") }));
    assert.ok(Array.isArray(parsed.vouchers[0].dates), "CSV 解析应保留 dates");
    assert.equal(typeof parsed.vouchers[0].numberRaw, "string", "CSV 解析应保留 numberRaw 文本");
    const roundtripped = JSON.parse(JSON.stringify(parsed));
    const dry = identityFixtureImport(A, roundtripped, { dryRun: true });
    assert.equal(dry.validation.ok, true, JSON.stringify(dry.validation.errors));
    const formal = identityFixtureImport(A, roundtripped, { dryRun: false });
    assert.equal(formal.dryRun, false, "合法 CSV parse->JSON 往返后正式导入必须成功");
    assert.equal(formal.created.name, "往返测试公司");
    const vouchers = A.listVouchers(formal.created.id);
    assert.equal(vouchers.length, 1);
    assert.equal(vouchers[0].voucher_date, "2026-01-10");
  });

  // ---------- 16. HTTP / Agent 真实入口集成 ----------
  const here = dirname(fileURLToPath(import.meta.url));
  const httpDataDir = mkdtempSync(join(tmpdir(), "wb-import-http-"));
  // PORT=0：端口由子进程自己分配，必须从它的 stdout 读取实际端口，
  // 避免与现有真实后端端口碰撞后误连到别的服务。
  const child = spawn(process.execPath, [join(here, "..", "server", "server.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", WORKBENCH_DATA_DIR: httpDataDir },
  });
  child.stderr.on("data", (d) => process.stderr.write(`[http] ${d}`));
  const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let BASE = "";
  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  // 等待子进程自己打印实际监听端口；同时监听超时与提前退出，不盲目轮询固定端口。
  const waitReady = (timeoutMs = 10000) => new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server_not_ready_timeout")), timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = /127\.0\.0\.1:(\d+)\//.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server_exited_before_ready code=${code}`)); });
  });
  try {
    BASE = `http://127.0.0.1:${await waitReady()}`;
    const badCsv = {
      meta: metaText("HTTP非法"), accounts: GOOD_ACCOUNTS,
      openings: "科目编码,借方,贷方\n1002,abc,0\n3001,0,1000\n", vouchers: "",
    };
    await testAsync("HTTP /api/import/parse：非法 CSV 金额返回 validation.ok=false", async () => {
      const r = await api("POST", "/api/import/parse", { enterprise: identityFixture(), texts: badCsv });
      assert.equal(r.status, 200);
      assert.equal(r.data.validation.ok, false);
    });
    await testAsync("HTTP /api/import/account-set：解析返回 payload 再提交，dryRun=false 仍拒绝且不建账", async () => {
      const parsed = await api("POST", "/api/import/parse", { enterprise: identityFixture(), texts: badCsv });
      const r = await api("POST", "/api/import/account-set", { enterprise: identityFixture(), payload: parsed.data.payload, dryRun: false });
      assert.equal(r.data.created, null);
      assert.equal(r.data.validation.ok, false);
      const sets = await api("GET", "/api/account-sets");
      assert.equal(sets.data.length, 0, "失败导入不得创建账套");
    });
    await testAsync("HTTP：合法 CSV parse 得到 payload 再以 JSON 提交，正式导入成功（dates/numberRaw 往返正常）", async () => {
      const goodCsv = { meta: metaText("HTTP往返"), accounts: GOOD_ACCOUNTS, openings: GOOD_OPENINGS, vouchers: GOOD_VOUCHERS };
      const parsed = await api("POST", "/api/import/parse", { enterprise: identityFixture(), texts: goodCsv });
      assert.equal(parsed.data.validation.ok, true, JSON.stringify(parsed.data.validation.errors));
      const r = await api("POST", "/api/import/account-set", { enterprise: identityFixture(), payload: parsed.data.payload, dryRun: false });
      assert.equal(r.data.validation.ok, true, JSON.stringify(r.data.validation.errors));
      assert.ok(r.data.created, "合法往返应创建账套");
      const sets = await api("GET", "/api/account-sets");
      assert.ok(sets.data.some((s) => s.id === r.data.created.id));
    });
    await testAsync("Agent legacy_book_import：非法 JSON payload 默认预检拒绝；显式 dryRun=false 也不落库", async () => {
      const payload = { account_set: { name: "Agent非法", start_period: "2026-01" },
        opening_balances: [{ code: "1002", debit: "abc" }, { code: "3001", credit: 1000 }] };
      const dry = await api("POST", "/agent/tools/legacy_book_import", { enterprise: identityFixture(), payload });
      assert.equal(dry.data.validation.ok, false);
      assert.equal(dry.data.created, null);
      const formal = await api("POST", "/agent/tools/legacy_book_import", { enterprise: identityFixture(), payload, dryRun: false });
      assert.equal(formal.data.created, null);
      assert.equal(formal.data.validation.ok, false);
    });
    await testAsync("Agent legacy_book_import：非法 CSV 文本同样拒绝", async () => {
      const r = await api("POST", "/agent/tools/legacy_book_import", { enterprise: identityFixture(), texts: badCsv, dryRun: false });
      assert.equal(r.data.created, null);
      assert.equal(r.data.validation.ok, false);
    });
  } finally {
    child.kill();
    // 等子进程真正退出后再删临时目录，避免端口/文件残留或连到旧进程。
    await childExit;
    try { rmSync(httpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

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
