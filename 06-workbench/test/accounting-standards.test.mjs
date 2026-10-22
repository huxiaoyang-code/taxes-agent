#!/usr/bin/env node
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
  A.createAccountSet({ name, accounting_standard: standard, start_period: start }).id;
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
    assert.equal(mixedCf.classificationComplete, false);
    assert.equal(mixedCf.totals.operating, 0);
    assert.equal(mixedCf.totals.investing, 0);
    assert.ok(mixedCf.unknown.some((item) => item.reason === "multi-counterpart-allocation-not-implemented"));
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
      () => A.createAccountSet({ name: "bad", accounting_standard: "企业会计", start_period: "2026-01" }),
      "accounting_standard_invalid",
    )).code, "accounting_standard_invalid");
    assert.equal((await rejectsCode(
      () => A.createAccountSet({ name: "bad", accounting_standard: " 企业会计准则 ", start_period: "2026-01" }),
      "accounting_standard_invalid",
    )).code, "accounting_standard_invalid");
    assert.equal((await rejectsCode(
      () => A.createAccountSet({
        name: "bad", accounting_standard: SMALL, profileId: "enterprise-2019-general-basic-v1", start_period: "2026-01",
      }),
      "accounting_profile_standard_mismatch",
    )).code, "accounting_profile_standard_mismatch");
    assert.equal((await rejectsCode(
      () => A.createAccountSet({ name: "bad", profileId: "legacy-small-coa-v1", start_period: "2026-01" }),
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
        A.createAccountSet({ name: "建账失败", accounting_standard: SMALL, start_period: "2026-01" });
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

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error("测试初始化失败：", error);
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* ignore */ }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}
