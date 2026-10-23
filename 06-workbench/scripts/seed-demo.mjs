#!/usr/bin/env node
/**
 * 演示数据种子：重建一个「已知且可验收」的账套。
 *
 *   node scripts/seed-demo.mjs            # 仅在空库时执行
 *   node scripts/seed-demo.mjs --force    # 清空后重建
 *
 * 产出（用于验收，数字固定）：
 *   账套 示例贸易有限公司 2026-01 启用
 *   期初 1002 借 100000 / 3001 贷 100000
 *   2026-01: 销售 11300（应收）、支付管理费 2000
 *   2026-02: 收回应收 11300、计提工资 5000、计提折旧 1900
 *   资产 运输车辆 120000/5%/60期 → 月计提 1900（已提 2026-02 一期）
 *   预期：2026-01 净利 8000；2026-02 本期 -6900 累计 1100；
 *        2026-02 资产 107400 = 负债 6300 + 权益 101100；现金流经营 11300 且勾稽
 */
import * as A from "../server/accounting.mjs";
import { db } from "../server/db.mjs";

const force = process.argv.includes("--force");
const n = db.prepare("SELECT COUNT(*) n FROM account_sets").get().n;
if (n > 0 && !force) {
  console.error(`已存在 ${n} 个账套；如需重建请执行： node scripts/seed-demo.mjs --force`);
  process.exit(1);
}
if (force) {
  for (const t of ["voucher_entries", "vouchers", "opening_balances", "asset_depreciation_runs",
    "asset_cards", "periods", "accounts", "account_sets"]) {
    db.exec(`DELETE FROM ${t}`);
  }
  // 重置自增，让演示账套回到 id=1
  db.exec("DELETE FROM sqlite_sequence");
}

const set = A.createAccountSet({
  enterprise: { enterpriseKey: "SYNTHETIC-DEMO-TRADE-001" },
  name: "示例贸易有限公司", taxpayer_type: "小规模纳税人",
  accounting_standard: "小企业会计准则", start_period: "2026-01",
});
const id = set.id;

A.setOpeningBalances(id, [
  { code: "1002", debit: 100000, credit: 0 },
  { code: "3001", debit: 0, credit: 100000 },
]);

const v = (o) => A.createVoucher(id, { ...o, status: "posted" });
v({ period: "2026-01", voucher_date: "2026-01-10", summary: "销售商品", entries: [
  { code: "1122", summary: "销售", debit: 11300, credit: 0 },
  { code: "5001", summary: "销售", debit: 0, credit: 10000 },
  { code: "2221", summary: "销项税", debit: 0, credit: 1300 }] });
v({ period: "2026-01", voucher_date: "2026-01-20", summary: "支付管理费", entries: [
  { code: "5602", summary: "办公费", debit: 2000, credit: 0 },
  { code: "1002", summary: "付款", debit: 0, credit: 2000 }] });
v({ period: "2026-02", voucher_date: "2026-02-05", summary: "收到货款", entries: [
  { code: "1002", summary: "收款", debit: 11300, credit: 0 },
  { code: "1122", summary: "收款", debit: 0, credit: 11300 }] });
v({ period: "2026-02", voucher_date: "2026-02-25", summary: "计提工资", entries: [
  { code: "5602", summary: "工资", debit: 5000, credit: 0 },
  { code: "2211", summary: "应付工资", debit: 0, credit: 5000 }] });

A.addAssetCard(id, {
  kind: "fixed", name: "运输车辆", original_cost: 120000,
  residual_rate: 0.05, useful_life_months: 60, start_period: "2026-01",
});
A.generateDepreciation(id, "2026-02");

const bs = A.balanceSheet(id, "2026-02");
const is = A.incomeStatement(id, "2026-02");
const cf = A.cashFlowStatement(id, "2026-02");
console.log(`演示账套已生成：#${id} ${set.name} ${set.start_period}`);
console.log(`  凭证 ${A.listVouchers(id).length} 张，资产 ${A.listAssetCards(id).length} 个`);
console.log(`  2026-01 净利 ${A.incomeStatement(id, "2026-01").current["净利润"]}`);
console.log(`  2026-02 本期净利 ${is.current["净利润"]}，累计 ${is.ytd["净利润"]}`);
console.log(`  2026-02 资产负债表 资产 ${bs.totals.assets} = 负债 ${bs.totals.liabilities} + 权益 ${bs.totals.equity}，平衡 ${bs.balanced}`);
console.log(`  2026-02 现金流量表 经营 ${cf.totals.operating}，净增 ${cf.totals.net_increase}，勾稽 ${cf.reconciles}`);
