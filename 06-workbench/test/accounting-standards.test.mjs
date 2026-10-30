#!/usr/bin/env node
// 固定的合成测试身份，不依赖显示名及生产默认值。
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-accounting-standards-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
/**
 * LOCAL-03a B1 真实领域验收：双准则建账 / 导入 / 过账 / 期末检查 / 结转 / 封账 / 报表 / 迁移兼容。
 *
 * 所有金额预期均为独立手算字面量（不使用被测 helper 生成 expected）；全部合成临时库，
 * 不连接真实账套、税局、旧后端或凭据。
 *
 * 运行：node test/accounting-standards.test.mjs（cwd = 06-workbench）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dataDir = mkdtempSync(join(tmpdir(), "wb-standards-"));
process.env.WORKBENCH_DATA_DIR = dataDir;

let db, A, IM;
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
};
const rejectsCode = async (fn, code) => {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, `应抛出 ${code}，但未抛出`);
  assert.equal(error.code, code, `期望 ${code}，实际 ${error.code || error.message}`);
  return error;
};
const e = (code, debit = 0, credit = 0) => ({ code, debit, credit });
const create = (name, standard, start = "2026-01") =>
  identityFixtureCreate(A, { name, accounting_standard: standard, start_period: start }).id;
const post = (setId, period, entries, extra = {}) =>
  A.createVoucher(setId, { period, status: "posted", entries, ...extra });
const line = (report, label) => [...report.assets, ...report.liabilities].find((row) => row.label === label)?.value;
const stepOf = (check, id) => check.steps.find((step) => step.id === id);
const codes = (check) => check.blocking.map((item) => item.code);

// ---------------------------------------------------------------- 两准则连续三个月验收数据
const SMALL = "小企业会计准则";
const ENTERPRISE = "企业会计准则";
const SMALL_SOURCE = { system: "local-book", enterpriseKey: "91350000SMALL0001X", enterpriseName: "合成小企" };
const ENTERPRISE_SOURCE = { system: "local-book", enterpriseKey: "91350000ENT00001Y", enterpriseName: "合成企业" };

const SMALL_OPENINGS = [e("1002", 10000), e("1405", 2000), e("3001", 0, 12000)];
const ENTERPRISE_OPENINGS = [e("1002", 20000), e("1405", 3000), e("5001", 1000), e("4001", 0, 24000)];

const smallMonths = {
  "2025-11": [
    [e("1002", 3000), e("5001", 0, 3000)],
    [e("5401", 1200), e("1405", 0, 1200)],
    [e("5602", 200), e("1002", 0, 200)],
  ],
  "2025-12": [
    [e("1122", 1500), e("5001", 0, 1500)],
    [e("5401", 600), e("1405", 0, 600)],
    [e("1002", 1000), e("1122", 0, 1000)],
    [e("5602", 100), e("1002", 0, 100)],
  ],
  "2026-01": [
    [e("1002", 500), e("1122", 0, 500)],
    [e("1405", 800), e("1002", 0, 800)],
    [e("1002", 1200), e("5001", 0, 1200)],
    [e("5401", 500), e("1405", 0, 500)],
    [e("5602", 100), e("1002", 0, 100)],
  ],
};

const enterpriseMonths = {
  "2025-11": [
    [e("1002", 5000), e("6001", 0, 5000)],
    [e("6401", 2000), e("1405", 0, 2000)],
    [e("6602", 500), e("1002", 0, 500)],
  ],
  "2025-12": [
    [e("1122", 2400), e("6001", 0, 2400)],
    [e("6401", 900), e("1405", 0, 900)],
    [e("1002", 1600), e("1122", 0, 1600)],
    [e("6602", 200), e("1002", 0, 200)],
  ],
  "2026-01": [
    [e("1002", 800), e("1122", 0, 800)],
    [e("1405", 1500), e("1002", 0, 1500)],
    [e("1002", 2000), e("6001", 0, 2000)],
    [e("6401", 1000), e("1405", 0, 1000)],
    [e("6602", 300), e("1002", 0, 300)],
  ],
};

// 表格中的独立手算预期（元）。
const SMALL_EXPECT = {
  "2025-11": { revenue: 3000, profit: 1600, ytdProfit: 1600, cash: 12800, receivable: 0, inventory: 800, total: 13600, operating: 2800 },
  "2025-12": { revenue: 1500, profit: 800, ytdProfit: 2400, cash: 13700, receivable: 500, inventory: 200, total: 14400, operating: 900 },
  "2026-01": { revenue: 1200, profit: 600, ytdProfit: 600, cash: 14500, receivable: 0, inventory: 500, total: 15000, operating: 800 },
};
const ENTERPRISE_EXPECT = {
  "2025-11": { revenue: 5000, profit: 2500, ytdProfit: 2500, cash: 24500, receivable: 0, inventory: 2000, total: 26500, operating: 4500 },
  "2025-12": { revenue: 2400, profit: 1300, ytdProfit: 3800, cash: 25900, receivable: 800, inventory: 1100, total: 27800, operating: 1400 },
  "2026-01": { revenue: 2000, profit: 700, ytdProfit: 700, cash: 26900, receivable: 0, inventory: 1600, total: 28500, operating: 1000 },
};

const assertMonth = (setId, period, expected, { checkReady = true } = {}) => {
  const bs = A.balanceSheet(setId, period);
  const is = A.incomeStatement(setId, period);
  const cf = A.cashFlowStatement(setId, period);
  assert.equal(is.current["营业收入"], expected.revenue, `${period} 营业收入`);
  assert.equal(is.current["净利润"], expected.profit, `${period} 本期净利`);
  assert.equal(is.ytd["净利润"], expected.ytdProfit, `${period} 本年净利累计`);
  assert.equal(line(bs, "货币资金"), expected.cash, `${period} 银行期末`);
  assert.equal(line(bs, "应收账款"), expected.receivable, `${period} 应收`);
  assert.equal(line(bs, "存货"), expected.inventory, `${period} 存货（含在产品）`);
  assert.equal(bs.totals.assets, expected.total, `${period} 资产总额`);
  assert.equal(bs.totals.assets, bs.totals.liabilities + bs.totals.equity, `${period} 资产=负债+权益`);
  assert.equal(cf.totals.operating, expected.operating, `${period} 经营现金净额`);
  assert.equal(cf.reconciles, true, `${period} 现金流勾稽`);
  assert.equal(cf.classificationComplete, true, `${period} 现金流分类完整`);
  assert.equal(bs.reportStatus.status, "complete", `${period} 资产负债表范围完整`);
  assert.equal(bs.reportStatus.complete, true);
  assert.equal(bs.reportStatus.partialValues, false);
  assert.equal(is.reportStatus.complete, true, `${period} 利润表范围完整`);
  if (checkReady) {
    const check = A.periodEndCheck(setId, period);
    assert.equal(check.ready, true, `${period} 期末检查：${JSON.stringify(codes(check))}`);
    assert.equal(check.accountingContext.legacy, false);
    assert.ok(check.rules.profitAccount);
    assert.ok(check.rules.retainedEarningsAccount);
    assert.ok(check.rules.defaultDepreciationExpense);
  }
  return { bs, is, cf };
};

try {
  ({ db } = await import("../server/db.mjs"));
  A = await import("../server/accounting.mjs");
  IM = await import("../server/import-incremental.mjs");

  console.log("\nLOCAL-03a B1 真实领域验收\n");

  // ================================================================ 1. 两准则连续三个月
  let smallId, enterpriseId;
  await test("建账：两准则各自持久 profile、科目表、首期间，profile 与准则一致", () => {
    smallId = create("合成小企账套", SMALL, "2025-11");
    enterpriseId = create("合成企业账套", ENTERPRISE, "2025-11");
    const small = A.getAccountSet(smallId);
    const enterprise = A.getAccountSet(enterpriseId);
    assert.equal(small.accountingContext.profileId, "small-2011-basic-v1");
    assert.equal(small.accountingContext.declaredStandard, SMALL);
    assert.equal(small.accountingContext.legacy, false);
    assert.equal(enterprise.accountingContext.profileId, "enterprise-2019-general-basic-v1");
    assert.equal(enterprise.accountingContext.declaredStandard, ENTERPRISE);
    assert.equal(enterprise.accountingContext.legacy, false);
    const smallCodes = A.listAccounts(smallId).map((a) => a.code);
    const enterpriseCodes = A.listAccounts(enterpriseId).map((a) => a.code);
    assert.ok(smallCodes.includes("5001") && smallCodes.includes("3103"));
    assert.ok(enterpriseCodes.includes("6001") && enterpriseCodes.includes("4103"));
    assert.ok(!smallCodes.includes("6001"));
    // 同码不同义：两 profile 的 4001 / 5001 语义不同，不是运行时按名称猜。
    assert.equal(A.listAccounts(smallId).find((a) => a.code === "4001").category, "成本");
    assert.equal(A.listAccounts(enterpriseId).find((a) => a.code === "4001").category, "权益");
    assert.equal(A.listAccounts(smallId).find((a) => a.code === "5001").category, "损益");
    assert.equal(A.listAccounts(enterpriseId).find((a) => a.code === "5001").category, "成本");
  });

  await test("连续三个月：2025-11 / 2025-12 / 2026-01 全部手算金额、结转、年末与次年", () => {
    A.setOpeningBalances(smallId, SMALL_OPENINGS);
    A.setOpeningBalances(enterpriseId, ENTERPRISE_OPENINGS);
    for (const entries of smallMonths["2025-11"]) post(smallId, "2025-11", entries);
    for (const entries of enterpriseMonths["2025-11"]) post(enterpriseId, "2025-11", entries);

    // 2025-11：结转前先核对净利 / 净资产，再结转（结转不改变利润表发生额与净资产）。
    const smallNovBefore = assertMonth(smallId, "2025-11", SMALL_EXPECT["2025-11"], { checkReady: false });
    const enterpriseNovBefore = assertMonth(enterpriseId, "2025-11", ENTERPRISE_EXPECT["2025-11"], { checkReady: false });
    assert.ok(codes(A.periodEndCheck(smallId, "2025-11")).includes("profit_not_carried_forward"));
    assert.equal(stepOf(A.periodEndCheck(smallId, "2025-11"), "depreciation").status, "not_applicable");
    A.carryForwardProfit(smallId, "2025-11");
    A.carryForwardProfit(enterpriseId, "2025-11");
    const smallNovAfter = assertMonth(smallId, "2025-11", SMALL_EXPECT["2025-11"]);
    const enterpriseNovAfter = assertMonth(enterpriseId, "2025-11", ENTERPRISE_EXPECT["2025-11"]);
    assert.equal(smallNovAfter.bs.totals.equity, smallNovBefore.bs.totals.equity);
    assert.equal(smallNovAfter.is.current["净利润"], smallNovBefore.is.current["净利润"]);
    assert.equal(enterpriseNovAfter.bs.totals.equity, enterpriseNovBefore.bs.totals.equity);
    assert.equal(enterpriseNovAfter.is.current["净利润"], enterpriseNovBefore.is.current["净利润"]);
    A.setPeriodStatus(smallId, "2025-11", "closed");
    A.setPeriodStatus(enterpriseId, "2025-11", "closed");

    // 2025-12
    for (const entries of smallMonths["2025-12"]) post(smallId, "2025-12", entries);
    for (const entries of enterpriseMonths["2025-12"]) post(enterpriseId, "2025-12", entries);
    const smallDecBefore = assertMonth(smallId, "2025-12", SMALL_EXPECT["2025-12"], { checkReady: false });
    A.carryForwardProfit(smallId, "2025-12", { yearEnd: true });
    A.carryForwardProfit(enterpriseId, "2025-12", { yearEnd: true });
    const smallDecAfter = assertMonth(smallId, "2025-12", SMALL_EXPECT["2025-12"]);
    const enterpriseDecAfter = assertMonth(enterpriseId, "2025-12", ENTERPRISE_EXPECT["2025-12"]);
    assert.equal(smallDecAfter.bs.totals.equity, smallDecBefore.bs.totals.equity);
    assert.equal(smallDecAfter.is.current["净利润"], smallDecBefore.is.current["净利润"]);
    assert.equal(enterpriseDecAfter.bs.totals.equity, ENTERPRISE_EXPECT["2025-12"].total);
    // 年末：本年利润清零、利润分配保留全年，净资产与现金不变。
    assert.equal(A.accountBalances(smallId, "2025-12").get("3103").natural, 0);
    assert.equal(A.accountBalances(smallId, "2025-12").get("3104").natural, 2400);
    assert.equal(A.accountBalances(enterpriseId, "2025-12").get("4103").natural, 0);
    assert.equal(A.accountBalances(enterpriseId, "2025-12").get("4104").natural, 3800);
    assert.equal(line(smallDecAfter.bs, "货币资金"), 13700);
    assert.equal(line(enterpriseDecAfter.bs, "货币资金"), 25900);
    A.setPeriodStatus(smallId, "2025-12", "closed");
    A.setPeriodStatus(enterpriseId, "2025-12", "closed");

    // 2026-01：草稿不入报表；结转后本年利润恢复、利润分配保持上年数。
    for (const entries of smallMonths["2026-01"]) post(smallId, "2026-01", entries);
    for (const entries of enterpriseMonths["2026-01"]) post(enterpriseId, "2026-01", entries);
    A.createVoucher(smallId, {
      period: "2026-01", status: "draft",
      entries: [e("1002", 88888), e("5001", 0, 88888)],
    });
    const smallJan = assertMonth(smallId, "2026-01", SMALL_EXPECT["2026-01"], { checkReady: false });
    const enterpriseJan = assertMonth(enterpriseId, "2026-01", ENTERPRISE_EXPECT["2026-01"], { checkReady: false });
    assert.equal(smallJan.is.ytd["营业收入"], 1200);
    assert.equal(enterpriseJan.is.ytd["营业收入"], 2000);
    A.carryForwardProfit(smallId, "2026-01");
    A.carryForwardProfit(enterpriseId, "2026-01");
    assert.equal(A.accountBalances(smallId, "2026-01").get("3103").natural, 600);
    assert.equal(A.accountBalances(smallId, "2026-01").get("3104").natural, 2400);
    assert.equal(A.accountBalances(enterpriseId, "2026-01").get("4103").natural, 700);
    assert.equal(A.accountBalances(enterpriseId, "2026-01").get("4104").natural, 3800);
    // 企业 5001 是在产品（成本），不是收入，也不是本期费用。
    assert.equal(A.accountBalances(enterpriseId, "2026-01").get("5001").natural, 1000);
    assert.equal(line(A.balanceSheet(enterpriseId, "2026-01"), "存货"), 1600);
    assert.equal(A.incomeStatement(enterpriseId, "2026-01").current["营业收入"], 2000);
    // 2025 累计营业收入：小企 4500 / 企业 7400。
    assert.equal(A.incomeStatement(smallId, "2025-12").ytd["营业收入"], 4500);
    assert.equal(A.incomeStatement(enterpriseId, "2025-12").ytd["营业收入"], 7400);
  });

  await test("期末检查 DTO：账面 profile / 角色 / 旧账警告不冒充封账阻塞", () => {
    const smallCheck = A.periodEndCheck(smallId, "2026-01");
    assert.equal(smallCheck.accountingContext.profileId, "small-2011-basic-v1");
    assert.equal(smallCheck.rules.profitAccount, "3103");
    assert.equal(smallCheck.rules.retainedEarningsAccount, "3104");
    assert.equal(smallCheck.rules.defaultDepreciationExpense, "5602");
    const enterpriseCheck = A.periodEndCheck(enterpriseId, "2026-01");
    assert.equal(enterpriseCheck.rules.profitAccount, "4103");
    assert.equal(enterpriseCheck.rules.retainedEarningsAccount, "4104");
    assert.equal(enterpriseCheck.rules.defaultDepreciationExpense, "6602");
    // 原有步骤 / 控制码语义保持
    for (const id of ["draft_vouchers", "trial_balance", "depreciation", "asset_reconciliation",
      "profit_carry_forward", "year_end_carry_forward", "period_sequence"]) {
      assert.ok(smallCheck.steps.some((step) => step.id === id), `缺少步骤 ${id}`);
    }
    assert.equal(smallCheck.warnings.length, 0);
  });

  // ================================================================ 2. 现金流单一对方科目分类
  await test("现金流：两准则资本 / 生产成本分类不同，未分类不伪装", () => {
    const small = create("现金流小企", SMALL);
    post(small, "2026-01", [e("1002", 1000), e("3001", 0, 1000)]);
    assert.equal(A.cashFlowStatement(small, "2026-01").totals.financing, 1000);
    post(small, "2026-01", [e("4001", 100), e("1002", 0, 100)]);
    const smallCf = A.cashFlowStatement(small, "2026-01");
    assert.equal(smallCf.totals.operating, -100);
    assert.equal(smallCf.totals.financing, 1000);

    const enterprise = create("现金流企业", ENTERPRISE);
    post(enterprise, "2026-01", [e("1002", 1000), e("4001", 0, 1000)]);
    assert.equal(A.cashFlowStatement(enterprise, "2026-01").totals.financing, 1000);
    post(enterprise, "2026-01", [e("5001", 100), e("1002", 0, 100)]);
    const enterpriseCf = A.cashFlowStatement(enterprise, "2026-01");
    assert.equal(enterpriseCf.totals.operating, -100, "企业 5001 生产成本属经营支出，不按资本 / 收入误分类");
    assert.equal(enterpriseCf.totals.financing, 1000);

    const inProgress = create("现金流在建工程", SMALL);
    A.setOpeningBalances(inProgress, [e("1002", 500), e("3001", 0, 500)]);
    post(inProgress, "2026-01", [e("1604", 100), e("1002", 0, 100)]);
    const cp = A.cashFlowStatement(inProgress, "2026-01");
    assert.equal(cp.classificationComplete, false);
    assert.ok(cp.unknown.some((item) => item.reason === "construction-in-progress-purpose-ambiguous"));
    assert.ok(cp.reportStatus.diagnostics.some((d) => d.code === "cash_flow_classification_incomplete"));

    const mixed = create("现金流复合凭证", SMALL);
    A.setOpeningBalances(mixed, [e("1002", 500), e("3001", 0, 500)]);
    post(mixed, "2026-01", [e("1403", 120), e("1601", 180), e("1002", 0, 300)]);
    const mixedCf = A.cashFlowStatement(mixed, "2026-01");
    assert.equal(mixedCf.classificationComplete, true);
    assert.deepEqual(mixedCf.totals, { operating: -120, investing: -180, financing: 0, net_increase: -300 });
    assert.deepEqual(mixedCf.cash, { begin: 500, end: 200, change: -300 });
    assert.deepEqual(mixedCf.unknown, []); assert.equal(mixedCf.reconciles, true);
    assert.equal(mixedCf.reportStatus.complete, true);
  });

  // ================================================================ 3. 资产 / 折旧 / 摊销
  await test("资产：两准则 100 元三月卡片 33.33 / 33.33 / 33.34，默认费用科目取 profile", () => {
    for (const [setId, standard, expenseCode] of [
      [create("资产小企", SMALL), SMALL, "5602"],
      [create("资产企业", ENTERPRISE), ENTERPRISE, "6602"],
    ]) {
      A.setOpeningBalances(setId, [e("1601", 100), e(standard === SMALL ? "3001" : "4001", 0, 100)]);
      const card = A.addAssetCard(setId, {
        kind: "fixed", name: "合成设备", original_cost: 100, residual_rate: 0,
        useful_life_months: 3, start_period: "2026-01", acquired_period: "2026-01",
      });
      assert.equal(card.depreciable, 100);
      assert.equal(card.monthly, 33.33);
      assert.equal(card.final_month, 33.34);
      const amounts = ["2026-01", "2026-02", "2026-03"].map((period) => {
        const run = A.generateDepreciation(setId, period);
        assert.ok(run.voucher, `${period} 应计提`);
        assert.ok(run.voucher.entries.some((entry) => entry.code === expenseCode),
          `默认折旧费用必须是 ${expenseCode}`);
        assert.ok(run.voucher.entries.some((entry) => entry.code === "1602"));
        return run.voucher.total_debit;
      });
      assert.deepEqual(amounts, [33.33, 33.33, 33.34]);
      assert.equal(A.listAssetCards(setId)[0].accumulated, 100);
      assert.equal(A.generateDepreciation(setId, "2026-04").voucher, null, "第 4 月不再提");
      // 结转后逐期封账，检查资产 / 累计与总账一致。
      for (const period of ["2026-01", "2026-02", "2026-03"]) {
        A.carryForwardProfit(setId, period);
        assert.equal(A.periodEndCheck(setId, period).ready, true, `${period} ready`);
        A.setPeriodStatus(setId, period, "closed");
      }
    }
  });

  await test("无形资产：默认摊销科目与累计摊销路径，按月恰好摊完", () => {
    for (const [setId, standard, expenseCode] of [
      [create("无形小企", SMALL), SMALL, "5602"],
      [create("无形企业", ENTERPRISE), ENTERPRISE, "6602"],
    ]) {
      A.setOpeningBalances(setId, [e("1701", 120), e(standard === SMALL ? "3001" : "4001", 0, 120)]);
      const card = A.addAssetCard(setId, {
        kind: "intangible", name: "合成软件", original_cost: 120, residual_rate: 0,
        useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01",
      });
      assert.equal(card.monthly, 10);
      const run = A.generateDepreciation(setId, "2026-01");
      assert.ok(run.voucher.entries.some((entry) => entry.code === expenseCode));
      assert.ok(run.voucher.entries.some((entry) => entry.code === "1702"));
      assert.equal(run.voucher.total_debit, 10);
      A.carryForwardProfit(setId, "2026-01");
      assert.equal(A.periodEndCheck(setId, "2026-01").ready, true);
    }
  });

  await test("资产缺失 / 卡片与总账差异 / 缺计提阻止封账；无资产时 not_applicable", async () => {
    const noAsset = create("无资产", SMALL);
    assert.equal(stepOf(A.periodEndCheck(noAsset, "2026-01"), "depreciation").status, "not_applicable");
    assert.equal(stepOf(A.periodEndCheck(noAsset, "2026-01"), "asset_reconciliation").status, "not_applicable");

    const missing = create("缺计提", SMALL);
    A.setOpeningBalances(missing, [e("1601", 100), e("3001", 0, 100)]);
    A.addAssetCard(missing, {
      name: "未提设备", original_cost: 100, residual_rate: 0, useful_life_months: 10,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    const check = A.periodEndCheck(missing, "2026-01");
    assert.equal(stepOf(check, "depreciation").status, "blocked");
    assert.ok(codes(check).includes("depreciation_missing"));
    const error = await rejectsCode(() => A.setPeriodStatus(missing, "2026-01", "closed"), "period_end_check_failed");
    assert.ok(error.details.blocking.some((item) => item.code === "depreciation_missing"));

    const mismatch = create("卡片总账差异", SMALL);
    A.addAssetCard(mismatch, {
      name: "无入账设备", original_cost: 100, residual_rate: 0, useful_life_months: 10,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    const mismatchCheck = A.periodEndCheck(mismatch, "2026-01");
    assert.equal(stepOf(mismatchCheck, "asset_reconciliation").status, "blocked");
    assert.ok(codes(mismatchCheck).some((code) => code === "asset_cost_mismatch" || code === "asset_missing_card"));
  });

  // ================================================================ 4. 反例 / 边界
  await test("合法负列示：小企 2221 借方余额保留在本行并以负号列示，企业同输入明确不完整", () => {
    const small = create("负列示小企", SMALL);
    A.setOpeningBalances(small, [e("1002", 900), e("2221", 100), e("3001", 0, 1000)]);
    const bs = A.balanceSheet(small, "2026-01");
    assert.equal(line(bs, "应交税费"), -100);
    assert.equal(line(bs, "货币资金"), 900);
    assert.equal(bs.totals.assets, 900);
    assert.equal(bs.totals.liabilities, -100);
    assert.equal(bs.totals.equity, 1000);
    assert.equal(bs.balanced, true);
    assert.equal(bs.reportStatus.complete, true);

    const enterprise = create("负列示企业", ENTERPRISE);
    A.setOpeningBalances(enterprise, [e("1002", 900), e("2221", 100), e("4001", 0, 1000)]);
    const enterpriseBs = A.balanceSheet(enterprise, "2026-01");
    assert.equal(enterpriseBs.reportStatus.complete, false);
    assert.ok(enterpriseBs.reportStatus.diagnostics.some(
      (d) => d.code === "report_account_requires_detail" && d.accountCode === "2221",
    ));
  });

  await test("未知非零科目明确不完整；零余额未知科目不阻断；数字明细按根科目归类", () => {
    const setId = create("未知科目", SMALL);
    A.setOpeningBalances(setId, [e("1002", 100), e("3001", 0, 100)]);
    A.addAccount(setId, { code: "9001", name: "自定义资产", category: "资产", direction: "debit" });
    A.addAccount(setId, { code: "560299", name: "管理费用-合成明细", category: "损益", direction: "debit" });
    // 零余额未知科目：不阻断完整。
    assert.equal(A.balanceSheet(setId, "2026-01").reportStatus.complete, true);
    post(setId, "2026-01", [e("9001", 10), e("1002", 0, 10)]);
    post(setId, "2026-01", [e("560299", 5), e("1002", 0, 5)]);
    const bs = A.balanceSheet(setId, "2026-01");
    assert.equal(bs.reportStatus.complete, false);
    assert.ok(bs.reportStatus.diagnostics.some((d) => d.code === "report_account_unmapped" && d.accountCode === "9001"));
    assert.equal(line(bs, "货币资金"), 85, "未知非零科目不丢进其他行");
    const is = A.incomeStatement(setId, "2026-01");
    assert.equal(is.current["管理费用"], 5, "数字明细按根科目归类");
    assert.equal(is.current["其他费用"], 0);
  });

  await test("准则 / profile 错误：非法准则、错配、legacy 新建、同码冲突全部结构化拒绝", async () => {
    assert.equal((await rejectsCode(
      () => identityFixtureCreate(A, { name: "bad", accounting_standard: "企业会计", start_period: "2026-01" }),
      "accounting_standard_invalid",
    )).code, "accounting_standard_invalid");
    assert.equal((await rejectsCode(
      () => identityFixtureCreate(A, { name: "bad", accounting_standard: " 企业会计准则 ", start_period: "2026-01" }),
      "accounting_standard_invalid",
    )).code, "accounting_standard_invalid");
    assert.equal((await rejectsCode(
      () => identityFixtureCreate(A, {
        name: "bad", accounting_standard: SMALL, profileId: "enterprise-2019-general-basic-v1", start_period: "2026-01",
      }),
      "accounting_profile_standard_mismatch",
    )).code, "accounting_profile_standard_mismatch");
    assert.equal((await rejectsCode(
      () => identityFixtureCreate(A, { name: "bad", profileId: "legacy-small-coa-v1", start_period: "2026-01" }),
      "accounting_profile_legacy_not_creatable",
    )).code, "accounting_profile_legacy_not_creatable");

    // 同一编码在目标 profile 中类别不同：append 的科目兼容性必须拒绝，不按名称纠正。
    const enterprise = create("同码冲突", ENTERPRISE);
    const result = IM.importIncremental({
      batchId: "STANDARDS-CONFLICT-1",
      source: { system: "local-book", enterpriseKey: "91350000CONFLICT01X" },
      mode: "append",
      accountSetId: enterprise,
      confirmNewBinding: true,
      dryRun: true,
      payload: {
        account_set: { name: "同码冲突", start_period: "2026-01", accounting_standard: ENTERPRISE },
        accounts: [{ code: "4001", name: "生产成本", category: "成本", direction: "debit" }],
        opening_balances: [],
        vouchers: [],
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "conflict");
    assert.ok(result.conflicts.some((item) => item.code === "account_incompatible" && item.accountCode === "4001"));
  });

  await test("导入：create 按准则选择 profile；append 沿目标科目；非法准则不逃逸成泛 500", async () => {
    const created = IM.importIncremental({
      batchId: "STANDARDS-CREATE-ENT",
      source: ENTERPRISE_SOURCE,
      mode: "create",
      dryRun: false,
      payload: {
        account_set: {
          name: "导入企业账套", taxpayer_type: "一般纳税人",
          accounting_standard: ENTERPRISE, start_period: "2026-01",
        },
        opening_balances: [e("1002", 5000), e("4001", 0, 5000)],
        vouchers: [{
          period: "2026-01", date: "2026-01-10", word: "记", number: 1,
          summary: "企业现金销售", sourceVoucherId: "ENT-SRC-1",
          entries: [e("1002", 2000), e("6001", 0, 2000)],
        }],
      },
    });
    assert.equal(created.ok, true, JSON.stringify(created.errors));
    const set = A.getAccountSet(created.accountSetId);
    assert.equal(set.accountingContext.profileId, "enterprise-2019-general-basic-v1");
    assert.equal(A.incomeStatement(created.accountSetId, "2026-01").current["营业收入"], 2000);

    const appended = IM.importIncremental({
      batchId: "STANDARDS-APPEND-ENT",
      source: ENTERPRISE_SOURCE,
      mode: "append",
      accountSetId: created.accountSetId,
      dryRun: false,
      payload: {
        account_set: { name: "导入企业账套", start_period: "2026-01", accounting_standard: ENTERPRISE },
        vouchers: [{
          period: "2026-01", date: "2026-01-20", word: "记", number: 2,
          summary: "企业现金销售二", sourceVoucherId: "ENT-SRC-2",
          entries: [e("1002", 500), e("6001", 0, 500)],
        }],
      },
    });
    assert.equal(appended.ok, true, JSON.stringify(appended.errors));
    assert.equal(A.incomeStatement(created.accountSetId, "2026-01").current["营业收入"], 2500);
    // 同批重放不重复入账。
    const replay = IM.importIncremental({
      batchId: "STANDARDS-APPEND-ENT",
      source: ENTERPRISE_SOURCE,
      mode: "append",
      accountSetId: created.accountSetId,
      dryRun: false,
      payload: {
        account_set: { name: "导入企业账套", start_period: "2026-01", accounting_standard: ENTERPRISE },
        vouchers: [{
          period: "2026-01", date: "2026-01-20", word: "记", number: 2,
          summary: "企业现金销售二", sourceVoucherId: "ENT-SRC-2",
          entries: [e("1002", 500), e("6001", 0, 500)],
        }],
      },
    });
    assert.equal(replay.status, "idempotent_replay");
    assert.equal(A.listVouchers(created.accountSetId, { period: "2026-01" }).length, 2);

    const invalid = IM.importIncremental({
      batchId: "STANDARDS-BAD-STANDARD",
      source: { system: "local-book", enterpriseKey: "91350000BADSTAND01X" },
      mode: "create",
      dryRun: false,
      payload: {
        account_set: { name: "坏准则", start_period: "2026-01", accounting_standard: "企业会计" },
        opening_balances: [], vouchers: [],
      },
    });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some((message) => message.startsWith("accounting_standard_invalid")));
    assert.equal(invalid.validation.profileError.code, "accounting_standard_invalid");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets WHERE name='坏准则'`).get().n, 0);
  });

  await test("旧 create 批次重放按目标实际 legacy 科目（企业标签 + 旧小企 5001 收入不被新模板拒绝）", async () => {
    const source = { system: "local-book", enterpriseKey: "91350000LEGACY001X", enterpriseName: "旧批次企业" };
    const payload = {
      account_set: {
        name: "旧批次企业账套", taxpayer_type: "小规模纳税人",
        accounting_standard: SMALL, start_period: "2026-01",
      },
      opening_balances: [e("1002", 1000), e("3001", 0, 1000)],
      vouchers: [{
        period: "2026-01", date: "2026-01-08", word: "记", number: 1,
        summary: "旧批次收入", sourceVoucherId: "LEGACY-SRC-1",
        entries: [e("1002", 300), e("5001", 0, 300)],
      }],
    };
    const created = IM.importIncremental({
      batchId: "LEGACY-CREATE-BATCH", source, mode: "create", dryRun: false, payload,
    });
    assert.equal(created.ok, true, JSON.stringify(created.errors));
    // 模拟迁移前“企业标签 + 旧小企 COA”的账套：持久 profile 为 legacy，原标签保留。
    db.prepare(`UPDATE account_sets SET accounting_profile_id='legacy-small-coa-v1', accounting_standard=? WHERE id=?`)
      .run(ENTERPRISE, created.accountSetId);
    assert.equal(A.getAccountSet(created.accountSetId).accountingContext.legacy, true);
    assert.equal(A.getAccountSet(created.accountSetId).accountingContext.declaredStandard, ENTERPRISE);

    const before = {
      sets: db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n,
      vouchers: db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n,
    };
    const replay = IM.importIncremental({
      batchId: "LEGACY-CREATE-BATCH", source, mode: "create", dryRun: false, payload,
    });
    assert.equal(replay.status, "idempotent_replay", JSON.stringify(replay.conflicts));
    assert.equal(replay.ok, true);
    assert.equal(replay.accountSetId, created.accountSetId);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, before.sets);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers`).get().n, before.vouchers);

    const changed = JSON.parse(JSON.stringify(payload));
    changed.vouchers[0].entries[0].debit = 301;
    changed.vouchers[0].entries[1].credit = 301;
    const conflict = IM.importIncremental({
      batchId: "LEGACY-CREATE-BATCH", source, mode: "create", dryRun: false, payload: changed,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, "conflict");
    assert.ok(conflict.conflicts.some((item) => item.code === "batch_content_changed"));

    // 旧账套 append：payload 准则标签不改 profile；5001 收入仍合法。
    const append = IM.importIncremental({
      batchId: "LEGACY-APPEND-BATCH", source, mode: "append", accountSetId: created.accountSetId, dryRun: false,
      payload: {
        account_set: { name: "旧批次企业账套", start_period: "2026-01", accounting_standard: ENTERPRISE },
        vouchers: [{
          period: "2026-02", date: "2026-02-10", word: "记", number: 1,
          summary: "旧账套追加收入", sourceVoucherId: "LEGACY-SRC-2",
          entries: [e("1002", 200), e("5001", 0, 200)],
        }],
      },
    });
    assert.equal(append.ok, true, JSON.stringify(append.errors));
    assert.equal(A.getAccountSet(created.accountSetId).accountingContext.legacy, true);
    assert.equal(A.incomeStatement(created.accountSetId, "2026-02").current["营业收入"], 200);

    // legacy 报表走真实兼容路径并给固定诊断，不冒充新规则完成。
    const legacyBs = A.balanceSheet(created.accountSetId, "2026-01");
    assert.equal(legacyBs.reportStatus.status, "legacy_compatibility");
    assert.equal(legacyBs.reportStatus.complete, false);
    assert.equal(legacyBs.reportStatus.diagnostics[0].code, "legacy_profile_compatibility");
    assert.equal(line(legacyBs, "货币资金"), 1300);
    assert.equal(legacyBs.totals.assets, 1300);
    const legacyIs = A.incomeStatement(created.accountSetId, "2026-01");
    assert.equal(legacyIs.reportStatus.status, "legacy_compatibility");
    assert.equal(legacyIs.current["净利润"], 300);
    const legacyCheck = A.periodEndCheck(created.accountSetId, "2026-01");
    assert.ok(legacyCheck.warnings.some((warning) => warning.code === "legacy_profile_compatibility"));
    // legacy 警告不自动变成封账阻塞（结转后仍可封账）。
    A.carryForwardProfit(created.accountSetId, "2026-01");
    assert.equal(A.periodEndCheck(created.accountSetId, "2026-01").ready, true);
  });

  await test("后期 4103→4104 年末结转依赖阻止前期修改 / 反操作（企业角色）", async () => {
    const setId = create("企业期间依赖", ENTERPRISE, "2026-01");
    post(setId, "2026-01", [e("1002", 100), e("6001", 0, 100)]);
    A.carryForwardProfit(setId, "2026-01");
    post(setId, "2026-02", [e("1002", 200), e("6001", 0, 200)]);
    A.carryForwardProfit(setId, "2026-02", { yearEnd: true });
    assert.equal(A.accountBalances(setId, "2026-02").get("4103").natural, 0);
    assert.equal(A.accountBalances(setId, "2026-02").get("4104").natural, 300);

    const janVoucher = A.listVouchers(setId, { period: "2026-01" }).find((voucher) => voucher.kind === "normal");
    await rejectsCode(
      () => A.createVoucher(setId, {
        period: "2026-01", status: "posted", entries: [e("1002", 1), e("6001", 0, 1)],
      }),
      "later_year_end_carryforward_depends_on_period",
    );
    await rejectsCode(() => A.unpostVoucher(setId, janVoucher.id), "later_year_end_carryforward_depends_on_period");
  });

  await test("重复动作：重复计提 / 重复结转不重复入账；数量与金额不变", async () => {
    const setId = create("重复动作", SMALL);
    A.setOpeningBalances(setId, [e("1601", 100), e("3001", 0, 100)]);
    A.addAssetCard(setId, {
      name: "设备", original_cost: 100, residual_rate: 0, useful_life_months: 10,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    A.generateDepreciation(setId, "2026-01");
    assert.equal(A.generateDepreciation(setId, "2026-01").voucher, null);
    post(setId, "2026-01", [e("1002", 10), e("5001", 0, 10)]);
    A.carryForwardProfit(setId, "2026-01");
    let duplicateError = null;
    try { A.carryForwardProfit(setId, "2026-01"); } catch (error) { duplicateError = error; }
    assert.ok(duplicateError);
    assert.match(String(duplicateError.message), /already_carried_forward/);
    assert.equal(A.listVouchers(setId, { period: "2026-01" }).filter((v) => v.kind === "depreciation").length, 1);
    assert.equal(A.listVouchers(setId, { period: "2026-01" }).filter((v) => v.kind === "carryforward").length, 1);
  });

  await test("原子性：建账 / 结转中途失败不留下账套 / 凭证 / 期间", async () => {
    const setsBefore = db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n;
    const originalPrepare = db.prepare.bind(db);
    let injected = false;
    db.prepare = (sql) => {
      if (!injected && /INSERT INTO accounts\b/.test(sql)) {
        injected = true;
        throw new Error("inject_create_accounts_fail");
      }
      return originalPrepare(sql);
    };
    try {
      let injectedError = null;
      try {
        identityFixtureCreate(A, { name: "建账失败", accounting_standard: SMALL, start_period: "2026-01" });
      } catch (error) { injectedError = error; }
      assert.ok(injectedError, "建账失败必须抛出");
      assert.match(String(injectedError.message), /inject_create_accounts_fail/);
    } finally {
      db.prepare = originalPrepare;
    }
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM account_sets`).get().n, setsBefore);

    const setId = create("结转失败", SMALL);
    post(setId, "2026-01", [e("1002", 50), e("5001", 0, 50)]);
    const voucherCount = db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setId).n;
    let carryInjected = false;
    db.prepare = (sql) => {
      if (!carryInjected && /INSERT INTO vouchers\b/.test(sql)) {
        carryInjected = true;
        throw new Error("inject_carry_fail");
      }
      return originalPrepare(sql);
    };
    try {
      let error = null;
      try { A.carryForwardProfit(setId, "2026-01"); } catch (err) { error = err; }
      assert.ok(error, "结转失败必须抛出");
    } finally {
      db.prepare = originalPrepare;
    }
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setId).n, voucherCount);
    assert.equal(A.accountBalances(setId, "2026-01").get("5001").natural, 50);
    // 重试可正常完成，不是永久阻塞。
    assert.ok(A.carryForwardProfit(setId, "2026-01").voucher);
  });

  await test("企业资本公积单独列示，不与实收资本合并", () => {
    const setId = create("资本公积企业", ENTERPRISE);
    A.setOpeningBalances(setId, [e("1002", 100), e("4001", 0, 60), e("4002", 0, 40)]);
    const bs = A.balanceSheet(setId, "2026-01");
    assert.equal(line(bs, "实收资本"), 60);
    assert.equal(line(bs, "资本公积"), 40);
    assert.equal(bs.totals.equity, 100);
    assert.equal(bs.reportStatus.complete, true);
  });

  await test("多企业隔离：同一编码含义不同，报表与余额互不串账", () => {
    const small = create("隔离小企", SMALL);
    const enterprise = create("隔离企业", ENTERPRISE);
    A.setOpeningBalances(small, [e("1002", 100), e("3001", 0, 100)]);
    A.setOpeningBalances(enterprise, [e("1002", 200), e("4001", 0, 200)]);
    assert.equal(A.balanceSheet(small, "2026-01").totals.assets, 100);
    assert.equal(A.balanceSheet(enterprise, "2026-01").totals.assets, 200);
    assert.equal(A.balanceSheet(small, "2026-01").totals.equity, 100);
    assert.equal(A.balanceSheet(enterprise, "2026-01").totals.equity, 200);
  });

  // ================================================================ 5. 独审返修（R1）：角色 / 报表 / 现金流 / 整数分 / profile 回显
  await test("年末结转：410301 方向冲突写前整体拒绝（不重复贷 410301），正常明细仍正确清零", async () => {
    // 正常：权益 / credit 的 410301 → yearEnd 后 410301 = 0、4104 = 100。
    const okSet = create("年末明细正常", ENTERPRISE, "2025-12");
    A.addAccount(okSet, { code: "410301", name: "本年利润-明细", category: "权益", direction: "credit" });
    post(okSet, "2025-12", [e("1002", 100), e("410301", 0, 100)]);
    const okCarry = A.carryForwardProfit(okSet, "2025-12", { yearEnd: true });
    assert.equal(okCarry.yearEndVoucher.total_debit, 100);
    assert.equal(A.accountBalances(okSet, "2025-12").get("410301").natural, 0);
    assert.equal(A.accountBalances(okSet, "2025-12").get("4104").natural, 100);

    // 正常创建的写前校验：类别 / 方向与准则根科目冲突直接拒绝，不落库。
    const writeSet = create("年末明细写前校验", ENTERPRISE);
    await rejectsCode(
      () => A.addAccount(writeSet, { code: "410301", name: "错向明细", category: "权益", direction: "debit" }),
      "account_semantics_conflict",
    );
    await rejectsCode(
      () => A.addAccount(writeSet, { code: "600101", name: "错类收入", category: "资产", direction: "debit" }),
      "account_semantics_conflict",
    );
    assert.ok(!A.listAccounts(writeSet).some((account) => account.code === "410301"));
    assert.ok(!A.listAccounts(writeSet).some((account) => account.code === "600101"));

    // 已有异常数据（旧库 / 手工改库）：参与年末结转前整体拒绝，不产生任何结转残留。
    const badSet = create("年末明细冲突", ENTERPRISE, "2025-12");
    db.prepare(
      `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
       VALUES (?, '410301', '异常本年利润明细', '权益', 'debit', 0, 1)`,
    ).run(badSet);
    post(badSet, "2025-12", [e("1002", 100), e("410301", 0, 100)]);
    assert.equal(A.accountBalances(badSet, "2025-12").get("410301").natural, -100);
    const error = await rejectsCode(
      () => A.carryForwardProfit(badSet, "2025-12", { yearEnd: true }),
      "carryforward_account_semantics_conflict",
    );
    assert.deepEqual(
      error.details.conflicts.map((item) => [item.stage, item.accountCode, item.reason]),
      [["year-end", "410301", "direction-conflict"]],
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND kind='carryforward'`).get(badSet).n,
      0,
      "拒绝时不得留下任何结转凭证",
    );
    assert.equal(A.accountBalances(badSet, "2025-12").get("410301").natural, -100, "不得再贷一次变成 -200");
    assert.equal(A.accountBalances(badSet, "2025-12").get("4104").natural, 0);
    // 期末检查同口径：冲突时不再谎称只剩“年末未结转”这一个提示。
    await rejectsCode(() => A.periodEndCheck(badSet, "2025-12"), "carryforward_account_semantics_conflict");
  });

  await test("利润表：类别冲突的非零收入不被 category 预过滤丢弃，明确不完整且保留可审金额", async () => {
    const setId = create("利润表冲突", ENTERPRISE);
    // 已有异常数据：6001 收入明细被登记成资产 / 借方（正常 addAccount 已被写前校验拒绝）。
    db.prepare(
      `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
       VALUES (?, '600101', '异常收入明细', '资产', 'debit', 0, 1)`,
    ).run(setId);
    post(setId, "2026-01", [e("1002", 100), e("600101", 0, 100)]);

    const is = A.incomeStatement(setId, "2026-01");
    assert.equal(is.current["营业收入"], 0, "冲突金额绝不误分类进收入行");
    assert.equal(is.current["净利润"], 0);
    assert.equal(is.reportStatus.complete, false, "不能给一张漂亮零表后声称完整");
    assert.ok(is.reportStatus.diagnostics.some(
      (diagnostic) => diagnostic.code === "report_account_semantics_mismatch" && diagnostic.accountCode === "600101",
    ));
    assert.deepEqual(
      is.unresolvedAmounts.current.map((item) => [item.accountCode, item.amountMinor, item.reasons]),
      [["600101", -10000, ["account_category_conflict", "account_direction_conflict"]]],
      "保留可审金额事实（贷 100 元 = -10000 分）与冲突原因",
    );
    const bs = A.balanceSheet(setId, "2026-01");
    assert.equal(line(bs, "货币资金"), 100);
    assert.equal(bs.totals.assets, 100, "冲突收入不静默计成资产");
    assert.equal(bs.reportStatus.complete, false);
    assert.ok(bs.unresolvedAmounts.some((item) => item.accountCode === "600101" && item.amountMinor === -10000));
    // 结转写前拒绝：收入余额不能留在账上被当成资产封账。
    await rejectsCode(() => A.carryForwardProfit(setId, "2026-01"), "carryforward_account_semantics_conflict");
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND kind='carryforward'`).get(setId).n, 0,
    );

    // 合法自定义收入明细（损益 / credit）按 profile 祖先语义进收入行且保持完整。
    const okSet = create("利润表合法明细", ENTERPRISE);
    A.addAccount(okSet, { code: "600101", name: "主营业务收入-合成明细", category: "损益", direction: "credit" });
    post(okSet, "2026-01", [e("1002", 100), e("600101", 0, 100)]);
    const okIs = A.incomeStatement(okSet, "2026-01");
    assert.equal(okIs.current["营业收入"], 100);
    assert.equal(okIs.reportStatus.complete, true);
    assert.deepEqual(okIs.unresolvedAmounts.current, []);
  });

  await test("P2：真实现金期初与导出1000细目精确到分，正负超界不生成DTO", async () => {
    const { buildReportExport } = await import("../server/report-export.mjs");
    const id = create("合成分精度只读", SMALL);
    const opening = [];
    for (let i = 0; i < 1000; i++) {
      const code = "1002" + String(i + 1).padStart(4, "0");
      A.addAccount(id, { code, name: "合成精度明细" + i, category: "资产", direction: "debit" });
      opening.push(e(code, i === 0 ? 900000000000.01 : 0.01));
    }
    opening.push(e("3001", 0, 900000000010)); A.setOpeningBalances(id, opening);
    assert.deepEqual(A.cashFlowStatement(id, "2026-01").cash, { begin: 900000000010, end: 900000000010, change: 0 });
    const out = buildReportExport(id, { kind: "trial-balance", period: "2026-01" });
    assert.equal(out.report.data.totals.opening_debit, 900000000010); assert.equal(out.report.data.totals.closing_debit, 900000000010);
    for (const field of ["debit", "credit"]) {
      const bad = create("合成越界只读", SMALL);
      for (const code of ["1001", "1002"]) db.prepare("INSERT INTO opening_balances(account_set_id,code,debit,credit) VALUES(?,?,?,?)").run(bad, code, field === "debit" ? 45035996273704.96 : 0, field === "credit" ? 45035996273704.96 : 0);
      assert.throws(() => buildReportExport(bad, { kind: "trial-balance", period: "2026-01" }), err => err.code === "report_data_invalid");
    }
  });

  await test("现金流：同一凭证双向现金 + 双向非现金无法唯一配对，保留 gross 事实与歧义诊断", () => {
    const setId = create("现金流配对歧义", ENTERPRISE);
    A.setOpeningBalances(setId, [e("1001", 100), e("4001", 0, 100)]);
    post(setId, "2026-01", [
      e("1002", 100), e("1001", 0, 100),
      e("1601", 100), e("4001", 0, 100),
    ]);
    const cf = A.cashFlowStatement(setId, "2026-01");
    // 同一批分录既可解释为「内部存现 100 + 非现金资产出资 100」，也可解释为
    // 「现金出资 100 + 现金购建资产 100」。缺唯一可核配对时不得假定任一方向。
    assert.deepEqual(cf.totals, { operating: 0, investing: 0, financing: 0, net_increase: 0 });
    assert.deepEqual(
      cf.unknown.map((item) => [item.direction, item.reason, item.value]),
      [
        ["inflow", "ambiguous-cash-counterpart-pairing", 100],
        ["outflow", "ambiguous-cash-counterpart-pairing", -100],
      ],
      "保留真实借贷方向的现金 gross 事实，不写入经营 / 投资 / 筹资合计",
    );
    assert.deepEqual(cf.cash, { begin: 100, end: 100, change: 0 });
    assert.equal(cf.classificationComplete, false);
    assert.equal(cf.reportStatus.complete, false);
    assert.ok(cf.reportStatus.diagnostics.some((d) => d.code === "cash_flow_classification_incomplete"));
  });

  await test("现金流：R1 同凭证经营收入 + 资产购建不足以唯一配对，改为 gross + 明确不完整", () => {
    const setId = create("现金流R1配对歧义", ENTERPRISE);
    A.setOpeningBalances(setId, [e("1002", 500), e("4001", 0, 500)]);
    post(setId, "2026-01", [e("1002", 100), e("6001", 0, 100), e("1601", 100), e("1002", 0, 100)]);
    const cf = A.cashFlowStatement(setId, "2026-01");
    // 也可读成「1002 内部划转 100 + 1601 对 6001 的非现金交易」，不能假装知道经营 / 投资配对。
    assert.deepEqual(cf.totals, { operating: 0, investing: 0, financing: 0, net_increase: 0 });
    assert.deepEqual(
      cf.unknown.map((item) => [item.direction, item.reason, item.value]),
      [
        ["inflow", "ambiguous-cash-counterpart-pairing", 100],
        ["outflow", "ambiguous-cash-counterpart-pairing", -100],
      ],
    );
    assert.deepEqual(cf.cash, { begin: 500, end: 500, change: 0 });
    assert.equal(cf.classificationComplete, false);
    assert.equal(cf.reportStatus.complete, false);
  });

  await test("现金流：两个独立凭证各自单一对方，经营入 100 / 投资出 100 可唯一配对", () => {
    const setId = create("现金流独立凭证", ENTERPRISE);
    A.setOpeningBalances(setId, [e("1002", 500), e("4001", 0, 500)]);
    post(setId, "2026-01", [e("1002", 100), e("6001", 0, 100)]);
    post(setId, "2026-01", [e("1601", 100), e("1002", 0, 100)]);
    const cf = A.cashFlowStatement(setId, "2026-01");
    assert.equal(cf.totals.operating, 100, "经营流入 100");
    assert.equal(cf.totals.investing, -100, "投资流出 100");
    assert.equal(cf.totals.net_increase, 0);
    assert.deepEqual(cf.cash, { begin: 500, end: 500, change: 0 });
    assert.deepEqual(cf.unknown, []);
    assert.equal(cf.classificationComplete, true);
    assert.equal(cf.reconciles, true);
    assert.equal(cf.reportStatus.complete, true);
  });

  await test("现金流：现金内部划转不分类但保留现金事实；部分现金 + 应收应付按对方方向归类", () => {
    const transfer = create("现金流内部划转", SMALL);
    A.setOpeningBalances(transfer, [e("1002", 500), e("3001", 0, 500)]);
    A.addAccount(transfer, { code: "100201", name: "工行基本户", category: "资产", direction: "debit" });
    post(transfer, "2026-01", [e("100201", 100), e("1002", 0, 100)]);
    const tf = A.cashFlowStatement(transfer, "2026-01");
    assert.deepEqual(tf.unknown, []);
    assert.equal(tf.totals.operating + tf.totals.investing + tf.totals.financing, 0);
    assert.equal(tf.classificationComplete, true);
    assert.deepEqual(tf.cash, { begin: 500, end: 500, change: 0 });
    assert.equal(tf.reconciles, true);

    const partial = create("现金流部分现金", SMALL);
    A.setOpeningBalances(partial, [e("1002", 500), e("3001", 0, 500)]);
    post(partial, "2026-01", [e("1002", 60), e("1122", 40), e("5001", 0, 100)]);
    const pc = A.cashFlowStatement(partial, "2026-01");
    assert.equal(pc.totals.operating, 60, "部分现金销售：经营流入按贷方 5001 归类");
    assert.equal(pc.classificationComplete, true);
    assert.equal(pc.reconciles, true);

    const payable = create("现金流部分应付", SMALL);
    A.setOpeningBalances(payable, [e("1002", 500), e("3001", 0, 500)]);
    post(payable, "2026-01", [e("1601", 100), e("1002", 0, 70), e("2202", 0, 30)]);
    const pb = A.cashFlowStatement(payable, "2026-01");
    assert.equal(pb.totals.investing, -70, "部分现金购建：投资流出按借方 1601 归类");
    assert.equal(pb.classificationComplete, true);
    assert.equal(pb.reconciles, true);
  });

  for (const [standard, capital] of [[SMALL, "3001"], [ENTERPRISE, "4001"]]) {
    await test(standard + "：全额材料设备复合收付、明细重排与生命周期只读", () => {
      const setId = create("合成全额复合", standard, "2025-11");
      A.setOpeningBalances(setId, [e("1002", 1000), e(capital, 0, 1000)]);
      for (const code of ["140301", "160101", "100201"]) A.addAccount(setId, { code, name: "合成合法明细" + code, category: "资产", direction: "debit" });
      post(setId, "2025-11", [e("1403", 120), e("1601", 180), e("1002", 0, 300)]);
      post(setId, "2025-12", [e("1002", 50), e("1601", 0, 30), e("1403", 0, 20)]);
      post(setId, "2026-01", [e("1601", 18.02), e("1002", 0, 30.03), e("1403", 12.01)]);
      const snapshot = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name}) => [name, db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
      const before = snapshot();
      for (const [period, totals, cash] of [
        ["2025-11", { operating: -120, investing: -180, financing: 0, net_increase: -300 }, { begin: 1000, end: 700, change: -300 }],
        ["2025-12", { operating: 20, investing: 30, financing: 0, net_increase: 50 }, { begin: 700, end: 750, change: 50 }],
        ["2026-01", { operating: -12.01, investing: -18.02, financing: 0, net_increase: -30.03 }, { begin: 750, end: 719.97, change: -30.03 }],
      ]) {
        const cf = A.cashFlowStatement(setId, period);
        assert.deepEqual(cf.totals, totals); assert.deepEqual(cf.cash, cash);
        assert.deepEqual(cf.unknown, []); assert.equal(cf.classificationComplete, true);
        assert.equal(cf.reportStatus.complete, true); assert.equal(cf.reconciles, true);
      }
      assert.equal(snapshot(), before, "所有表内容在读取前后完全相同");
      const draft = A.createVoucher(setId, { period: "2026-02", status: "draft", entries: [
        e("100201", 0, 70.01), e("140301", 11.27), e("160101", 68.74), e("1403", 20), e("1002", 0, 30),
      ] });
      assert.equal(A.cashFlowStatement(setId, "2026-02").totals.net_increase, 0);
      A.postVoucher(setId, draft.id);
      const active = A.cashFlowStatement(setId, "2026-02");
      assert.deepEqual(active.totals, { operating: -31.27, investing: -68.74, financing: 0, net_increase: -100.01 });
      assert.deepEqual(active.cash, { begin: 719.97, end: 619.96, change: -100.01 });
      assert.deepEqual(active.unknown, []); assert.equal(active.reconciles, true);
      A.unpostVoucher(setId, draft.id);
      assert.equal(A.cashFlowStatement(setId, "2026-02").totals.net_increase, 0);
      A.postVoucher(setId, draft.id);
      assert.deepEqual(A.cashFlowStatement(setId, "2026-02").totals, active.totals, "重过账仅计一次");
      const reordered = create("合成顺序与重复根", standard);
      post(reordered, "2026-01", [e("1601", 68.74), e("1403", 20), e("1002", 0, 100.01), e("1403", 11.27)]);
      assert.deepEqual(A.cashFlowStatement(reordered, "2026-01").totals, active.totals);
    });
    await test(standard + "：部分结算/处置损益/未知/双侧复合仍失败关闭且无部分成功桶", () => {
      const fixtures = [
        [e("1403", 120), e("1601", 180), e("1002", 0, 100), e("2202", 0, 200)],
        [e("1002", 150), e("1601", 0, 100), e(standard === SMALL ? "5301" : "6301", 0, 50)],
        [e("1403", 120), e("1604", 180), e("1002", 0, 300)],
        [e("1403", 120), e("1601", 180), e("1403", 0, 20), e("1002", 0, 280)],
        [e("1403", 120), e("1601", 180), e("1002", 0, 300), e("1001", 10), e(capital, 0, 10)],
      ];
      for (const entries of fixtures) {
        const id = create("合成真正未知", standard); post(id, "2026-01", entries);
        const cf = A.cashFlowStatement(id, "2026-01");
        assert.equal(cf.classificationComplete, false); assert.equal(cf.reportStatus.complete, false);
        assert.deepEqual(cf.totals, { operating: 0, investing: 0, financing: 0, net_increase: 0 });
        assert.ok(cf.unknown.length); assert.ok(cf.diagnostics.some(d => d.code === "cash_flow_classification_incomplete"));
      }
      for (const [code, update] of [["140301", "category='负债',direction='credit'"], ["160101", "contra=1"], ["100201", "contra=1"]]) {
        const id = create("合成历史语义冲突", standard);
        for (const detail of ["140301", "160101", "100201"]) A.addAccount(id, { code: detail, name: "合成明细", category: "资产", direction: "debit" });
        post(id, "2026-01", [e("140301", 120), e("160101", 180), e("100201", 0, 300)]);
        db.prepare("UPDATE accounts SET " + update + " WHERE account_set_id=? AND code=?").run(id, code);
        const cf = A.cashFlowStatement(id, "2026-01");
        assert.equal(cf.classificationComplete, false); assert.equal(cf.reportStatus.complete, false);
        assert.deepEqual(cf.totals, { operating: 0, investing: 0, financing: 0, net_increase: 0 });
        assert.equal(cf.unknown[0].value, -300);
      }
    });
  }

  await test("现金流：现金明细语义被历史损坏时按权威方向算余额、保留冲突诊断且不静默完整", () => {
    // 合法自定义现金明细：100201 资产 / debit，正常应完整且经营流入 100。
    const okSet = create("现金流合法现金明细", ENTERPRISE);
    A.addAccount(okSet, { code: "100201", name: "工行基本户", category: "资产", direction: "debit" });
    post(okSet, "2026-01", [e("100201", 100), e("6001", 0, 100)]);
    const ok = A.cashFlowStatement(okSet, "2026-01");
    assert.equal(ok.totals.operating, 100);
    assert.deepEqual(ok.cash, { begin: 0, end: 100, change: 100 });
    assert.equal(ok.classificationComplete, true);
    assert.equal(ok.reportStatus.complete, true);

    // 同编码明细被模拟历史异常改成负债 / credit：库内 direction 已不可信。
    const brokenSet = create("现金流损坏现金明细", ENTERPRISE);
    A.addAccount(brokenSet, { code: "100201", name: "工行基本户", category: "资产", direction: "debit" });
    post(brokenSet, "2026-01", [e("100201", 100), e("6001", 0, 100)]);
    db.prepare(`UPDATE accounts SET category='负债', direction='credit' WHERE account_set_id=? AND code='100201'`)
      .run(brokenSet);
    const cf = A.cashFlowStatement(brokenSet, "2026-01");
    // 借方 100 的整数分事实仍在：余额按现金角色的权威方向（资产 / 借）汇总，不翻成 -100，也不抹为 0。
    assert.deepEqual(cf.cash, { begin: 0, end: 100, change: 100 });
    assert.equal(cf.totals.operating, 100, "单一对方科目 6001 的经营流入事实仍可核对");
    assert.equal(cf.classificationComplete, false, "现金明细语义冲突不得静默完整");
    assert.equal(cf.reportStatus.complete, false);
    assert.ok(cf.reportStatus.diagnostics.some(
      (d) => d.code === "report_account_semantics_mismatch"
        && d.accountCode === "100201" && d.reason === "account-category-conflict",
    ));
    assert.ok(cf.reportStatus.diagnostics.some(
      (d) => d.code === "report_account_semantics_mismatch"
        && d.accountCode === "100201" && d.reason === "account-direction-conflict",
    ));
  });

  for (const [standard, revenue, capital] of [[SMALL, "5001", "3001"], [ENTERPRISE, "6001", "4001"]]) {
    await test(`${standard}：现金细目 contra 冲突保留 100 元并明确不完整（含仅期初余额）`, () => {
      const setId = create("现金流备抵冲突", standard);
      A.addAccount(setId, { code: "100201", name: "合成银行明细", category: "资产", direction: "debit" });
      post(setId, "2026-01", [e("100201", 100), e(revenue, 0, 100)]);
      const valid = A.cashFlowStatement(setId, "2026-01");
      assert.equal(valid.reportStatus.complete, true);
      assert.equal(valid.totals.operating, 100);
      db.prepare(`UPDATE accounts SET contra=1 WHERE account_set_id=? AND code='100201'`).run(setId);
      const broken = A.cashFlowStatement(setId, "2026-01");
      assert.deepEqual(broken.cash, { begin: 0, end: 100, change: 100 });
      assert.equal(broken.totals.operating, 100);
      assert.equal(broken.classificationComplete, false);
      assert.equal(broken.reportStatus.complete, false);
      assert.ok(broken.reportStatus.diagnostics.some((d) => d.code === "report_account_semantics_mismatch"
        && d.accountCode === "100201" && d.reason === "account-contra-conflict"));

      // 无本期现金 gross 时，期初 / 期末的损坏标记同样必须诊断。
      const opening = create("仅期初现金备抵冲突", standard);
      A.addAccount(opening, { code: "100201", name: "合成银行明细", category: "资产", direction: "debit" });
      A.setOpeningBalances(opening, [e("100201", 100), e(capital, 0, 100)]);
      db.prepare(`UPDATE accounts SET contra=1 WHERE account_set_id=? AND code='100201'`).run(opening);
      const cf = A.cashFlowStatement(opening, "2026-01");
      assert.deepEqual(cf.cash, { begin: 100, end: 100, change: 0 });
      assert.equal(cf.reportStatus.complete, false);
      assert.equal(cf.classificationComplete, false);
      assert.ok(cf.reportStatus.diagnostics.some((d) => d.accountCode === "100201"
        && d.code === "report_account_semantics_mismatch" && d.reason === "account-contra-conflict"));
    });

    await test(`${standard}：权威备抵根与合法备抵明细不误拒，合法收入明细保持完整`, async () => {
      const setId = create("合法备抵与明细", standard);
      A.addAccount(setId, { code: "160201", name: "合成累计折旧明细", category: "资产", direction: "credit" });
      A.addAccount(setId, { code: `${revenue}01`, name: "合成收入明细", category: "损益", direction: "credit" });
      const { accountProfileSemantics } = await import("../server/period-end-controls.mjs");
      const { getAccountingProfile } = await import("../server/accounting-profiles.mjs");
      const profile = getAccountingProfile(A.getAccountSet(setId).accounting_profile_id);
      // 对领域共用校验本身验证备抵继承，避免只由报表纯规则的通过掩盖误拒。
      for (const code of ["1602", "160201"]) {
        for (const contra of [0, 1]) {
          const semantics = accountProfileSemantics(profile, { code, category: "资产", direction: "credit", contra });
          assert.deepEqual(semantics.reasons, []);
          assert.equal(semantics.effective.contra, true);
        }
      }
      // 明细默认 contra=0 可继承权威备抵语义；根 / 明细显式标记也应兼容。
      A.setOpeningBalances(setId, [e("1601", 100), e("1602", 0, 10), e("160201", 0, 10), e(capital, 0, 80)]);
      assert.equal(A.balanceSheet(setId, "2026-01").reportStatus.complete, true);
      db.prepare(`UPDATE accounts SET contra=1 WHERE account_set_id=? AND code IN ('1602', '160201')`).run(setId);
      post(setId, "2026-01", [e("1002", 100), e(`${revenue}01`, 0, 100)]);
      const bs = A.balanceSheet(setId, "2026-01");
      assert.equal(bs.totals.assets, 180);
      assert.equal(bs.reportStatus.complete, true);
      assert.equal(A.incomeStatement(setId, "2026-01").current["营业收入"], 100);
      const cf = A.cashFlowStatement(setId, "2026-01");
      assert.equal(cf.totals.operating, 100);
      assert.equal(cf.classificationComplete, true);
      assert.equal(cf.reportStatus.complete, true);
      assert.deepEqual(cf.reportStatus.diagnostics, []);
    });
  }

  await test("现金流：退款按反向独立分类；红字负数金额仍被守卫拒绝", async () => {
    const setId = create("现金流退款冲销", SMALL, "2025-12");
    A.setOpeningBalances(setId, [e("1002", 500), e("3001", 0, 500)]);
    post(setId, "2025-12", [e("1002", 100), e("5001", 0, 100)]);
    post(setId, "2026-01", [e("5001", 100), e("1002", 0, 100)]);
    const cf = A.cashFlowStatement(setId, "2026-01");
    assert.equal(cf.totals.operating, -100, "退款是经营流出，不按上期净额 0 处理");
    assert.equal(cf.classificationComplete, true);
    assert.equal(cf.reconciles, true);

    const before = db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setId).n;
    let negativeError = null;
    try {
      A.createVoucher(setId, {
        period: "2026-01", status: "posted",
        entries: [e("1002", -50), e("5001", 0, -50)],
      });
    } catch (error) { negativeError = error; }
    assert.ok(negativeError, "负数金额必须被拒绝（红字冲销走反方向分录，不靠负值改方向）");
    assert.match(String(negativeError.message), /voucher_invalid/);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?`).get(setId).n, before);
  });

  await test("资产负债表：0.30 = 0.10 + 0.20 按整数分平衡；真正差 1 分明确不平", () => {
    const small = create("小数分平衡", SMALL);
    A.setOpeningBalances(small, [e("1002", 0.3), e("2001", 0, 0.1), e("3001", 0, 0.2)]);
    const tb = A.trialBalance(small, "2026-01");
    assert.equal(tb.totals.closing_debit, tb.totals.closing_credit);
    const bs = A.balanceSheet(small, "2026-01");
    assert.deepEqual(bs.totals, { assets: 0.3, liabilities: 0.1, equity: 0.2 });
    assert.equal(bs.balanced, true, "整数分比较：30 = 10 + 20");
    assert.equal(bs.reportStatus.complete, true);

    const enterprise = create("小数分不平", ENTERPRISE);
    A.setOpeningBalances(enterprise, [e("1002", 0.01), e("1122", 0, 0.01)]);
    const gap = A.balanceSheet(enterprise, "2026-01");
    assert.equal(gap.totals.assets, 0.01);
    assert.equal(gap.totals.liabilities, 0);
    assert.equal(gap.totals.equity, 0);
    assert.equal(gap.balanced, false, "真正差 1 分不得被 epsilon 抹平");
    assert.equal(gap.reportStatus.complete, false);
    assert.ok(gap.unresolvedAmounts.some((item) => item.accountCode === "1122" && item.amountMinor === -1));
  });

  await test("未知持久 profile：结构化拒绝且不回显库内原始字符串，不 fallback", async () => {
    const setId = create("未知profile回显", SMALL);
    const raw = "UNTRUSTED_SYNTHETIC_PROFILE";
    db.prepare(`UPDATE account_sets SET accounting_profile_id=? WHERE id=?`).run(raw, setId);
    for (const [label, fn] of [
      ["getAccountSet", () => A.getAccountSet(setId)],
      ["periodEndCheck", () => A.periodEndCheck(setId, "2026-01")],
      ["balanceSheet", () => A.balanceSheet(setId, "2026-01")],
      ["incomeStatement", () => A.incomeStatement(setId, "2026-01")],
      ["cashFlowStatement", () => A.cashFlowStatement(setId, "2026-01")],
    ]) {
      const error = await rejectsCode(fn, "accounting_profile_unknown");
      assert.deepEqual(Object.keys(error.details).sort(), ["field", "reason"], `${label} 只回固定字段`);
      assert.equal(error.details.field, "accounting_profile_id");
      assert.equal(error.details.reason, "profile-not-registered");
      assert.equal(JSON.stringify(error.details).includes(raw), false, `${label} 不得回显原始 profile 字符串`);
    }
    assert.equal(
      db.prepare(`SELECT accounting_profile_id FROM account_sets WHERE id=?`).get(setId).accounting_profile_id,
      raw,
      "只读原始行仍可核对（不被改写 / 不 fallback）",
    );
  });

  for (const [standard, revenue] of [[SMALL, "5001"], [ENTERPRISE, "6001"]]) {
    await test(`${standard}：收入 contra 污染整体拒绝结转且保留原金额`, async () => {
      const setId = create("合成收入备抵污染", standard);
      post(setId, "2026-01", [e("1002", 100), e(revenue, 0, 100)]);
      db.prepare("UPDATE accounts SET contra=1 WHERE account_set_id=? AND code=?").run(setId, revenue);
      const before = JSON.stringify(db.prepare("SELECT * FROM vouchers WHERE account_set_id=?").all(setId));
      await rejectsCode(() => A.carryForwardProfit(setId, "2026-01"), "carryforward_account_semantics_conflict");
      await rejectsCode(() => A.periodEndCheck(setId, "2026-01"), "carryforward_account_semantics_conflict");
      assert.equal(JSON.stringify(db.prepare("SELECT * FROM vouchers WHERE account_set_id=?").all(setId)), before);
      assert.equal(A.cashFlowStatement(setId, "2026-01").cash.end, 100);
      db.prepare("UPDATE accounts SET contra=0 WHERE account_set_id=? AND code=?").run(setId, revenue);
      A.carryForwardProfit(setId, "2026-01");
      assert.equal(A.incomeStatement(setId, "2026-01").current["净利润"], 100);
    });
  }

  for (const [standard, code] of [[SMALL, "560201"], [ENTERPRISE, "660201"]]) {
    await test(`${standard}：legacy 新增明细语义 dry/apply 一致拒绝且全表零写`, () => {
      const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
      for (const bad of [{ category: "资产", direction: "debit" }, { category: "损益", direction: "credit" }]) {
        const payload = { account_set: { name: "语义零写合成", accounting_standard: standard, start_period: "2026-01" },
          accounts: [{ code, name: "合成明细", ...bad }] };
        const enterprise = identityFixture();
        const before = snapshot();
        for (const dryRun of [true, false]) {
          const result = A.importAccountSet(payload, { enterprise, dryRun });
          assert.equal(result.validation.ok, false);
          assert.equal(result.validation.profileError.code, "account_semantics_conflict");
          assert.equal(result.validation.profileError.details.field, bad.category === "资产" ? "category" : "direction");
          assert.equal(result.created, null);
          assert.deepEqual(snapshot(), before);
        }
      }
    });
    await test(`${standard}：legacy 合法同根明细独立金额与标准科目兼容`, () => {
      const payload = { account_set: { name: "合法明细合成", accounting_standard: standard, start_period: "2026-01" },
        accounts: [{ code, name: "合成明细", category: "损益", direction: "debit" },
          { code: "1002", name: "不覆盖标准名称", category: "负债", direction: "credit" }],
        vouchers: [{ period: "2026-01", date: "2026-01-03", number: 1,
          entries: [e(code, 37.25), e("1002", 0, 37.25)] }] };
      const enterprise = identityFixture();
      const preview = A.importAccountSet(payload, { enterprise, dryRun: true });
      assert.equal(preview.validation.ok, true, JSON.stringify(preview));
      const result = A.importAccountSet(payload, { enterprise, dryRun: false });
      assert.equal(result.validation.ok, true);
      assert.equal(A.incomeStatement(result.created.id, "2026-01").current["净利润"], -37.25);
      assert.equal(A.listAccounts(result.created.id).find((a) => a.code === "1002").name, "银行存款");
    });
  }

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error("测试初始化失败：", error);
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* 忽略 */ }
  try { if (!results.some(([ok]) => !ok) && process.env.WORKBENCH_TEST_KEEP_FIXTURES !== "1") rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); else console.log(`保留合成夹具：${dataDir}`); } catch { /* 忽略 */ }
}
