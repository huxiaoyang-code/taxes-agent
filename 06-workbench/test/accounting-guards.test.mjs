#!/usr/bin/env node
// 固定的合成测试身份，不依赖显示名及生产默认值。
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-accounting-guards-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
/**
 * CORE-A 记账守卫回归测试：独立临时库，直接调用领域函数。
 * 覆盖：期初校验与原子性、封账后读写保护、期间创建与校验。
 * 运行：node test/accounting-guards.test.mjs（在 06-workbench 目录）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dataDir = mkdtempSync(join(tmpdir(), "wb-guards-"));
process.env.WORKBENCH_DATA_DIR = dataDir;

let db, A;
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};
const rejects = async (fn, re) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, "应抛出错误但未抛出");
  if (re) assert.match(String(err.message), re);
  return err;
};
const openingOf = (setId, code) => A.getOpeningBalances(setId).find((o) => o.code === code);
const entry = (code, debit, credit) => ({ code, debit, credit });

try {
  ({ db } = await import("../server/db.mjs"));
  A = await import("../server/accounting.mjs");

  console.log("\nCORE-A 记账守卫回归测试\n");

  // ---------- 1. 期初余额：校验 + 原子性 ----------
  let setId;
  await test("创建账套（启用期间 2026-01）", () => {
    setId = identityFixtureCreate(A, { name: "守卫测试-期初", start_period: "2026-01" }).id;
    assert.ok(setId > 0);
  });

  await test("期初：合法平衡写入成功", () => {
    const out = A.setOpeningBalances(setId, [entry("1002", 1000, 0), entry("3001", 0, 1000)]);
    assert.equal(out.length, 2);
    assert.equal(openingOf(setId, "1002").debit, 1000);
    assert.equal(openingOf(setId, "3001").credit, 1000);
  });

  await test("期初：先写有效行后遇无效行不能部分落库", async () => {
    await rejects(() => A.setOpeningBalances(setId, [entry("1002", 5000, 0), entry("9999", 0, 0)]),
      /account_not_found:9999/);
    assert.equal(openingOf(setId, "1002").debit, 1000, "有效行不应被写入");
    assert.equal(openingOf(setId, "1002").credit, 0);
  });

  await test("期初：单行借贷同时非零被拒绝", async () => {
    await rejects(() => A.setOpeningBalances(setId, [entry("1002", 100, 100), entry("3001", 0, 1000)]),
      /opening_borrow_lend_conflict:1002/);
    assert.equal(openingOf(setId, "1002").debit, 1000);
  });

  await test("期初：负数/非有限金额被拒绝", async () => {
    await rejects(() => A.setOpeningBalances(setId, [entry("1002", -1, 0)]), /opening_amount_invalid:1002/);
    await rejects(() => A.setOpeningBalances(setId, [entry("1002", NaN, 0)]), /opening_amount_invalid:1002/);
    await rejects(() => A.setOpeningBalances(setId, [entry("1002", Infinity, 0)]), /opening_amount_invalid:1002/);
    assert.equal(openingOf(setId, "1002").debit, 1000);
  });

  await test("期初：与已有期初合并后不平被拒绝且无部分修改", async () => {
    await rejects(() => A.setOpeningBalances(setId, [entry("1002", 2000, 0)]), /opening_unbalanced/);
    assert.equal(openingOf(setId, "1002").debit, 1000);
    assert.equal(openingOf(setId, "3001").credit, 1000);
  });

  await test("期初：空列表保持现状且仍做校验", () => {
    const out = A.setOpeningBalances(setId, []);
    assert.equal(out.length, 2);
    assert.equal(openingOf(setId, "1002").debit, 1000);
    assert.equal(openingOf(setId, "3001").credit, 1000);
  });

  await test("期初：已有已过账凭证后拒绝重写", async () => {
    A.createVoucher(setId, {
      period: "2026-01", status: "posted",
      entries: [entry("1002", 10, 0), entry("1001", 0, 10)],
    });
    await rejects(() => A.setOpeningBalances(setId, [entry("1002", 1000, 0), entry("3001", 0, 1000)]),
      /opening_rewrite_after_posting/);
  });

  await test("期初：封账期间后拒绝重写", async () => {
    const s2 = identityFixtureCreate(A, { name: "守卫测试-封账期初", start_period: "2026-01" }).id;
    A.setOpeningBalances(s2, [entry("1002", 500, 0), entry("3001", 0, 500)]);
    A.setPeriodStatus(s2, "2026-01", "closed");
    await rejects(() => A.setOpeningBalances(s2, [entry("1002", 600, 0), entry("3001", 0, 600)]),
      /opening_rewrite_period_closed/);
  });

  // ---------- 2. 封账后读写保护 / 反结账 ----------
  let setId2, vPosted, vDraft;
  await test("封账：准备账套与凭证", () => {
    setId2 = identityFixtureCreate(A, { name: "守卫测试-封账", start_period: "2026-01" }).id;
    A.setOpeningBalances(setId2, [entry("1002", 1000, 0), entry("3001", 0, 1000)]);
    vPosted = A.createVoucher(setId2, {
      period: "2026-01", status: "posted",
      entries: [entry("1002", 50, 0), entry("1001", 0, 50)],
    });
    vDraft = A.createVoucher(setId2, {
      period: "2026-01", status: "draft",
      entries: [entry("1002", 20, 0), entry("1001", 0, 20)],
    });
  });

  await test("封账：模拟外部封账（直接置 closed）", () => {
    db.prepare(`UPDATE periods SET status='closed' WHERE account_set_id=? AND period='2026-01'`).run(setId2);
    assert.equal(A.periodStatus(setId2, "2026-01"), "closed");
  });

  await test("封账后：创建凭证被拒绝", async () => {
    await rejects(() => A.createVoucher(setId2, {
      period: "2026-01", status: "draft",
      entries: [entry("1002", 1, 0), entry("1001", 0, 1)],
    }), /period_closed/);
  });

  await test("封账后：过账草稿被拒绝", async () => {
    await rejects(() => A.postVoucher(setId2, vDraft.id), /period_closed/);
  });

  await test("封账后：反过账被拒绝", async () => {
    await rejects(() => A.unpostVoucher(setId2, vPosted.id), /period_closed/);
  });

  await test("封账后：删除草稿被拒绝", async () => {
    await rejects(() => A.deleteVoucher(setId2, vDraft.id), /period_closed/);
  });

  await test("封账后：校验失败无副作用（状态不变）", () => {
    assert.equal(A.getVoucher(setId2, vPosted.id).status, "posted");
    assert.equal(A.getVoucher(setId2, vDraft.id).status, "draft");
    assert.equal(A.listVouchers(setId2, { period: "2026-01" }).length, 2);
  });

  await test("反结账后：创建/过账/反过账/删除均恢复", () => {
    const r = A.setPeriodStatus(setId2, "2026-01", "open");
    assert.deepEqual(r, { period: "2026-01", status: "open" });
    assert.equal(A.unpostVoucher(setId2, vPosted.id).status, "draft");
    assert.equal(A.postVoucher(setId2, vDraft.id).status, "posted");
    assert.equal(A.deleteVoucher(setId2, vPosted.id).deleted, vPosted.id);
    const created = A.createVoucher(setId2, {
      period: "2026-01", status: "draft",
      entries: [entry("1002", 1, 0), entry("1001", 0, 1)],
    });
    assert.equal(created.status, "draft");
  });

  // ---------- 3. 期间创建与校验 ----------
  let setId3;
  await test("期间：open 可创建新期间", () => {
    setId3 = identityFixtureCreate(A, { name: "守卫测试-期间", start_period: "2026-01" }).id;
    const r = A.setPeriodStatus(setId3, "2026-02", "open");
    assert.deepEqual(r, { period: "2026-02", status: "open" });
    assert.ok(A.listPeriods(setId3).find((p) => p.period === "2026-02" && p.status === "open"));
  });

  await test("期间：月份 13 被拒绝（各入口一致）", async () => {
    await rejects(() => A.setPeriodStatus(setId3, "2026-13", "open"), /period_invalid/);
    await rejects(() => A.ensurePeriod(setId3, "2026-13"), /period_invalid/);
    await rejects(() => identityFixtureCreate(A, { name: "坏账套", start_period: "2026-13" }), /start_period_invalid/);
    await rejects(() => A.createVoucher(setId3, {
      period: "2026-13", entries: [entry("1002", 1, 0), entry("1001", 0, 1)],
    }), /period_invalid/);
  });

  await test("期间：不得早于启用期间", async () => {
    await rejects(() => A.setPeriodStatus(setId3, "2025-12", "open"), /period_before_start/);
    await rejects(() => A.ensurePeriod(setId3, "2025-12"), /period_before_start/);
  });

  await test("期间：结账拒绝当期草稿", async () => {
    A.createVoucher(setId3, {
      period: "2026-01", status: "draft",
      entries: [entry("1002", 1, 0), entry("1001", 0, 1)],
    });
    await rejects(() => A.setPeriodStatus(setId3, "2026-01", "closed"), /period_has_draft_vouchers/);
  });

  await test("期间：结账拒绝不平衡", async () => {
    const s4 = identityFixtureCreate(A, { name: "守卫测试-不平衡", start_period: "2026-01" }).id;
    db.prepare(`INSERT INTO opening_balances (account_set_id, code, debit, credit) VALUES (?,?,?,?)`)
      .run(s4, "1002", 800, 0);
    await rejects(() => A.setPeriodStatus(s4, "2026-01", "closed"), /period_unbalanced/);
  });

  await test("期间：结账不要求损益结转凭证", () => {
    const s5 = identityFixtureCreate(A, { name: "守卫测试-无结转", start_period: "2026-01" }).id;
    A.setOpeningBalances(s5, [entry("1002", 1000, 0), entry("3001", 0, 1000)]);
    A.createVoucher(s5, {
      period: "2026-01", status: "posted",
      entries: [entry("1002", 10, 0), entry("1001", 0, 10)],
    });
    const r = A.setPeriodStatus(s5, "2026-01", "closed");
    assert.deepEqual(r, { period: "2026-01", status: "closed" });
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e);
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* 忽略 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
