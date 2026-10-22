#!/usr/bin/env node
/**
 * LOCAL-02 会计金额精度 / 期末完整性 / 连续期间 领域回归（合成临时库，不连真实账套）。
 *
 * 覆盖（全部用手算预期核对，不复用被测 helper 生成 expected）：
 *  1) 人民币分精度与 ROUND_HALF_UP：1.005 / 0.125 / 三位以上小数 / 0.1 累加 / 上限 / 极小负数 / 非有限值；
 *  2) 折旧摊销累计舍入：100 元 3 期、0.05 元 12 期、跨年连续 4 期，寿命内恰好提足、不提前多提；
 *  3) 卡片与总账核对：缺卡片 / 原值差异 / 累计差异 / 显式“未入账”登记 / 取得期间与计提开始分离；
 *  4) 封账前置：无资产 / 无损益的 not_applicable、缺计提、缺结转、年末结转、连续期间顺序；
 *  5) 重复与失效：重复计提 / 结转不重复入账，已做结转被后续分录改变时检测失效；
 *  6) 反操作与前期变动：更晚期间已封账 / 已过账年末结转时明确拒绝并给撤销顺序，按正确顺序可完成；
 *  7) 故障原子性：封账 / 结转中途失败后账簿、期间状态与检查结论不变；
 *  8) 持久结构：合成 v3 库 → v4 升级（升级前备份 / WAL 快照 / 失败回滚 / 备份可恢复）。
 *
 * 运行：node test/accounting-period-integrity.test.mjs（在 06-workbench 目录）
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const dataDir = mkdtempSync(join(tmpdir(), "wb-period-integrity-"));
process.env.WORKBENCH_DATA_DIR = dataDir;

let db, A, M, C, S;
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 4).join("\n    ")}`); }
};
const rejects = async (fn, re) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, "应抛出错误但未抛出");
  if (re) assert.match(String(err.message), re);
  return err;
};
const rejectsCode = async (fn, code) => {
  const err = await rejects(fn);
  assert.equal(err.code ?? err.message, code, `期望错误码 ${code}，实际 ${err.code ?? err.message}`);
  return err;
};
const e = (code, debit = 0, credit = 0) => ({ code, debit, credit });
const newSet = (name, start = "2026-01") => A.createAccountSet({ name, start_period: start }).id;
const stepOf = (check, id) => check.steps.find((s) => s.id === id);
const codesOf = (check) => check.blocking.map((b) => b.code);
const snapshot = () => Object.fromEntries(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [
    name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .map((row) => JSON.stringify(row)).sort(),
  ]),
);
const opening = (setId) => [e("1002", 1000), e("3001", 0, 1000)];

try {
  ({ db } = await import("../server/db.mjs"));
  A = await import("../server/accounting.mjs");
  M = await import("../server/money.mjs");
  C = await import("../server/period-end-controls.mjs");
  S = await import("../server/import-storage.mjs");

  console.log("\nLOCAL-02 金额 / 期末完整性 / 连续期间（领域层）\n");

  // ================================================================ 1. 金额精度
  await test("金额：十进制文本按 ROUND_HALF_UP 精确到分（1.005 → 1.01，不是 1.00）", () => {
    // 手算：1.005 的第三位小数是 5 → 进一分 = 1.01；二进制浮点 1.005 实际是 1.00499999…，旧 round 会得 1.00。
    assert.equal(M.formatCents(M.requireCents(1.005)), "1.01");
    assert.equal(M.formatCents(M.requireCents("1.005")), "1.01");
    assert.equal(M.formatCents(M.requireCents("0.125")), "0.13");
    assert.equal(M.formatCents(M.requireCents("0.1249999")), "0.12");
    assert.equal(M.formatCents(M.requireCents("2.674999")), "2.67");
    assert.equal(M.formatCents(M.requireCents("2.675")), "2.68");
    assert.equal(M.formatCents(M.requireCents(123.456)), "123.46");
    assert.equal(M.formatCents(M.requireCents("1.")), "1.00");
    assert.equal(M.formatCents(M.requireCents("+.125")), "0.13");
  });

  await test("金额：合计在整数分上完成（0.1 × 10 = 1.00，无二进制尾差）", () => {
    assert.equal(M.formatCents(M.sumCents(Array.from({ length: 10 }, () => 0.1))), "1.00");
    assert.equal(M.formatCents(M.sumCents([0.07, 0.01, 0.02])), "0.10");
    const s = newSet("精度-合计");
    const entries = Array.from({ length: 1000 }, () => e("1002", 0.1));
    entries.push(e("1001", 0, 100));
    const voucher = A.createVoucher(s, { period: "2026-01", entries });
    assert.equal(voucher.total_debit, 100);
    assert.equal(voucher.total_credit, 100);
  });

  await test("金额：上限按原值判定（999999999999.994 超界拒绝，边界值本身合法）", () => {
    assert.equal(M.centsToNumber(M.requireCents("999999999999.99")), 999999999999.99);
    for (const bad of [999999999999.994, "999999999999.994", "999999999999.99001", 1e13, "1000000000000"]) {
      assert.equal(M.parseMoney(bad).ok, false, `${bad} 应被拒绝`);
      assert.equal(A.parseImportAmount(bad).ok, false, `${bad} 导入也应被拒绝`);
    }
    assert.equal(M.parseMoney(999999999999.99).ok, true);
  });

  await test("金额：极小负数（含指数形式 / 超过 9 位小数）按完整原值拒绝，极正小数标记不足一分", () => {
    for (const bad of [-1e-20, -1e-10, "-0.0000000001", "-0.000000000000000000001"]) {
      assert.equal(M.parseMoney(bad).ok, false, `${String(bad)} 应被识别为负数并拒绝`);
    }
    const tiny = M.parseMoney(1e-20);
    assert.equal(tiny.ok, true);
    assert.equal(tiny.cents, 0n);
    assert.equal(tiny.subCent, true, "正的非零极小数不能被当成“真 0”");
    // 超界原值：后 10 位小数也参与上限判定，不能因为前 9 位截断被接受。
    assert.equal(M.parseMoney("999999999999.9900000001").ok, false);
    assert.equal(M.parseMoney("999999999999.9900000").ok, true);
    const s = newSet("精度-微小期初");
    assert.throws(() => A.setOpeningBalances(s, [e("1002", 0.001), e("3001", 0, 0.001)]), /opening_amount_invalid/);
    assert.equal(A.getOpeningBalances(s).length, 0);
  });

  await test("金额：合计超出可保分范围时明确拒绝（不靠 MAX_SAFE_INTEGER 单一护栏）", () => {
    // 整数分本身在 Number 安全范围内，但除以 100 后的最短输出会丢一分（管理器发现的边界）。
    assert.throws(() => M.centsToNumber(9007199254740991n), (err) => err.code === "money_total_not_representable");
    assert.equal(M.centsToNumber(9007199254740990n), 90071992547409.9);
    assert.equal(M.requireCents(String(M.centsToNumber(9007199254740990n)), { maxCents: null }), 9007199254740990n,
      "可表示值必须往返一致");
    // 91 笔上限金额的合计已超出可保分范围 → 必须报错而不是静默截断。
    const huge = [];
    for (let i = 0; i < 91; i += 1) huge.push({ code: "1002", debit: "999999999999.99" });
    for (let i = 0; i < 91; i += 1) huge.push({ code: "1001", credit: "999999999999.99" });
    const check = A.checkVoucher(newSet("精度-超合计"), huge);
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((msg) => /范围|保留到分/.test(msg)), JSON.stringify(check.errors.slice(-2)));
  });

  await test("金额：单笔上限不强加给存续 / 累计金额（累计余额可超过单笔上限）", () => {
    // 单笔：1.0000000001 万亿超过单笔上限 → 拒绝。
    assert.equal(M.parseMoney("1000000000000.01").ok, false);
    // 存续金额（如导入的历史累计折旧）：2 万亿合法，不被单笔上限拦住。
    assert.equal(M.formatCents(M.storedCents(2000000000000)), "2000000000000.00");
    // 累计余额超过单笔上限时报表 / 余额仍按分精确汇总。
    const s = newSet("精度-累计超过单笔");
    for (let i = 0; i < 2; i += 1) {
      A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", "999999999999.99"), e("3001", 0, "999999999999.99")] });
    }
    const balance = A.accountBalances(s, "2026-01").get("1002").natural;
    assert.equal(M.formatCents(M.requireCents(balance, { maxCents: null })), "1999999999999.98");
    assert.equal(A.trialBalance(s, "2026-01").totals.closing_debit, 1999999999999.98);
    assert.equal(A.balanceSheet(s, "2026-01").balanced, true);
    // 卡片补项期初累计同样是存续金额：允许到单笔上限本身（且不超可计提额）。
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", "999999999999.99"), e("1002", 0, "999999999999.99")] });
    const card = A.addAssetCard(s, {
      name: "大额设备", original_cost: "999999999999.99", residual_rate: 0, useful_life_months: 60,
      start_period: "2026-02", acquired_period: "2026-01",
    });
    const updated = A.updateAssetCard(s, card.id, { opening_accumulated: "999999999999.99" });
    assert.equal(M.formatCents(M.requireCents(updated.opening_accumulated, { maxCents: null })), "999999999999.99");
    assert.equal(updated.remaining, 0);
  });

  await test("凭证：1.005 借贷两侧都归一为 1.01，落库与出参一致", () => {
    const s = newSet("精度-凭证");
    const voucher = A.createVoucher(s, { period: "2026-01", entries: [e("1002", "1.005"), e("1001", 0, "1.005")] });
    assert.equal(voucher.total_debit, 1.01);
    assert.equal(voucher.total_credit, 1.01);
    assert.deepEqual(voucher.entries.map((x) => [x.debit, x.credit]), [[1.01, 0], [0, 1.01]]);
    const stored = db.prepare("SELECT debit FROM voucher_entries WHERE voucher_id=? AND line_no=1").get(voucher.id).debit;
    assert.equal(stored, 1.01);
  });

  await test("导入：合法格式保留（¥/千分位），1.005 归一 1.01，非法文本仍拒绝", () => {
    assert.equal(A.parseImportAmount("¥1,234.5").value, 1234.5);
    assert.equal(A.parseImportAmount("1.005").value, 1.01);
    assert.equal(A.parseImportAmount("123.456").value, 123.46);
    for (const bad of ["abc", "10.5万", "1 000", "1e2", "0x64", "NaN", "Infinity"]) {
      assert.equal(A.parseImportAmount(bad).ok, false, `${bad} 应被拒绝`);
    }
    // 每行独立四舍五入后再精确求和：1.005 + 0.005 = 1.01 + 0.01 = 1.02。
    const payload = {
      account_set: { name: "导入精度", start_period: "2026-01" },
      vouchers: [{
        period: "2026-01", number: 1, entries: [
          { code: "1002", debit: "1.005" }, { code: "1002", debit: "0.005" }, { code: "3001", credit: "1.02" },
        ],
      }],
    };
    const out = A.importAccountSet(payload, { dryRun: false });
    assert.equal(out.validation.ok, true, JSON.stringify(out.validation.errors));
    const s = out.created.id;
    const voucher = A.listVouchers(s, { period: "2026-01" })[0];
    assert.equal(voucher.total_debit, 1.02);
    assert.equal(voucher.total_credit, 1.02);
  });

  await test("报表：试算平衡与明细账按分合计（3 × 0.005 = 0.03）", () => {
    const s = newSet("精度-报表");
    for (let i = 0; i < 3; i += 1) {
      A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", "0.005"), e("3001", 0, "0.005")] });
    }
    const tb = A.trialBalance(s, "2026-01");
    assert.equal(tb.lines.find((l) => l.code === "1002").closing_debit, 0.03);
    assert.equal(tb.totals.closing_debit, 0.03);
    assert.equal(tb.totals.closing_credit, 0.03);
    const gl = A.generalLedger(s, "1002", "2026-01");
    assert.equal(gl.items.length, 3);
    assert.equal(gl.items.at(-1).balance, 0.03);
  });

  // ================================================================ 2. 折旧 / 摊销累计舍入
  await test("折旧：100 元 3 期 = 33.33 / 33.33 / 33.34，第 3 期恰好提足且第 4 期不再提", () => {
    const s = newSet("折旧-三期");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    const card = A.addAssetCard(s, {
      name: "合成设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    assert.equal(card.depreciable, 100);
    assert.equal(card.monthly, 33.33);
    assert.equal(card.final_month, 33.34);
    const amounts = ["2026-01", "2026-02", "2026-03"].map((p) => A.generateDepreciation(s, p).voucher.total_debit);
    assert.deepEqual(amounts, [33.33, 33.33, 33.34]); // 手算：33.33×2 + 33.34 = 100.00
    assert.equal(amounts.reduce((x, y) => x + y, 0), 100);
    assert.equal(A.listAssetCards(s)[0].accumulated, 100);
    assert.equal(A.listAssetCards(s)[0].remaining, 0);
    assert.equal(A.accountBalances(s, "2026-03").get("1602").natural, 100);
    assert.equal(A.generateDepreciation(s, "2026-04").voucher, null, "不得把尾差推到寿命之外");
    const check = A.periodEndCheck(s, "2026-03");
    assert.equal(stepOf(check, "depreciation").status, "ok");
    assert.equal(stepOf(check, "asset_reconciliation").status, "ok");
  });

  await test("摊销：0.05 元 12 期，前 11 期无金额、第 12 期提 0.05，不阻塞封账", () => {
    const s = newSet("摊销-极小金额");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1701", 0.05), e("1002", 0, 0.05)] });
    const card = A.addAssetCard(s, {
      kind: "intangible", name: "合成专利", original_cost: 0.05, residual_rate: 0,
      useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01",
    });
    assert.equal(card.monthly, 0, "5 分 ÷ 12 期，按分向下取整为 0");
    assert.equal(card.final_month, 0.05);
    for (let m = 1; m <= 11; m += 1) {
      const period = `2026-${String(m).padStart(2, "0")}`;
      const run = A.generateDepreciation(s, period);
      assert.equal(run.voucher, null, `${period} 无应计提额`);
      const step = stepOf(A.periodEndCheck(s, period), "depreciation");
      assert.equal(step.status, "ok", `${period} 不应被“本期 0 元”阻塞`);
    }
    const last = A.generateDepreciation(s, "2026-12");
    assert.equal(last.voucher.total_debit, 0.05);
    assert.equal(A.listAssetCards(s)[0].accumulated, 0.05);
    assert.equal(A.accountBalances(s, "2026-12").get("1702").natural, 0.05);
    assert.equal(A.generateDepreciation(s, "2027-01").voucher, null);
  });

  await test("折旧：跨年连续 4 期（2026-11 → 2027-02）金额精确且合计等于可折旧额", () => {
    const s = newSet("折旧-跨年");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-11", status: "posted", entries: [e("1601", 1), e("1002", 0, 1)] });
    A.addAssetCard(s, {
      name: "跨年设备", original_cost: 1, residual_rate: 0, useful_life_months: 4,
      start_period: "2026-11", acquired_period: "2026-11",
    });
    const periods = ["2026-11", "2026-12", "2027-01", "2027-02"];
    const amounts = periods.map((p) => A.generateDepreciation(s, p).voucher.total_debit);
    assert.deepEqual(amounts, [0.25, 0.25, 0.25, 0.25]); // 手算：1.00 ÷ 4 = 0.25
    assert.equal(A.listAssetCards(s)[0].accumulated, 1);
    assert.equal(A.accountBalances(s, "2027-02").get("1602").natural, 1);
    assert.equal(A.generateDepreciation(s, "2027-03").voucher, null);
  });

  // ================================================================ 3. 卡片与总账核对
  await test("核对：缺卡片（总账有固定资产余额但没有卡片）阻止封账，补项后解除", () => {
    const s = newSet("核对-缺卡片");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 500), e("1002", 0, 500)] });
    const blocked = A.periodEndCheck(s, "2026-01");
    const step = stepOf(blocked, "asset_reconciliation");
    assert.equal(step.status, "blocked");
    const issue = step.blocking.find((b) => b.code === "asset_missing_card");
    assert.ok(issue, JSON.stringify(step.blocking));
    assert.deepEqual(issue.details, { accountCode: "1601", kind: "asset", glBalance: 500, cardTotal: 0, difference: 500 });
    // 补项契约：显式登记取得期间（不臆造日期）与补项来源，计提从 2026-02 开始。
    A.addAssetCard(s, {
      name: "补录设备", original_cost: 500, residual_rate: 0, useful_life_months: 10,
      start_period: "2026-02", acquired_period: "2026-01", origin: "supplement",
    });
    const fixed = A.periodEndCheck(s, "2026-01");
    assert.deepEqual(codesOf(fixed), [], JSON.stringify(fixed.blocking));
    assert.equal(fixed.ready, true);
    assert.equal(stepOf(fixed, "depreciation").status, "ok", "取得期间早于计提开始期间不算应计提");
  });

  await test("核对：卡片原值与总账差异定位到科目并阻止封账，改卡片后解除", () => {
    const s = newSet("核对-原值差异");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 1000), e("1002", 0, 1000)] });
    const card = A.addAssetCard(s, {
      name: "合成设备", original_cost: 900, residual_rate: 0, useful_life_months: 60,
      start_period: "2026-02", acquired_period: "2026-01",
    });
    const blocked = A.periodEndCheck(s, "2026-01");
    const issue = stepOf(blocked, "asset_reconciliation").blocking.find((b) => b.code === "asset_cost_mismatch");
    assert.ok(issue, JSON.stringify(blocked.blocking));
    assert.equal(issue.details.glBalance, 1000);
    assert.equal(issue.details.cardTotal, 900);
    assert.equal(issue.details.difference, 100);
    assert.equal(stepOf(blocked, "period_sequence").status, "ok");
    A.updateAssetCard(s, card.id, { original_cost: 1000 });
    assert.equal(A.periodEndCheck(s, "2026-01").ready, true);
  });

  await test("核对：累计折旧与总账差异（已入账历史累计）用 opening_accumulated 补项解除", () => {
    const s = newSet("核对-累计差异");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 1000), e("1002", 0, 1000)] });
    // 历史累计折旧 100 已在总账（手工/导入凭证），但卡片还没登记这部分累计。
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("5602", 100), e("1602", 0, 100)] });
    const card = A.addAssetCard(s, {
      name: "合成设备", original_cost: 1000, residual_rate: 0, useful_life_months: 10,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    const blocked = A.periodEndCheck(s, "2026-01");
    const issue = stepOf(blocked, "asset_reconciliation").blocking.find((b) => b.code === "asset_accumulated_mismatch");
    assert.ok(issue, JSON.stringify(blocked.blocking));
    assert.equal(issue.details.glBalance, 100);
    assert.equal(issue.details.cardTotal, 0);

    A.updateAssetCard(s, card.id, { opening_accumulated: 100 });
    const after = A.periodEndCheck(s, "2026-01");
    assert.equal(codesOf(after).includes("asset_accumulated_mismatch"), false, JSON.stringify(after.blocking));
    // 剩余可计提 = 1000 − 100 = 900，本期按分期表提 100。
    const run = A.generateDepreciation(s, "2026-01");
    assert.equal(run.voucher.total_debit, 100);
    assert.equal(A.listAssetCards(s)[0].accumulated, 200);
    A.carryForwardProfit(s, "2026-01");
    const ready = A.periodEndCheck(s, "2026-01");
    assert.equal(ready.ready, true, JSON.stringify(ready.blocking));
  });

  await test("核对：缺取得期间是显式缺项（不把计提开始期间当取得日），补登记后解除", () => {
    const s = newSet("核对-缺取得期间");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 800), e("1002", 0, 800)] });
    const card = A.addAssetCard(s, {
      name: "未登记取得期间", original_cost: 800, residual_rate: 0, useful_life_months: 10,
      start_period: "2026-02",
    });
    assert.equal(card.acquired_period, null, "不得自动用 start_period 扶正");
    const blocked = A.periodEndCheck(s, "2026-01");
    const step = stepOf(blocked, "asset_reconciliation");
    assert.equal(step.status, "blocked");
    const issue = step.blocking.find((b) => b.code === "asset_acquired_period_missing");
    assert.ok(issue, JSON.stringify(step.blocking));
    assert.equal(issue.details.assetId, card.id);
    assert.equal(step.details.missingMetadata.length, 1);
    // 金额仍按“已存在”保守参与核对（不因缺元数据而误报 800 差异）。
    assert.equal(step.blocking.some((b) => b.code === "asset_cost_mismatch"), false);
    assert.equal(stepOf(blocked, "depreciation").status, "ok", "计提按 start_period，未到期");
    // 通过实际维护入口补登记后解除。
    A.updateAssetCard(s, card.id, { acquired_period: "2025-12" });
    const fixed = A.periodEndCheck(s, "2026-01");
    assert.equal(stepOf(fixed, "asset_reconciliation").status, "ok", JSON.stringify(fixed.blocking));
    assert.equal(fixed.ready, true);
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed");
  });

  await test("核对：12 月取得 / 1 月开始计提 —— 12 月仍参与原值核对，计提不适用", () => {
    const s = newSet("核对-取得与计提分离", "2025-12");
    A.setOpeningBalances(s, [e("1002", 1000), e("3001", 0, 1000)]);
    A.createVoucher(s, { period: "2025-12", status: "posted", entries: [e("1601", 1200), e("1002", 0, 1200)] });
    A.addAssetCard(s, {
      name: "十二月取得设备", original_cost: 1200, residual_rate: 0, useful_life_months: 12,
      start_period: "2026-01", acquired_period: "2025-12",
    });
    const dec = A.periodEndCheck(s, "2025-12");
    assert.equal(stepOf(dec, "asset_reconciliation").status, "ok", JSON.stringify(dec.blocking));
    assert.equal(stepOf(dec, "asset_reconciliation").details.totals.asset, 1200, "12 月必须核对原值");
    const dep = dec.steps.find((x) => x.id === "depreciation");
    assert.equal(dep.status, "ok", "未到期不是阻塞项");
    assert.equal(dep.details.cards[0].status, "not_started");
    assert.equal(A.setPeriodStatus(s, "2025-12", "closed").status, "closed", "12 月可正常封账");
  });

  await test("核对：历史卡片状态按被查询期间计算，不被后期已计提总额污染", () => {
    const s = newSet("核对-历史状态");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    A.addAssetCard(s, {
      name: "历史设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    // 先提二月与三月（历史遗留 / 导入旧库形态：前期未提、后期已提）。
    A.generateDepreciation(s, "2026-02");
    A.generateDepreciation(s, "2026-03");
    const jan = stepOf(A.periodEndCheck(s, "2026-01"), "depreciation").details.cards[0];
    // 手算：截至一月 0；全局 33.33 + 33.34 = 66.67。
    assert.equal(jan.accumulated, 0, "截至一月没有任何已过账计提");
    assert.equal(jan.accumulatedTotal, 66.67, "全局累计仅作参考值");
    assert.equal(jan.remaining, 100, "截至一月的剩余可计提额");
    assert.equal(jan.status, "due");
    assert.equal(jan.dueAmount, 33.33, "前期重算按分期表金额，不受后期已提影响");
    const feb = stepOf(A.periodEndCheck(s, "2026-02"), "depreciation").details.cards[0];
    assert.equal(feb.accumulated, 33.33, "截至二月只含二月");
    assert.equal(feb.accumulatedTotal, 66.67);
    assert.equal(feb.remaining, 66.67);
    assert.equal(feb.dueAmount, 33.33);
    const mar = stepOf(A.periodEndCheck(s, "2026-03"), "depreciation").details.cards[0];
    assert.equal(mar.accumulated, 66.67);
    assert.equal(mar.remaining, 33.33);
  });

  await test("核对：旧库已存在后期 run 时，历史应提额如实按期间口径，执行时由总额守卫明确拒绝并给撤销顺序", () => {
    const s = newSet("核对-旧库后期run");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    const card = A.addAssetCard(s, {
      name: "旧库设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    // 模拟旧库：二月按分期表已计提，三月存在历史多提的 run（合计 93.33），一月无 run。
    A.generateDepreciation(s, "2026-02");
    const feb = A.listVouchers(s, { period: "2026-02" }).find((v) => v.kind === "depreciation");
    db.prepare(
      `INSERT INTO asset_depreciation_runs (account_set_id, asset_id, period, amount, voucher_id, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(s, card.id, "2026-03", 60, feb.id, new Date().toISOString());
    const status = C.assetCardPeriodStatus(db, db.prepare("SELECT * FROM asset_cards WHERE id=?").get(card.id), "2026-01");
    assert.equal(status.accumulatedCents, 0n, "截至一月无已过账计提");
    assert.equal(status.globalAccumulatedCents, 9333n, "33.33 + 60.00（旧库多提）");
    assert.equal(status.status, "due");
    // 历史应提额只由分期表与截至本期的剩余额决定（33.33），不被后期 run 篡改成 6.67。
    assert.equal(status.amountCents, 3333n);
    // 执行时总额守卫：全局 93.33 + 本期 33.33 = 126.66 > 100 → 明确拒绝并给撤销顺序。
    const before = snapshot();
    return rejectsCode(() => A.generateDepreciation(s, "2026-01"), "depreciation_global_over_depreciable").then((err) => {
      assert.equal(err.details.assets[0].assetId, card.id);
      assert.equal(err.details.assets[0].globalAccumulated, 93.33);
      assert.equal(err.details.assets[0].dueAmount, 33.33);
      assert.match(err.details.guidance, /倒序/);
      assert.deepEqual(snapshot(), before, "拒绝时不得写入任何计提凭证 / run");
      // 按正确倒序撤销后期凭证（反过账 → 删除，连带旧库多提 run）后按期间重算。
      A.unpostVoucher(s, feb.id);
      A.deleteVoucher(s, feb.id);
      assert.deepEqual(
        ["2026-01", "2026-02", "2026-03"].map((p) => A.generateDepreciation(s, p).voucher.total_debit),
        [33.33, 33.33, 33.34], // 手算：33.33 + 33.33 + 33.34 = 100.00
      );
      assert.equal(A.listAssetCards(s)[0].accumulated, 100);
      assert.equal(A.accountBalances(s, "2026-03").get("1602").natural, 100);
    });
  });

  await test("F4：未入账登记不是原值差异的豁免──600 元卡片不得先提 10 折旧后封账", async () => {
    const s = newSet("F4-未入账登记");
    A.setOpeningBalances(s, opening(s));
    const card = A.addAssetCard(s, {
      name: "还没入账的设备", original_cost: 600, residual_rate: 0, useful_life_months: 60,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    assert.ok(codesOf(A.periodEndCheck(s, "2026-01")).includes("asset_cost_mismatch"));
    await rejectsCode(
      () => A.updateAssetCard(s, card.id, { ledger_status: "pending_purchase_voucher" }),
      "ledger_note_required",
    );
    assert.throws(() => A.updateAssetCard(s, card.id, { ledger_status: "unknown" }), /ledger_status_invalid/);
    const updated = A.updateAssetCard(s, card.id, {
      ledger_status: "pending_purchase_voucher", ledger_note: "购入凭证尚未录入，差异已人工确认",
    });
    assert.equal(updated.ledger_status, "pending_purchase_voucher");
    // 书面登记不能替代原值入账：原值差异 + 未入账缺项同时阻止，且不得计提。
    const check = A.periodEndCheck(s, "2026-01");
    const recon = stepOf(check, "asset_reconciliation");
    assert.equal(recon.status, "blocked");
    assert.ok(codesOf(check).includes("asset_cost_mismatch"), JSON.stringify(check.blocking));
    assert.ok(codesOf(check).includes("asset_purchase_voucher_pending"), JSON.stringify(check.blocking));
    const dep = stepOf(check, "depreciation");
    assert.equal(dep.status, "blocked");
    assert.ok(dep.blocking.some((b) => b.code === "asset_ledger_pending"), JSON.stringify(dep.blocking));
    const before = snapshot();
    const depErr = await rejectsCode(() => A.generateDepreciation(s, "2026-01"), "asset_ledger_pending");
    assert.match(depErr.details.guidance, /购入|入账/);
    assert.deepEqual(snapshot(), before, "未入账卡片不得生成任何折旧凭证");
    // 任意备注都不能解除阻塞（不能靠写一个理由跳过原值差异）。
    A.updateAssetCard(s, card.id, { ledger_note: "已人工确认差异，直接封账" });
    assert.ok(codesOf(A.periodEndCheck(s, "2026-01")).includes("asset_cost_mismatch"));

    // 真实补上购入入账 → 改为 booked → 才能计提 10（600 ÷ 60）。
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 600), e("1002", 0, 600)] });
    A.updateAssetCard(s, card.id, { ledger_status: "booked" });
    assert.equal(A.generateDepreciation(s, "2026-01").voucher.total_debit, 10);
    A.carryForwardProfit(s, "2026-01");
    const ready = A.periodEndCheck(s, "2026-01");
    assert.equal(ready.ready, true, JSON.stringify(ready.blocking));
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed");
    assert.equal(A.accountBalances(s, "2026-01").get("1601").natural, 600);
    assert.equal(A.accountBalances(s, "2026-01").get("1602").natural, 10);
    // 已过账计提后不能把卡片改回「未入账」来藏起原值 / 累计事实。
    await rejectsCode(() => A.updateAssetCard(s, card.id, {
      ledger_status: "pending_purchase_voucher", ledger_note: "改为待补凭证",
    }), "asset_card_affects_closed_period");
  });

  // ================================================================ F1 卡片维护与封账
  await test("F1：已封账期间的原值 / 累计 / 取得 / 起提 / 账簿状态 / 科目变更全部拒绝，纯显示信息可改", async () => {
    const s = newSet("F1-卡片维护");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    const card = A.addAssetCard(s, {
      name: "一月已核对设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-02", acquired_period: "2026-01",
    });
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed");
    assert.deepEqual(codesOf(A.periodEndCheck(s, "2026-01")), []);
    const before = snapshot();
    const cases = [
      [{ original_cost: 200 }, "asset_card_affects_closed_period"],
      [{ opening_accumulated: 10 }, "asset_card_affects_closed_period"],
      [{ acquired_period: "2025-12" }, "asset_card_affects_closed_period"],
      [{ start_period: "2026-01" }, "asset_card_affects_closed_period"],
      [{ ledger_status: "pending_purchase_voucher", ledger_note: "待补凭证" }, "asset_card_affects_closed_period"],
      [{ asset_account: "1701" }, "asset_card_affects_closed_period"],
      [{ residual_rate: 0.1 }, "asset_card_affects_closed_period"],
      [{ useful_life_months: 6 }, "asset_card_affects_closed_period"],
    ];
    for (const [patch, code] of cases) {
      const err = await rejectsCode(() => A.updateAssetCard(s, card.id, patch), code);
      assert.ok(err.details.closedPeriods.includes("2026-01"), JSON.stringify(err.details));
      assert.match(err.details.guidance, /倒序|反结账/);
    }
    await rejectsCode(() => A.deleteAssetCard(s, card.id), "asset_card_affects_closed_period");
    await rejectsCode(() => A.addAssetCard(s, {
      name: "封账后补录", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-02", acquired_period: "2026-01",
    }), "asset_card_affects_closed_period");
    assert.deepEqual(snapshot(), before, "拒绝卡片维护必须保持全库不变");
    assert.equal(A.periodStatus(s, "2026-01"), "closed");
    assert.deepEqual(codesOf(A.periodEndCheck(s, "2026-01")), [], "已封账期间的核对结论不得被静默改变");
    // 纯显示信息（名称 / 备注）可正常维护，不影响任何金额与期间事实。
    const renamed = A.updateAssetCard(s, card.id, { name: "改名后设备", ledger_note: "显示备注" });
    assert.equal(renamed.name, "改名后设备");
    assert.equal(renamed.original_cost, 100);
    assert.deepEqual(codesOf(A.periodEndCheck(s, "2026-01")), []);
    // 取得期间晚于已封账期间的卡片仍可新增（不受已封账期间影响）。
    const later = A.addAssetCard(s, {
      name: "三月新购设备", original_cost: 30, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-03", acquired_period: "2026-03",
    });
    assert.equal(later.original_cost, 30);
    // 按正确倒序反结账后可以合法维护。
    A.setPeriodStatus(s, "2026-01", "open");
    assert.equal(A.updateAssetCard(s, card.id, { original_cost: 200 }).original_cost, 200);
  });

  await test("F1：卡片写入中途故障不留下部分修改 / 半张卡片", async () => {
    const s = newSet("F1-原子性");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    const card = A.addAssetCard(s, {
      name: "原子性设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-02", acquired_period: "2026-01",
    });
    const before = snapshot();
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/UPDATE asset_cards SET name=/.test(sql)) throw new Error("inject_card_update_fail");
      return original(sql);
    };
    try {
      await rejects(() => A.updateAssetCard(s, card.id, { name: "改一半", original_cost: 120 }), /inject_card_update_fail/);
    } finally { db.prepare = original; }
    assert.deepEqual(snapshot(), before, "卡片写入失败不得留下部分字段修改");
    const unchanged = A.listAssetCards(s)[0];
    assert.equal(unchanged.name, "原子性设备");
    assert.equal(unchanged.original_cost, 100);
    db.prepare = (sql) => {
      if (/INSERT INTO asset_cards/.test(sql)) throw new Error("inject_card_insert_fail");
      return original(sql);
    };
    try {
      await rejects(() => A.addAssetCard(s, {
        name: "半张卡片", original_cost: 50, residual_rate: 0, useful_life_months: 3,
        start_period: "2026-02", acquired_period: "2026-01",
      }), /inject_card_insert_fail/);
    } finally { db.prepare = original; }
    assert.deepEqual(snapshot(), before, "新增失败不得留下半张卡片");
    assert.equal(A.listAssetCards(s).length, 1);
  });

  // ================================================================ F2 后期真实依赖
  await test("F2：普通后期损益结转依赖前期累计──前期反过账 / 新增被拒，按倒序撤销后可改并重算", async () => {
    const s = newSet("F2-普通结转依赖");
    A.setOpeningBalances(s, opening(s));
    const jan = A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", 100), e("5001", 0, 100)] });
    A.createVoucher(s, { period: "2026-02", status: "posted", entries: [e("1002", 20), e("5001", 0, 20)] });
    const febCarry = A.carryForwardProfit(s, "2026-02");
    assert.equal(febCarry.profit, 120); // 手算：一月 100（未结转）+ 二月 20 → 累计 120
    assert.equal(A.periodStatus(s, "2026-02"), "open", "后期尚未封账也必须受依赖守卫约束");
    const before = snapshot();
    const unpostErr = await rejectsCode(() => A.unpostVoucher(s, jan.id), "later_profit_carryforward_depends_on_period");
    assert.deepEqual(unpostErr.details.dependencies.map((d) => d.voucherId), [febCarry.voucher.id]);
    assert.match(unpostErr.details.guidance, /反过账/);
    await rejectsCode(() => A.createVoucher(s, {
      period: "2026-01", status: "posted", entries: [e("5602", 3), e("1002", 0, 3)],
    }), "later_profit_carryforward_depends_on_period");
    await rejectsCode(() => A.createVoucher(s, {
      period: "2026-01", status: "draft", entries: [e("5602", 3), e("1002", 0, 3)],
    }), "later_profit_carryforward_depends_on_period");
    assert.deepEqual(snapshot(), before, "拒绝后不得留下任何写入（含草稿）");
    assert.equal(A.getVoucher(s, jan.id).status, "posted");
    // 正确顺序：反过账后期结转 → 修改前期 → 重新结转。
    A.unpostVoucher(s, febCarry.voucher.id);
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("5602", 3), e("1002", 0, 3)] });
    assert.equal(A.carryForwardProfit(s, "2026-02").profit, 117, "手算：100 − 3 + 20 = 117");
    assert.equal(stepOf(A.periodEndCheck(s, "2026-02"), "profit_carry_forward").status, "ok");
    assert.equal(A.accountBalances(s, "2026-02").get("3103").natural, 117);
    // 卡片维护同样按实际影响：新增一张会从 2026-01 开始计提的卡片 → 改变 1/2 月损益，
    // 而 2 月已有已过账普通结转 → 拒绝；从 3 月才开始计提的卡片不影响已过账结转 → 允许。
    const cardDenied = await rejectsCode(() => A.addAssetCard(s, {
      name: "后期补录设备", original_cost: 30, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    }), "later_profit_carryforward_depends_on_period");
    assert.ok(cardDenied.details.dependencies.some((d) => d.period === "2026-02"));
    assert.equal(A.addAssetCard(s, {
      name: "三月新增设备", original_cost: 30, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-03", acquired_period: "2026-03",
    }).original_cost, 30);
  });

  await test("F2：后期已过账计提依赖前期计提──前期反过账被拒，按倒序撤销后重算恰好提足", async () => {
    const s = newSet("F2-计提依赖");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    A.addAssetCard(s, {
      name: "F2 设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    const janDep = A.generateDepreciation(s, "2026-01").voucher;
    const febDep = A.generateDepreciation(s, "2026-02").voucher;
    const before = snapshot();
    const err = await rejectsCode(() => A.unpostVoucher(s, janDep.id), "later_depreciation_depends_on_period");
    assert.deepEqual(err.details.runs.map((r) => r.voucherId), [febDep.id]);
    assert.match(err.details.guidance, /倒序/);
    assert.deepEqual(snapshot(), before);
    assert.equal(A.getVoucher(s, janDep.id).status, "posted");
    // 正确顺序：反过账后期计提 → 反过账前期 → 删除旧计提凭证 → 按期间重新计提。
    A.unpostVoucher(s, febDep.id);
    A.unpostVoucher(s, janDep.id);
    A.deleteVoucher(s, febDep.id);
    A.deleteVoucher(s, janDep.id);
    assert.deepEqual(
      ["2026-01", "2026-02", "2026-03"].map((p) => A.generateDepreciation(s, p).voucher.total_debit),
      [33.33, 33.33, 33.34],
    );
    assert.equal(A.listAssetCards(s)[0].accumulated, 100);
  });

  // ================================================================ F3 连续期间
  await test("F3：前期无凭证但有应计提业务 → 不得跳过并封后期；三期 33.33 / 33.33 / 33.34", async () => {
    const s = newSet("F3-零凭证计提期");
    // 只有期初资料，没有任何凭证（期初投入资产）。
    A.setOpeningBalances(s, [e("1601", 100), e("3001", 0, 100)]);
    A.addAssetCard(s, {
      name: "期初投入设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    assert.equal(A.generateDepreciation(s, "2026-02").voucher.total_debit, 33.33);
    const seq = stepOf(A.periodEndCheck(s, "2026-02"), "period_sequence");
    assert.equal(seq.status, "blocked");
    const pending = seq.blocking.find((b) => b.code === "previous_period_depreciation_pending");
    assert.ok(pending, JSON.stringify(seq.blocking));
    assert.deepEqual(pending.details.earlierDepreciationPending.map((x) => x.period), ["2026-01"]);
    assert.equal(pending.details.earlierDepreciationPending[0].assets[0].dueAmount, 33.33);
    const before = snapshot();
    const err = await rejectsCode(() => A.setPeriodStatus(s, "2026-02", "closed"), "period_end_check_failed");
    assert.ok(err.details.blocking.some((b) => b.code === "previous_period_depreciation_pending"));
    assert.deepEqual(snapshot(), before, "拒绝封账不得改变账簿与期间状态");
    assert.equal(A.periodStatus(s, "2026-02"), "open");
    // 正确顺序：一月计提 33.33 → 结转 → 封账；二月已有计提 → 结转 → 封账；三月 33.34 → 结转 → 封账。
    assert.equal(A.generateDepreciation(s, "2026-01").voucher.total_debit, 33.33);
    A.carryForwardProfit(s, "2026-01");
    A.setPeriodStatus(s, "2026-01", "closed");
    A.carryForwardProfit(s, "2026-02");
    A.setPeriodStatus(s, "2026-02", "closed");
    assert.equal(A.generateDepreciation(s, "2026-03").voucher.total_debit, 33.34);
    A.carryForwardProfit(s, "2026-03");
    A.setPeriodStatus(s, "2026-03", "closed");
    assert.equal(A.listAssetCards(s)[0].accumulated, 100);
    assert.equal(A.accountBalances(s, "2026-03").get("1602").natural, 100);
    // 真正无适用业务的空期可跳过：无资产 / 无凭证的账套直接封更晚期间。
    const empty = newSet("F3-空期可跳过");
    A.setOpeningBalances(empty, opening(empty));
    A.ensurePeriod(empty, "2026-03");
    assert.equal(A.setPeriodStatus(empty, "2026-03", "closed").status, "closed");
  });

  // ================================================================ F5 历史状态
  await test("历史状态：跨年查询 2025-12 不被 2026 年未来计提污染（not_started / 累计 0）", () => {
    const s = newSet("历史状态-跨年", "2025-12");
    A.setOpeningBalances(s, [e("1002", 1000), e("3001", 0, 1000)]);
    A.createVoucher(s, { period: "2025-12", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    A.addAssetCard(s, {
      name: "跨年历史设备", original_cost: 100, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2025-12",
    });
    for (const p of ["2026-01", "2026-02", "2026-03"]) A.generateDepreciation(s, p);
    const dec = stepOf(A.periodEndCheck(s, "2025-12"), "depreciation").details.cards[0];
    assert.equal(dec.status, "not_started", "未到计提开始期间，不得因未来已提足而报 fully_depreciated");
    assert.equal(dec.periodIndex, -1);
    assert.equal(dec.accumulated, 0);
    assert.equal(dec.accumulatedTotal, 100, "全局累计仅作参考值");
    assert.equal(dec.remaining, 100);
    assert.equal(dec.dueAmount, null);
    const feb = stepOf(A.periodEndCheck(s, "2026-02"), "depreciation").details.cards[0];
    assert.equal(feb.accumulated, 66.66, "手算：33.33 + 33.33");
    assert.equal(feb.remaining, 33.34);
    assert.equal(feb.status, "posted");
  });

  // ================================================================ 4. 封账前置
  await test("封账：无资产 / 无损益时逐步标 not_applicable，不做一刀切要求", () => {
    const s = newSet("封账-不适用");
    A.setOpeningBalances(s, opening(s));
    const check = A.periodEndCheck(s, "2026-01");
    assert.equal(stepOf(check, "depreciation").status, "not_applicable");
    assert.equal(stepOf(check, "asset_reconciliation").status, "not_applicable");
    assert.equal(stepOf(check, "profit_carry_forward").status, "not_applicable");
    assert.equal(stepOf(check, "year_end_carry_forward").status, "not_applicable");
    assert.equal(stepOf(check, "period_sequence").status, "ok");
    for (const id of ["depreciation", "asset_reconciliation", "profit_carry_forward", "year_end_carry_forward"]) {
      assert.ok(stepOf(check, id).reason, `${id} 必须说明不适用理由`);
    }
    assert.equal(check.ready, true);
    assert.deepEqual(A.setPeriodStatus(s, "2026-01", "closed"), { period: "2026-01", status: "closed" });
  });

  await test("封账：缺计提 / 缺损益结转 / 缺年末结转分别阻止并给结构化明细", async () => {
    const s = newSet("封账-缺步骤");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 300), e("1002", 0, 300)] });
    A.addAssetCard(s, {
      name: "合成设备", original_cost: 300, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1122", 100), e("5001", 0, 100)] });
    const err = await rejectsCode(() => A.setPeriodStatus(s, "2026-01", "closed"), "period_end_check_failed");
    const blockingCodes = err.details.blocking.map((b) => b.code);
    assert.ok(blockingCodes.includes("depreciation_missing"), JSON.stringify(blockingCodes));
    assert.ok(blockingCodes.includes("profit_not_carried_forward"), JSON.stringify(blockingCodes));
    const depMissing = err.details.blocking.find((b) => b.code === "depreciation_missing");
    assert.equal(depMissing.details.dueAmount, 100);
    assert.equal(A.periodStatus(s, "2026-01"), "open", "拒绝封账不得改变期间状态");

    A.generateDepreciation(s, "2026-01");
    A.carryForwardProfit(s, "2026-01");
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed");

    // 12 月：已结转损益但未做年末结转 → 阻止。
    const d = newSet("封账-年末");
    A.setOpeningBalances(d, opening(d));
    A.createVoucher(d, { period: "2026-12", status: "posted", entries: [e("1002", 50), e("5001", 0, 50)] });
    A.carryForwardProfit(d, "2026-12");
    const yearErr = await rejectsCode(() => A.setPeriodStatus(d, "2026-12", "closed"), "period_end_check_failed");
    assert.ok(yearErr.details.blocking.some((b) => b.code === "year_end_not_carried"), JSON.stringify(yearErr.details.blocking));
    A.carryForwardProfit(d, "2026-12", { yearEnd: true });
    assert.equal(A.setPeriodStatus(d, "2026-12", "closed").status, "closed");
  });

  await test("封账：连续期间顺序（先封更早期间；不得先封后期再回来封前期）", async () => {
    const s = newSet("封账-顺序");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", 10), e("5001", 0, 10)] });
    A.createVoucher(s, { period: "2026-02", status: "posted", entries: [e("1002", 20), e("5001", 0, 20)] });
    A.carryForwardProfit(s, "2026-01");
    A.carryForwardProfit(s, "2026-02");
    const err = await rejectsCode(() => A.setPeriodStatus(s, "2026-02", "closed"), "period_end_check_failed");
    assert.ok(err.details.blocking.some((b) => b.code === "previous_period_open"), JSON.stringify(err.details.blocking));
    A.setPeriodStatus(s, "2026-01", "closed");
    assert.equal(A.setPeriodStatus(s, "2026-02", "closed").status, "closed");
    // 已封账的后期不允许把前期重新打开。
    const reopen = await rejectsCode(() => A.setPeriodStatus(s, "2026-01", "open"), "later_period_closed");
    assert.deepEqual(reopen.details.laterClosedPeriods, ["2026-02"]);
    assert.match(reopen.details.guidance, /倒序/);
    A.setPeriodStatus(s, "2026-02", "open");
    assert.equal(A.setPeriodStatus(s, "2026-01", "open").status, "open");
  });

  await test("封账：重复计提 / 重复结转不重复入账，重复封账幂等", async () => {
    const s = newSet("封账-幂等");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 300), e("1002", 0, 300)] });
    A.addAssetCard(s, {
      name: "合成设备", original_cost: 300, residual_rate: 0, useful_life_months: 3,
      start_period: "2026-01", acquired_period: "2026-01",
    });
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", 90), e("5001", 0, 90)] });
    assert.equal(A.generateDepreciation(s, "2026-01").voucher.total_debit, 100);
    assert.equal(A.generateDepreciation(s, "2026-01").voucher, null, "同期不重复计提");
    A.carryForwardProfit(s, "2026-01");
    await rejects(() => A.carryForwardProfit(s, "2026-01"), /already_carried_forward/);
    const depVouchers = A.listVouchers(s, { period: "2026-01" }).filter((v) => v.kind === "depreciation");
    const carryVouchers = A.listVouchers(s, { period: "2026-01" }).filter((v) => v.kind === "carryforward");
    assert.equal(depVouchers.length, 1);
    assert.equal(carryVouchers.length, 1);
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed");
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed", "重复封账幂等");
  });

  await test("封账：结转后新增损益分录 → 检测失效并阻止；按顺序反过账重做后放行", async () => {
    const s = newSet("封账-结转失效");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", 200), e("5001", 0, 200)] });
    const carry = A.carryForwardProfit(s, "2026-01");
    // 结转之后又补一笔费用：结转凭证已不完整，不能因为“曾经执行过”就放行。
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("5602", 50), e("1002", 0, 50)] });
    const check = A.periodEndCheck(s, "2026-01");
    assert.equal(stepOf(check, "profit_carry_forward").status, "blocked");
    assert.ok(codesOf(check).includes("profit_carry_stale"), JSON.stringify(check.blocking));
    const stale = await rejectsCode(() => A.carryForwardProfit(s, "2026-01"), "carryforward_stale");
    assert.equal(stale.details.residual[0].code, "5602");
    assert.match(stale.details.guidance, /反过账/);
    const err = await rejectsCode(() => A.setPeriodStatus(s, "2026-01", "closed"), "period_end_check_failed");
    assert.ok(err.details.blocking.some((b) => b.code === "profit_carry_stale"));
    // 正确顺序：反过账旧结转 → 重新结转 → 封账。
    A.unpostVoucher(s, carry.voucher.id);
    const recarry = A.carryForwardProfit(s, "2026-01");
    assert.equal(recarry.profit, 150);
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed");
  });

  // ================================================================ 5. 反操作 / 前期变动
  await test("前期变动：更晚期间已封账时，创建 / 反过账 / 删除全部拒绝并给撤销顺序", async () => {
    const s = newSet("反操作-封锁");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-02", status: "posted", entries: [e("1002", 10), e("5001", 0, 10)] });
    const febCarry = A.carryForwardProfit(s, "2026-02");
    A.setPeriodStatus(s, "2026-02", "closed");
    // 2026-01 尚未登记：第一次在该期建账时必须被后续封账期间拦住，不能静默污染。
    const err = await rejectsCode(() => A.createVoucher(s, {
      period: "2026-01", status: "posted", entries: [e("1002", 5), e("5001", 0, 5)],
    }), "later_period_closed");
    assert.deepEqual(err.details.laterClosedPeriods, ["2026-02"]);
    assert.match(err.details.guidance, /2026-02/);
    // 按正确顺序：先反结账 2026-02，再撤销它依赖前期累计的派生凭证（普通损益结转），然后补录 2026-01。
    A.setPeriodStatus(s, "2026-02", "open");
    const blockedCarry = await rejectsCode(() => A.createVoucher(s, {
      period: "2026-01", status: "posted", entries: [e("1002", 5), e("5001", 0, 5)],
    }), "later_profit_carryforward_depends_on_period");
    assert.deepEqual(blockedCarry.details.dependencies.map((d) => d.voucherId), [febCarry.voucher.id]);
    A.unpostVoucher(s, febCarry.voucher.id);
    const jan = A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", 5), e("5001", 0, 5)] });
    assert.equal(jan.status, "posted");
    A.carryForwardProfit(s, "2026-01");
    assert.equal(A.carryForwardProfit(s, "2026-02").profit, 10, "手算：一月已结转，二月只结转本期 10");
    A.setPeriodStatus(s, "2026-01", "closed");
    A.setPeriodStatus(s, "2026-02", "closed");
    // 两个期间都已封账：已过账凭证不能直接反过账，也不能补录新凭证。
    await rejects(() => A.unpostVoucher(s, jan.id), /period_closed/);
    await rejects(() => A.createVoucher(s, {
      period: "2026-01", status: "draft", entries: [e("1002", 1), e("5001", 0, 1)],
    }), /period_closed/);
    assert.equal(A.getVoucher(s, jan.id).status, "posted", "拒绝后凭证状态不变");
  });

  await test("前期变动：更晚期间已过账年末结转时拒绝，按倒序撤销输出凭证后可改前期并重算", async () => {
    const s = newSet("反操作-年末依赖");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-11", status: "posted", entries: [e("1002", 100), e("5001", 0, 100)] });
    const dec = A.createVoucher(s, { period: "2026-12", status: "posted", entries: [e("1002", 30), e("5001", 0, 30)] });
    const carry = A.carryForwardProfit(s, "2026-12", { yearEnd: true });
    assert.ok(carry.yearEndVoucher, "12 月应生成 3103→3104 年末结转");
    assert.equal(carry.profit, 130, "手算：11 月 100 + 12 月 30（11 月未结转，累计余额一并结转）");
    const err = await rejectsCode(() => A.createVoucher(s, {
      period: "2026-11", status: "posted", entries: [e("5602", 5), e("1002", 0, 5)],
    }), "later_year_end_carryforward_depends_on_period");
    assert.equal(err.details.dependencies[0].voucherId, carry.yearEndVoucher.id);
    assert.match(err.details.guidance, /反过账/);

    // 正确顺序（倒序）：反过账 12 月年末结转 → 反过账 12 月普通结转（它依赖 11 月累计损益）
    // → 修改 11 月 → 11 月重新结转 → 12 月重新结转（含 yearEnd）→ 按期间封账。
    A.unpostVoucher(s, carry.yearEndVoucher.id);
    const profitBlocked = await rejectsCode(() => A.createVoucher(s, {
      period: "2026-11", status: "posted", entries: [e("5602", 5), e("1002", 0, 5)],
    }), "later_profit_carryforward_depends_on_period");
    assert.deepEqual(profitBlocked.details.dependencies.map((d) => d.voucherId), [carry.voucher.id]);
    A.unpostVoucher(s, carry.voucher.id);
    const fixed = A.createVoucher(s, { period: "2026-11", status: "posted", entries: [e("5602", 5), e("1002", 0, 5)] });
    assert.equal(fixed.status, "posted");
    assert.equal(A.carryForwardProfit(s, "2026-11").profit, 95, "手算：100 − 5");
    // 11 月已结转后，12 月普通结转只含 12 月本期发生额 30；3103 年末余额为 95 + 30 = 125。
    const december = A.carryForwardProfit(s, "2026-12", { yearEnd: true });
    assert.equal(december.profit, 30, "手算：11 月已结转，12 月只结转本期 30");
    assert.equal(december.yearEndVoucher.total_credit, 125, "手算：3103 余额 95 + 30 = 125 转入 3104");
    assert.equal(dec.status, "posted");
  });

  // ================================================================ 6. 故障原子性
  await test("原子性：封账写入失败时期间仍开放、账簿完全不变", async () => {
    const s = newSet("原子性-封账");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", 20), e("5001", 0, 20)] });
    A.carryForwardProfit(s, "2026-01");
    const before = snapshot();
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/UPDATE periods SET status='closed'/.test(sql)) throw new Error("inject_close_fail");
      return original(sql);
    };
    try {
      await rejects(() => A.setPeriodStatus(s, "2026-01", "closed"), /inject_close_fail/);
    } finally {
      db.prepare = original;
    }
    assert.deepEqual(snapshot(), before, "封账失败不得写入任何内容");
    assert.equal(A.periodStatus(s, "2026-01"), "open");
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed", "恢复后仍可封账");
  });

  await test("原子性：年末结转中途失败时不残留半张凭证、期间登记也不留", async () => {
    const s = newSet("原子性-结转");
    A.setOpeningBalances(s, opening(s));
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1002", 70), e("5001", 0, 70)] });
    const before = snapshot();
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/INSERT INTO vouchers\b/.test(sql)) throw new Error("inject_carry_fail");
      return original(sql);
    };
    try {
      await rejects(() => A.carryForwardProfit(s, "2026-01", { yearEnd: true }), /inject_carry_fail/);
    } finally {
      db.prepare = original;
    }
    assert.deepEqual(snapshot(), before, "失败后不得残留结转凭证或期间登记");
    assert.equal(A.listVouchers(s, { period: "2026-01" }).length, 1);
    // 未被结转阻塞住：恢复后正常结转并可封账。
    assert.equal(A.carryForwardProfit(s, "2026-01", { yearEnd: true }).profit, 70);
    assert.equal(A.setPeriodStatus(s, "2026-01", "closed").status, "closed");
  });

  // ================================================================ 7. 迁移 v3 → v4
  const MIGRATION_TABLES = `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE account_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      taxpayer_type TEXT NOT NULL DEFAULT '小规模纳税人',
      accounting_standard TEXT NOT NULL DEFAULT '小企业会计准则',
      start_period TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL,
      code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,
      contra INTEGER NOT NULL DEFAULT 0, is_leaf INTEGER NOT NULL DEFAULT 1, UNIQUE (account_set_id, code));
    CREATE TABLE opening_balances (account_set_id INTEGER NOT NULL, code TEXT NOT NULL,
      debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, PRIMARY KEY (account_set_id, code));
    CREATE TABLE periods (account_set_id INTEGER NOT NULL, period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', PRIMARY KEY (account_set_id, period));
    CREATE TABLE vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL,
      period TEXT NOT NULL, voucher_date TEXT NOT NULL, word TEXT NOT NULL DEFAULT '记', number INTEGER NOT NULL,
      summary TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'normal');
    CREATE TABLE voucher_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, voucher_id INTEGER NOT NULL,
      line_no INTEGER NOT NULL, code TEXT NOT NULL, summary TEXT,
      debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0);
    CREATE TABLE asset_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fixed', name TEXT NOT NULL, original_cost REAL NOT NULL,
      residual_rate REAL NOT NULL DEFAULT 0.05, useful_life_months INTEGER NOT NULL,
      start_period TEXT NOT NULL, asset_account TEXT NOT NULL, accum_account TEXT NOT NULL,
      expense_account TEXT NOT NULL DEFAULT '5602', created_at TEXT NOT NULL);
    CREATE TABLE asset_depreciation_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL,
      asset_id INTEGER NOT NULL, period TEXT NOT NULL, amount REAL NOT NULL, voucher_id INTEGER,
      created_at TEXT NOT NULL, UNIQUE (account_set_id, asset_id, period));
    INSERT INTO account_sets (name, start_period, created_at)
      VALUES ('v3 合成公司', '2025-12', '2025-12-01T00:00:00.000Z');
    INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, created_at)
      VALUES (1, '2025-12', '2025-12-05', '记', 1, 'v3 历史凭证', 'posted', '2025-12-05T00:00:00.000Z');
    INSERT INTO voucher_entries (voucher_id, line_no, code, debit, credit) VALUES (1, 1, '1601', 1200, 0);
    INSERT INTO voucher_entries (voucher_id, line_no, code, debit, credit) VALUES (1, 2, '3001', 0, 1200);
    INSERT INTO asset_cards (account_set_id, kind, name, original_cost, residual_rate, useful_life_months,
      start_period, asset_account, accum_account, expense_account, created_at)
      VALUES (1, 'fixed', 'v3 历史设备', 1200, 0, 12, '2025-12', '1601', '1602', '5602', '2025-12-31T00:00:00.000Z');
  `;
  const columnNames = (conn, table) => conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  await test("迁移 v3→v4：升级前一致备份（含 WAL 数据）、列与默认值正确、备份可恢复", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-v4-mig-"));
    let base, migrator;
    try {
      const file = join(dir, "workbench.db");
      base = new DatabaseSync(file);
      base.exec(MIGRATION_TABLES);
      const v3 = S.ensureImportSchema(base, { dataDir: dir, targetVersion: 3 });
      assert.equal(v3.to, 3);
      assert.deepEqual(columnNames(base, "asset_cards").filter((c) => ["acquired_period", "opening_accumulated",
        "ledger_status", "ledger_note", "origin"].includes(c)), [], "v3 不应有新列");
      // WAL 中保留刚写入的卡片行（不 checkpoint），验证备份确实含未落主文件数据。
      const wal = `${file}-wal`;
      assert.ok(existsSync(wal) && statSync(wal).size > 0, "v3 库应存在未 checkpoint 的 WAL");

      const out = S.ensureImportSchema(base, { dataDir: dir });
      assert.equal(out.from, 3);
      assert.equal(out.to, S.IMPORT_SCHEMA_VERSION);
      assert.ok(out.backup?.path && existsSync(out.backup.path));
      const columns = columnNames(base, "asset_cards");
      for (const name of ["acquired_period", "opening_accumulated", "ledger_status", "ledger_note", "origin"]) {
        assert.ok(columns.includes(name), `缺少列 ${name}`);
      }
      const card = base.prepare("SELECT * FROM asset_cards").get();
      assert.equal(card.original_cost, 1200, "旧业务数据必须保留");
      assert.equal(card.acquired_period, null, "取得期间留空，不臆造日期");
      assert.equal(card.opening_accumulated, 0);
      assert.equal(card.ledger_status, "booked");
      assert.equal(card.ledger_note, "");
      assert.equal(card.origin, "purchase");

      // 备份保持迁移前结构，且能作为完整库恢复（含 WAL 中已提交的卡片行）。
      const restored = join(dir, "restored-v3.db");
      copyFileSync(out.backup.path, restored);
      const probe = new DatabaseSync(restored, { readOnly: true });
      try {
        assert.equal(probe.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.equal(probe.prepare("SELECT COUNT(*) n FROM asset_cards").get().n, 1);
        assert.equal(probe.prepare("SELECT name FROM asset_cards").get().name, "v3 历史设备");
        assert.equal(
          columnNames(probe, "asset_cards").includes("ledger_status"), false,
          "备份必须是迁移前结构（没有 v4 新列）",
        );
      } finally { probe.close(); }
    } finally {
      try { migrator?.close(); } catch { /* ignore */ }
      try { base?.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("迁移 v3→v4：中途失败整体回滚（版本仍 3、无半截新列、业务数据不变），并保留备份", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-v4-migfail-"));
    let base;
    try {
      const file = join(dir, "workbench.db");
      base = new DatabaseSync(file);
      base.exec(MIGRATION_TABLES);
      S.ensureImportSchema(base, { dataDir: dir, targetVersion: 3 });
      // 故障注入：第 3 条 ALTER 时抛错，模拟迁移中途失败（不给生产代码留后门）。
      const originalExec = base.exec.bind(base);
      let alters = 0;
      base.exec = (sql) => {
        if (/ALTER TABLE asset_cards ADD COLUMN/.test(sql)) {
          alters += 1;
          if (alters === 3) throw new Error("inject_migration_fail");
        }
        return originalExec(sql);
      };
      let thrown = null;
      try { S.ensureImportSchema(base, { dataDir: dir }); } catch (err) { thrown = err; }
      base.exec = originalExec;
      assert.ok(thrown, "迁移失败必须抛出");
      assert.equal(thrown.message, "migration_failed");
      assert.equal(thrown.details.from, 3);
      assert.ok(thrown.details.backupPath && existsSync(thrown.details.backupPath), "失败也保留迁移前备份");
      assert.equal(S.schemaVersion(base), 3, "版本记录必须随事务回滚");
      const columns = columnNames(base, "asset_cards");
      assert.equal(columns.includes("acquired_period"), false, "已执行的 ALTER 也必须回滚");
      assert.equal(columns.includes("ledger_status"), false);
      assert.equal(base.prepare("SELECT name FROM asset_cards").get().name, "v3 历史设备");
      assert.equal(base.prepare("SELECT COUNT(*) n FROM vouchers").get().n, 1);

      // 去掉故障后可正常升级（重新备份，不复用失败尝试的孤儿备份）。
      const retry = S.ensureImportSchema(base, { dataDir: dir });
      assert.equal(retry.to, S.IMPORT_SCHEMA_VERSION);
      assert.equal(retry.migrated, true);
      assert.notEqual(retry.backup.path, thrown.details.backupPath, "重试必须重新备份");
      assert.ok(columnNames(base, "asset_cards").includes("ledger_status"));
      assert.equal(base.prepare("SELECT name FROM asset_cards").get().name, "v3 历史设备");
    } finally {
      try { base?.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("迁移后：v3 旧卡片默认参与核对（缺省 booked），不会被静默排除", () => {
    const s = newSet("迁移默认值");
    A.createVoucher(s, { period: "2026-01", status: "posted", entries: [e("1601", 100), e("1002", 0, 100)] });
    // 模拟迁移前的行：只写旧列，其余取数据库默认值。
    db.prepare(
      `INSERT INTO asset_cards (account_set_id, kind, name, original_cost, residual_rate, useful_life_months,
         start_period, asset_account, accum_account, expense_account, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(s, "fixed", "默认列设备", 90, 0, 10, "2026-02", "1601", "1602", "5602", new Date().toISOString());
    const step = stepOf(A.periodEndCheck(s, "2026-01"), "asset_reconciliation");
    assert.equal(step.status, "blocked", "默认 booked 的卡片应参与核对并暴露差异");
    assert.equal(step.details.pendingLedger.length, 0, "旧库行不得被静默当作“已入账”以外的旁路");
    assert.ok(step.blocking.some((b) => b.code === "asset_cost_mismatch"));
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
