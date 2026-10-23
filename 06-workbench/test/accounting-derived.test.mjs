#!/usr/bin/env node
/**
 * CORE-B 派生报表 / 结转 / 折旧 一致性回归测试。
 * 独立临时库，直接调用领域函数；退出时关闭数据库并清理自己的临时目录。
 * 运行：node test/accounting-derived.test.mjs（在 06-workbench 目录）
 *
 * 覆盖：
 * 1) 明细科目按编码层级归集（资产/负债/权益/损益、现金流、明细账）；
 * 2) 零利润、反向损益、年末结转、重算/防重复与事务原子性；
 * 3) 折旧反过账/删除/重计提状态一致性、卡片与总账勾稽、原子性与尾差提足；
 * 4) 期初负数在舍入前校验（-0.001 不被 round2 吞掉）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dataDir = mkdtempSync(join(tmpdir(), "wb-derived-"));
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
const entry = (code, debit, credit) => ({ code, debit, credit });
// r2 可能返回 -0，strictEqual 下 -0 !== 0；统一归一化。
const z = (v) => (v === 0 ? 0 : v);
const newSet = (name) => A.createAccountSet({ name, start_period: "2026-01" }).id;
const bsLine = (bs, label) => [...bs.assets, ...bs.liabilities].find((l) => l.label === label).value;
const carryVouchers = (setId, period) =>
  A.listVouchers(setId, { period }).filter((v) => v.kind === "carryforward");
const depVouchers = (setId, period) =>
  A.listVouchers(setId, { period }).filter((v) => v.kind === "depreciation");

try {
  ({ db } = await import("../server/db.mjs"));
  A = await import("../server/accounting.mjs");

  console.log("\nCORE-B 派生报表 / 结转 / 折旧 回归测试\n");

  // ================================================================ 1. 明细科目汇总
  await test("明细：新增 100201 银行明细后资产负债表平衡", () => {
    const s = newSet("明细汇总-平衡");
    A.addAccount(s, { code: "100201", name: "工行基本户", category: "资产", direction: "debit" });
    A.createVoucher(s, {
      period: "2026-01", status: "posted",
      entries: [entry("100201", 100, 0), entry("3001", 0, 100)],
    });
    const bs = A.balanceSheet(s, "2026-01");
    assert.equal(bs.balanced, true);
    assert.equal(bs.totals.assets, 100);
    assert.equal(bs.totals.equity, 100);
    assert.equal(bsLine(bs, "货币资金"), 100);
  });

  await test("明细：现金流包含 1002 下级且与货币资金变动勾稽", () => {
    const s = newSet("明细汇总-现金流");
    A.addAccount(s, { code: "100201", name: "工行基本户", category: "资产", direction: "debit" });
    A.createVoucher(s, {
      period: "2026-01", status: "posted",
      entries: [entry("100201", 100, 0), entry("3001", 0, 100)],
    });
    const cf = A.cashFlowStatement(s, "2026-01");
    assert.equal(cf.reconciles, true);
    assert.equal(cf.cash.end, 100);
    assert.equal(cf.totals.net_increase, 100);
    assert.equal(cf.totals.financing, 100);
    assert.equal(cf.operating.length, 0);
  });

  await test("明细：父科目直接发生 + 子科目明细不重复、不遗漏", () => {
    const s = newSet("明细汇总-父子并存");
    A.addAccount(s, { code: "100201", name: "工行基本户", category: "资产", direction: "debit" });
    A.addAccount(s, { code: "100202", name: "建行基本户", category: "资产", direction: "debit" });
    A.setOpeningBalances(s, [entry("1002", 1000, 0), entry("3001", 0, 1000)]);
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 50, 0), entry("3001", 0, 50)] });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("100201", 30, 0), entry("3001", 0, 30)] });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("100202", 20, 0), entry("3001", 0, 20)] });
    const bs = A.balanceSheet(s, "2026-01");
    assert.equal(bsLine(bs, "货币资金"), 1100, "父 1050 + 子 30 + 子 20");
    assert.equal(bs.totals.equity, 1100);
    assert.equal(bs.balanced, true);
  });

  await test("明细：非货币资金科目同样按层级归集（1122 下级）", () => {
    const s = newSet("明细汇总-应收");
    A.addAccount(s, { code: "112201", name: "客户A", category: "资产", direction: "debit" });
    A.createVoucher(s, {
      period: "2026-01", status: "posted",
      entries: [entry("112201", 30, 0), entry("5001", 0, 30)],
    });
    const bs = A.balanceSheet(s, "2026-01");
    assert.equal(bsLine(bs, "应收账款"), 30);
    assert.equal(bs.totals.assets, 30);
    assert.equal(bs.balanced, true);
  });

  await test("明细：负债明细科目同样按层级归集（2202 下级）", () => {
    const s = newSet("明细汇总-应付");
    A.addAccount(s, { code: "220201", name: "供应商A", category: "负债", direction: "credit" });
    A.createVoucher(s, {
      period: "2026-01", status: "posted",
      entries: [entry("1002", 50, 0), entry("220201", 0, 50)],
    });
    const bs = A.balanceSheet(s, "2026-01");
    assert.equal(bsLine(bs, "应付账款"), 50);
    assert.equal(bs.totals.liabilities, 50);
    assert.equal(bs.balanced, true);
  });

  await test("明细：损益明细科目按顶层编码归类（560201 → 管理费用）", () => {
    const s = newSet("明细汇总-损益归类");
    A.addAccount(s, { code: "560201", name: "办公费", category: "损益", direction: "debit" });
    A.createVoucher(s, {
      period: "2026-01", status: "posted",
      entries: [entry("560201", 40, 0), entry("1002", 0, 40)],
    });
    const is = A.incomeStatement(s, "2026-01");
    assert.equal(is.current["管理费用"], 40);
    assert.equal(is.current["其他费用"], 0);
    assert.equal(is.current["净利润"], -40);
    const bs = A.balanceSheet(s, "2026-01");
    assert.equal(bsLine(bs, "未分配利润"), -40);
    assert.equal(bs.balanced, true);
  });

  await test("明细账：父科目含下级明细且余额连续", () => {
    const s = newSet("明细汇总-明细账");
    A.addAccount(s, { code: "100201", name: "工行基本户", category: "资产", direction: "debit" });
    A.addAccount(s, { code: "100202", name: "建行基本户", category: "资产", direction: "debit" });
    A.setOpeningBalances(s, [entry("1002", 1000, 0), entry("3001", 0, 1000)]);
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 50, 0), entry("3001", 0, 50)] });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("100201", 30, 0), entry("3001", 0, 30)] });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("100202", 20, 0), entry("3001", 0, 20)] });
    const gl = A.generalLedger(s, "1002", "2026-01");
    assert.equal(gl.code, "1002");
    assert.equal(gl.opening.debit, 1000);
    assert.equal(gl.items.length, 3, "应包含父 + 2 个子科目发生");
    assert.equal(gl.items[gl.items.length - 1].balance, 1100);
  });

  // ================================================================ 2. 零利润 / 负余额 / 年末结转
  await test("零利润：收入100费用100仍正常结转，不生成零金额行", () => {
    const s = newSet("结转-零利润");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 100, 0), entry("5001", 0, 100)] });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("5602", 100, 0), entry("1002", 0, 100)] });
    const r = A.carryForwardProfit(s, "2026-01");
    assert.ok(r.voucher, "应生成结转凭证");
    assert.equal(r.profit, 0);
    assert.equal(r.voucher.entries.some((e) => e.code === "3103"), false, "利润为 0 不应有 3103 行");
    assert.equal(r.voucher.total_debit, 100);
    assert.equal(r.voucher.total_credit, 100);
    const bal = A.accountBalances(s, "2026-01");
    assert.equal(z(bal.get("5001").natural), 0);
    assert.equal(z(bal.get("5602").natural), 0);
  });

  await test("反向损益：负余额按符号生成合法借贷行（无负数金额）", () => {
    const s = newSet("结转-反向损益");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("5602", 100, 0), entry("1002", 0, 100)] });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("5001", 40, 0), entry("1002", 0, 40)] });
    const r = A.carryForwardProfit(s, "2026-01");
    assert.ok(r.voucher);
    assert.equal(r.profit, -140); // 收入 -40 − 费用 100
    for (const e of r.voucher.entries) {
      assert.ok(e.debit >= 0 && e.credit >= 0, `金额不得为负：${JSON.stringify(e)}`);
    }
    const line3103 = r.voucher.entries.find((e) => e.code === "3103");
    assert.equal(line3103.debit, 140);
    assert.equal(line3103.credit, 0);
    assert.equal(r.voucher.total_debit, r.voucher.total_credit);
  });

  await test("年末结转：普通结转后独立 yearEnd 可续做 3103→3104", () => {
    const s = newSet("结转-续做年末");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 500, 0), entry("5001", 0, 500)] });
    const r1 = A.carryForwardProfit(s, "2026-01");
    assert.ok(r1.voucher);
    assert.equal(r1.yearEndVoucher, null);
    assert.equal(A.accountBalances(s, "2026-01").get("3103").natural, 500);
    const r2 = A.carryForwardProfit(s, "2026-01", { yearEnd: true });
    assert.ok(r2.yearEndVoucher, "应生成 3103→3104 年末结转");
    assert.equal(z(A.accountBalances(s, "2026-01").get("3103").natural), 0);
    assert.equal(A.accountBalances(s, "2026-01").get("3104").natural, 500);
  });

  await test("年末结转：本期无损益但 3103 有余额也可年末结转", () => {
    const s = newSet("结转-无损益年末");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 200, 0), entry("5001", 0, 200)] });
    A.carryForwardProfit(s, "2026-01");
    assert.equal(A.accountBalances(s, "2026-01").get("3103").natural, 200);
    const r = A.carryForwardProfit(s, "2026-02", { yearEnd: true });
    assert.equal(r.voucher, null, "2026-02 无损益，不应生成损益结转凭证");
    assert.ok(r.yearEndVoucher, "应仅做年末结转");
    assert.equal(z(A.accountBalances(s, "2026-02").get("3103").natural), 0);
    assert.equal(A.accountBalances(s, "2026-02").get("3104").natural, 200);
  });

  await test("重复结转：损益与年末均拒绝重复入账", async () => {
    const s = newSet("结转-防重复");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 100, 0), entry("5001", 0, 100)] });
    A.carryForwardProfit(s, "2026-01", { yearEnd: true });
    await rejects(() => A.carryForwardProfit(s, "2026-01"), /already_carried_forward/);
    await rejects(() => A.carryForwardProfit(s, "2026-01", { yearEnd: true }), /already_year_end_carried/);
    assert.equal(carryVouchers(s, "2026-01").length, 2, "只应存在损益 + 年末两张结转凭证");
  });

  await test("反过账：结转凭证反过账后可重算且不残留草稿", () => {
    const s = newSet("结转-反过账重算");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 100, 0), entry("5001", 0, 100)] });
    const r1 = A.carryForwardProfit(s, "2026-01");
    A.unpostVoucher(s, r1.voucher.id);
    assert.equal(carryVouchers(s, "2026-01").length, 1);
    assert.equal(carryVouchers(s, "2026-01")[0].status, "draft");
    const r2 = A.carryForwardProfit(s, "2026-01");
    assert.ok(r2.voucher);
    assert.notEqual(r2.voucher.id, r1.voucher.id);
    const carry = carryVouchers(s, "2026-01");
    assert.equal(carry.length, 1, "旧草稿应被清理，不应残留");
    assert.equal(carry[0].status, "posted");
    assert.equal(z(A.accountBalances(s, "2026-01").get("5001").natural), 0);
  });

  await test("删除：结转草稿删除后可重新结转", () => {
    const s = newSet("结转-删除重算");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 100, 0), entry("5001", 0, 100)] });
    const r1 = A.carryForwardProfit(s, "2026-01");
    A.unpostVoucher(s, r1.voucher.id);
    A.deleteVoucher(s, r1.voucher.id);
    assert.equal(carryVouchers(s, "2026-01").length, 0);
    const r2 = A.carryForwardProfit(s, "2026-01");
    assert.ok(r2.voucher);
    assert.equal(carryVouchers(s, "2026-01").length, 1);
    assert.equal(z(A.accountBalances(s, "2026-01").get("5001").natural), 0);
  });

  await test("年末结转反过账后也可重算", () => {
    const s = newSet("结转-年末反过账");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 300, 0), entry("5001", 0, 300)] });
    const r1 = A.carryForwardProfit(s, "2026-01", { yearEnd: true });
    A.unpostVoucher(s, r1.yearEndVoucher.id);
    assert.equal(A.accountBalances(s, "2026-01").get("3103").natural, 300, "反过账后 3103 恢复");
    const r2 = A.carryForwardProfit(s, "2026-01", { yearEnd: true });
    assert.ok(r2.yearEndVoucher);
    assert.equal(carryVouchers(s, "2026-01").length, 2);
    assert.equal(z(A.accountBalances(s, "2026-01").get("3103").natural), 0);
  });

  await test("原子性：年末结转失败时损益结转一并回滚", async () => {
    const s = newSet("结转-原子性");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 300, 0), entry("5001", 0, 300)] });
    const original = db.prepare.bind(db);
    let n = 0;
    db.prepare = (sql) => {
      if (/INSERT INTO vouchers\b/.test(sql)) { n++; if (n === 2) throw new Error("inject_year_end_fail"); }
      return original(sql);
    };
    try {
      await rejects(() => A.carryForwardProfit(s, "2026-01", { yearEnd: true }), /inject_year_end_fail/);
    } finally {
      db.prepare = original;
    }
    assert.equal(carryVouchers(s, "2026-01").length, 0, "失败后不应残留任何结转凭证");
    assert.equal(A.accountBalances(s, "2026-01").get("5001").natural, 300, "损益不应被部分结转");
  });

  await test("年末结转：3103 下级明细并入 3103→3104，不静默只取根余额", () => {
    const s = newSet("结转-3103明细");
    A.addAccount(s, { code: "310301", name: "本年利润-明细", category: "权益", direction: "credit" });
    // 直接形成 3103 根 + 下级明细余额（模拟手工结转 / 上年遗留）。
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 40, 0), entry("3103", 0, 40)] });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 60, 0), entry("310301", 0, 60)] });
    assert.equal(bsLine(A.balanceSheet(s, "2026-01"), "未分配利润"), 100);

    const r = A.carryForwardProfit(s, "2026-01", { yearEnd: true });
    assert.equal(r.voucher, null, "本期无损益，不应生成损益结转凭证");
    assert.ok(r.yearEndVoucher, "应生成 3103→3104 年末结转");
    assert.deepEqual(
      r.yearEndVoucher.entries.map((e) => e.code).sort(),
      ["3103", "310301", "3104"],
      "根与明细都应转出到 3104"
    );
    const bal = A.accountBalances(s, "2026-01");
    assert.equal(z(bal.get("3103").natural), 0);
    assert.equal(z(bal.get("310301").natural), 0);
    assert.equal(bal.get("3104").natural, 100);
    const bs = A.balanceSheet(s, "2026-01");
    assert.equal(bsLine(bs, "未分配利润"), 100, "与资产负债表 3103 前缀归集口径一致");
    assert.equal(bs.balanced, true);
  });

  await test("结转：ensurePeriod 纳入保存点，失败不留下新期间", async () => {
    const s = newSet("结转-期间回滚");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [entry("1002", 300, 0), entry("5001", 0, 300)] });
    A.carryForwardProfit(s, "2026-01");
    assert.ok(!A.listPeriods(s).some((p) => p.period === "2026-02"), "前置：2026-02 尚未登记");
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/INSERT INTO vouchers\b/.test(sql)) throw new Error("inject_period_fail");
      return original(sql);
    };
    try {
      await rejects(() => A.carryForwardProfit(s, "2026-02", { yearEnd: true }), /inject_period_fail/);
    } finally {
      db.prepare = original;
    }
    assert.ok(!A.listPeriods(s).some((p) => p.period === "2026-02"), "失败后不应留下 2026-02 期间");
    // 恢复后仍可正常结转并登记期间，确认不是永久阻塞。
    const r = A.carryForwardProfit(s, "2026-02", { yearEnd: true });
    assert.ok(r.yearEndVoucher);
    assert.ok(A.listPeriods(s).some((p) => p.period === "2026-02"));
  });

  // ================================================================ 3. 折旧状态一致性
  const mkCard = (s, over = {}) => A.addAssetCard(s, {
    kind: "fixed", name: "办公设备", original_cost: 60000,
    residual_rate: 0.05, useful_life_months: 60, start_period: "2026-01", ...over,
  });

  await test("折旧：计提后卡片累计与总账余额一致", () => {
    const s = newSet("折旧-勾稽");
    mkCard(s);
    const r = A.generateDepreciation(s, "2026-01");
    assert.ok(r.voucher);
    assert.equal(r.voucher.kind, "depreciation");
    assert.equal(r.voucher.total_debit, 950);
    assert.equal(r.runs.length, 1);
    const card = A.listAssetCards(s)[0];
    assert.equal(card.accumulated, 950);
    assert.equal(A.accountBalances(s, "2026-01").get("1602").natural, 950);
  });

  await test("折旧：同期间重复计提幂等（不重复入账）", () => {
    const s = newSet("折旧-幂等");
    mkCard(s);
    A.generateDepreciation(s, "2026-01");
    const r2 = A.generateDepreciation(s, "2026-01");
    assert.equal(r2.voucher, null);
    assert.equal(depVouchers(s, "2026-01").length, 1);
    assert.equal(A.listDepreciationRuns(s, { period: "2026-01" }).length, 1);
  });

  await test("折旧：反过账后累计仅计已过账，重新过账恢复", () => {
    const s = newSet("折旧-反过账");
    mkCard(s);
    const r = A.generateDepreciation(s, "2026-01");
    A.unpostVoucher(s, r.voucher.id);
    assert.equal(A.listAssetCards(s)[0].accumulated, 0);
    assert.equal(z(A.accountBalances(s, "2026-01").get("1602").natural), 0);
    A.postVoucher(s, r.voucher.id);
    assert.equal(A.listAssetCards(s)[0].accumulated, 950);
    assert.equal(A.accountBalances(s, "2026-01").get("1602").natural, 950);
  });

  await test("折旧：残留草稿时明确拒绝重计提，不谎报成功", async () => {
    const s = newSet("折旧-残留草稿");
    mkCard(s);
    const r = A.generateDepreciation(s, "2026-01");
    A.unpostVoucher(s, r.voucher.id);
    await rejects(() => A.generateDepreciation(s, "2026-01"), /depreciation_draft_exists/);
    assert.equal(depVouchers(s, "2026-01").length, 1, "不应新增凭证");
    assert.equal(A.listDepreciationRuns(s, { period: "2026-01" }).length, 1, "不应新增 runs");
  });

  await test("折旧：删除草稿清理 runs，同期间可重新计提", () => {
    const s = newSet("折旧-删除重提");
    mkCard(s);
    const r = A.generateDepreciation(s, "2026-01");
    A.unpostVoucher(s, r.voucher.id);
    A.deleteVoucher(s, r.voucher.id);
    assert.equal(A.listDepreciationRuns(s, { period: "2026-01" }).length, 0, "删除草稿须清理 runs");
    const r2 = A.generateDepreciation(s, "2026-01");
    assert.ok(r2.voucher);
    assert.equal(r2.runs[0].amount, 950);
    assert.equal(A.listAssetCards(s)[0].accumulated, 950);
  });

  await test("折旧：删除已过账凭证被拒绝（须先反过账）", async () => {
    const s = newSet("折旧-过账删除");
    mkCard(s);
    const r = A.generateDepreciation(s, "2026-01");
    await rejects(() => A.deleteVoucher(s, r.voucher.id), /posted_voucher_requires_unpost/);
    assert.equal(A.listDepreciationRuns(s, { period: "2026-01" }).length, 1);
  });

  await test("折旧：凭证+runs 原子写入，失败不部分落库", async () => {
    const s = newSet("折旧-原子性");
    mkCard(s);
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/INSERT INTO asset_depreciation_runs/.test(sql)) throw new Error("inject_run_fail");
      return original(sql);
    };
    try {
      await rejects(() => A.generateDepreciation(s, "2026-01"), /inject_run_fail/);
    } finally {
      db.prepare = original;
    }
    assert.equal(A.listVouchers(s, { period: "2026-01" }).length, 0, "失败后不应残留凭证");
    assert.equal(A.listDepreciationRuns(s, { period: "2026-01" }).length, 0, "失败后不应残留 runs");
    const r = A.generateDepreciation(s, "2026-01");
    assert.ok(r.voucher, "回滚后可正常计提");
  });

  await test("折旧：累计舍入在寿命内恰好提足（1000 元 / 3 期 = 333.33 + 333.33 + 333.34）", () => {
    // 手算：1000.00 ÷ 3 = 333.333…，按分向下取整得 333.33，
    // 余额 1000.00 − 333.33 × 2 = 333.34 落在最后一期；3 期合计恰好 1000.00。
    const s = newSet("折旧-尾差");
    const card = mkCard(s, { original_cost: 1000, residual_rate: 0, useful_life_months: 3 });
    assert.equal(card.depreciable, 1000);
    assert.equal(card.monthly, 333.33, "月额按分向下取整");
    assert.equal(card.final_month, 333.34, "余额落在最后一期");
    const amounts = ["2026-01", "2026-02", "2026-03"]
      .map((p) => A.generateDepreciation(s, p).voucher.total_debit);
    assert.deepEqual(amounts, [333.33, 333.33, 333.34]);
    assert.equal(A.listAssetCards(s)[0].accumulated, 1000, "第 3 期累计恰好等于可折旧额");
    assert.equal(A.accountBalances(s, "2026-03").get("1602").natural, 1000);
    // 寿命已满：不得再提，也不能把余额推到寿命之外。
    const r4 = A.generateDepreciation(s, "2026-04");
    assert.equal(r4.voucher, null, "不得提前多提或延后补差");
    assert.equal(A.listAssetCards(s)[0].remaining, 0);
    assert.equal(A.accountBalances(s, "2026-04").get("1602").natural, 1000);
  });

  await test("折旧：unpost旧期 + 补项期初累计后重过账被拒绝（原复现回归）", async () => {
    const s = newSet("折旧-原复现");
    const card = mkCard(s, { original_cost: 100, residual_rate: 0, useful_life_months: 3 });
    // 补项：显式登记历史已入账累计 40 元（导入旧账的累计折旧）。
    // LOCAL-02：已有已过账计提后不允许再改期初累计（会静默改变已提金额），因此补项在计提前完成。
    A.updateAssetCard(s, card.id, { opening_accumulated: 40 });
    const jan = A.generateDepreciation(s, "2026-01");
    assert.equal(jan.voucher.total_debit, 33.33);
    A.unpostVoucher(s, jan.voucher.id);
    assert.equal(A.listAssetCards(s)[0].accumulated, 40);
    const feb = A.generateDepreciation(s, "2026-02");
    assert.ok(feb.voucher, "2 月按分期表独立计提，不受一月反过账影响");
    assert.equal(feb.voucher.total_debit, 33.33);

    const err = await rejects(() => A.postVoucher(s, jan.voucher.id), /depreciation_exceeds_depreciable/);
    assert.equal(err.details.posted, 33.33);
    assert.equal(err.details.posting, 33.33);
    assert.equal(err.details.depreciable, 100);

    const after = A.listAssetCards(s)[0];
    assert.equal(after.accumulated, 73.33, "40 期初 + 33.33 二月");
    assert.equal(after.depreciable, 100);
    assert.equal(after.remaining, 26.67);
    assert.equal(z(A.accountBalances(s, "2026-02").get("1602").natural), 33.33);
    assert.equal(A.getVoucher(s, jan.voucher.id).status, "draft", "一月旧凭证应保持草稿");
    assert.equal(A.getVoucher(s, feb.voucher.id).status, "posted");
  });

  await test("折旧：正常未超额跨期恢复允许重新过账（按倒序撤销后期计提）", () => {
    const s = newSet("折旧-跨期恢复");
    mkCard(s, { original_cost: 300, residual_rate: 0, useful_life_months: 3 });
    const jan = A.generateDepreciation(s, "2026-01");
    const feb = A.generateDepreciation(s, "2026-02");
    assert.equal(A.listAssetCards(s)[0].accumulated, 200);
    // LOCAL-02：后期已有已过账计提时，前期计提已构成后期依赖 → 必须按倒序先撤销后期。
    assert.throws(() => A.unpostVoucher(s, jan.voucher.id), /later_depreciation_depends_on_period/);
    A.unpostVoucher(s, feb.voucher.id);
    A.unpostVoucher(s, jan.voucher.id);
    assert.equal(A.listAssetCards(s)[0].accumulated, 0);
    // 其他已过账(二月)100 + 一月 100 = 200 <= 可折旧额 300，允许按期间顺序恢复。
    assert.equal(A.postVoucher(s, jan.voucher.id).status, "posted");
    assert.equal(A.postVoucher(s, feb.voucher.id).status, "posted");
    const card = A.listAssetCards(s)[0];
    assert.equal(card.accumulated, 200);
    assert.equal(card.remaining, 100);
    assert.equal(A.accountBalances(s, "2026-02").get("1602").natural, 200);
  });

  await test("折旧：重新过账失败后账簿与卡片保持不变（无部分过账）", async () => {
    const s = newSet("折旧-失败不变");
    const card = mkCard(s, { original_cost: 100, residual_rate: 0, useful_life_months: 3 });
    // 补项在计提前完成（已有已过账计提后不允许改期初累计）。
    A.updateAssetCard(s, card.id, { opening_accumulated: 40 });
    const jan = A.generateDepreciation(s, "2026-01");
    A.unpostVoucher(s, jan.voucher.id);
    A.generateDepreciation(s, "2026-02");

    const card0 = A.listAssetCards(s)[0];
    const card0Snap = { accumulated: card0.accumulated, remaining: card0.remaining, months_done: card0.months_done };
    const runs0 = A.listDepreciationRuns(s).map((r) => `${r.asset_id}:${r.period}:${r.amount}:${r.voucher_id}`).sort();
    const tb0 = A.trialBalance(s, "2026-02").totals;
    const jan0 = A.getVoucher(s, jan.voucher.id).status;
    const dep0 = depVouchers(s, "2026-02").map((v) => v.status).sort();

    await rejects(() => A.postVoucher(s, jan.voucher.id), /depreciation_exceeds_depreciable/);

    const card1 = A.listAssetCards(s)[0];
    assert.deepEqual(
      { accumulated: card1.accumulated, remaining: card1.remaining, months_done: card1.months_done },
      card0Snap
    );
    assert.deepEqual(A.listDepreciationRuns(s).map((r) => `${r.asset_id}:${r.period}:${r.amount}:${r.voucher_id}`).sort(), runs0);
    assert.deepEqual(A.trialBalance(s, "2026-02").totals, tb0);
    assert.equal(A.getVoucher(s, jan.voucher.id).status, jan0);
    assert.deepEqual(depVouchers(s, "2026-02").map((v) => v.status).sort(), dep0);
  });

  await test("折旧：删除被拒旧草稿后可合法重算，不永久阻塞", async () => {
    const s = newSet("折旧-拒绝后重算");
    const card = mkCard(s, { original_cost: 100, residual_rate: 0, useful_life_months: 3 });
    // 补项在计提前完成（已有已过账计提后不允许改期初累计）。
    A.updateAssetCard(s, card.id, { opening_accumulated: 40 });
    const jan = A.generateDepreciation(s, "2026-01");
    A.unpostVoucher(s, jan.voucher.id);
    A.generateDepreciation(s, "2026-02");
    await rejects(() => A.postVoucher(s, jan.voucher.id), /depreciation_exceeds_depreciable/);
    A.deleteVoucher(s, jan.voucher.id);
    assert.equal(A.listDepreciationRuns(s, { period: "2026-01" }).length, 0, "删除草稿应清理 runs");
    assert.equal(A.listAssetCards(s)[0].accumulated, 73.33);
    // 3 月按剩余额提足：100 − 73.33 = 26.67，累计恰好 100（40 期初 + 33.33 + 26.67）。
    const mar = A.generateDepreciation(s, "2026-03");
    assert.equal(mar.voucher.total_debit, 26.67);
    assert.equal(A.listAssetCards(s)[0].accumulated, 100);
    assert.equal(A.listAssetCards(s)[0].remaining, 0);
    assert.equal(z(A.accountBalances(s, "2026-03").get("1602").natural), 60);
  });

  // ================================================================ 4. 期初负数舍入前校验
  await test("期初：-0.001 在舍入前即被拒绝（不被 round2 吞掉）", async () => {
    const s = newSet("期初-微负");
    await rejects(() => A.setOpeningBalances(s, [entry("1002", -0.001, 0)]), /opening_amount_invalid:1002/);
    await rejects(() => A.setOpeningBalances(s, [entry("1002", 0, -0.001)]), /opening_amount_invalid:1002/);
    assert.equal(A.getOpeningBalances(s).length, 0, "拒绝后不应落库");
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e);
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* ignore */ }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}
