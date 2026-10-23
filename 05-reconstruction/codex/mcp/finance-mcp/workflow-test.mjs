#!/usr/bin/env node
// Fixed synthetic test identities, independent of display names and production defaults.
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-workflow-test-mjs-' + (++identityFixtureSequence) });

/**
 * workflow-test.mjs — MCP → 临时后端「导入旧账 → 日常记账 → 资产折旧 → 结转 → 封账 → 报表」闭环验收
 * （LOCAL-08 模型信封版）
 *
 * 与 contract-test.mjs 的分工：contract 关注工具契约与错误路径，本文件关注一条可复算的
 * 业务闭环，并逐项核对金额。LOCAL-08 起 MCP 普通工具返回**模型投影信封**，因此：
 *   - 摘要金额直接断言 projection（手算常量）；
 *   - 逐行 / 原文字段（报表行、凭证 kind、卡片 monthly 等）经本机引用接口读取；
 *   - 业务校验摘要经本机 raw 通道（`/agent/tools/*`）核对。
 *
 * 运行：node workflow-test.mjs
 * 后端：脚本自行拉起（FINANCE_API_BASE 由脚本注入），无需外部服务，不连接 8787 / 工程 data。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { McpStdioClient } from "./mcp-stdio-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const WORKBENCH = join(REPO, "06-workbench", "server", "server.mjs");
const REAL_DATA = resolve(join(REPO, "06-workbench", "data"));
const FIXTURES = join(here, "..", "..", "..", "examples", "legacy-book");
const FIXTURE_PATHS = Object.fromEntries(
  ["meta", "accounts", "openings", "vouchers"].map((k) => [k, join(FIXTURES, `${k}.csv`)])
);

function fixtureExpectations() {
  const csv = (file) =>
    readFileSync(join(FIXTURES, file), "utf8").replace(/^\uFEFF/, "").trim()
      .split(/\r?\n/).filter(Boolean).map((line) => line.split(","));

  const metaRows = csv("meta.csv").slice(1);
  const meta = Object.fromEntries(metaRows.map((r) => [r[0], r[1]]));
  const openings = csv("openings.csv").slice(1);
  const vouchers = csv("vouchers.csv").slice(1);

  const net = new Map();
  const add = (code, v) => net.set(code, (net.get(code) || 0) + v);
  for (const [code, debit, credit] of openings) add(code, Number(debit) - Number(credit));
  for (const r of vouchers) add(r[5], Number(r[6]) - Number(r[7]));

  const raw = (code) => net.get(code) || 0;
  const naturalCredit = (code) => -raw(code);
  const revenue = naturalCredit("5001");
  const cost = raw("5401");
  const profit = revenue - cost;
  const liabilities = naturalCredit("2221");
  const capital = naturalCredit("3001");
  let closingDebit = 0, closingCredit = 0;
  for (const v of net.values()) {
    if (v > 0) closingDebit += v;
    else closingCredit += -v;
  }
  return {
    name: meta["账套名称"], startPeriod: meta["启用期间"],
    accounts: csv("accounts.csv").length - 1,
    openingBalances: openings.length,
    vouchers: new Set(vouchers.map((r) => `${r[0]}|${r[2]}|${r[3]}`)).size,
    assets: raw("1002") + raw("1122") + raw("1405"),
    liabilities, capital, revenue, cost, profit,
    equity: capital + profit,
    closingDebit, closingCredit,
  };
}

/** 主账套业务金额（手写常量，来自后端之外）。 */
const MAIN = {
  openingBank: 200000, openingCapital: 200000,
  saleReceivable: 11300, saleRevenue: 10000, saleTax: 1300,
  adminExpense: 2000,
  assetCost: 60000, residualRate: 0.05, lifeMonths: 60,
  monthlyDepreciation: 950,
  depreciable: 57000,
  cashEnd: 138000,
  cashFlowOperating: -2000,
  cashFlowInvesting: -60000,
  cashFlowNet: -62000,
  netProfit: 7050,
  assets: 208350,
  liabilities: 1300,
  equity: 207050,
};

const dataDir = mkdtempSync(join(tmpdir(), "mcp-workflow-"));
let backend = null;
let client = null;
let BASE = "";

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolvePort(port)); });
  });
}
async function waitReady(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("backend_not_ready");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const eq = (actual, expected, msg) =>
  assert.equal(actual === 0 ? 0 : actual, expected === 0 ? 0 : expected, msg);

async function okCall(name, args, label = name) {
  const r = await client.call(name, args);
  assert.equal(r.isError, false, `${label} 失败：${r.text}`);
  assert.equal(r.data.ok, true, `${label} 应 ok=true`);
  return r.data;
}
async function failCall(name, args, code, label = name) {
  const r = await client.call(name, args);
  assert.equal(r.isError, true, `${label} 应失败但成功：${r.text}`);
  const actual = typeof r.data?.error === "string" ? r.data.error : r.data?.error?.code;
  assert.equal(actual, code, `${label} 错误码 ${code}，实际 ${actual}：${r.text}`);
  return r.data;
}
async function localValue(envelope, label = envelope.tool) {
  assert.match(String(envelope.localRef), /^finref_[a-f0-9]{48}$/, `${label} 应有 localRef`);
  const res = await fetch(`${BASE}/api/finance-output/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: envelope.localRef, accountSetId: envelope.accountSetId, operation: envelope.operation }),
  });
  const data = await res.json();
  assert.equal(res.status, 200, `${label} 本机读取应 200：${JSON.stringify(data)}`);
  return data.value;
}
async function rawAgent(name, args) {
  const res = await fetch(`${BASE}/agent/tools/${name}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const trialProjection = async (setId, period) =>
  (await okCall("finance_query", { nodeId: "report.trial_balance", accountSetId: setId, period })).projection;
const trialRaw = async (setId, period) =>
  localValue(await okCall("finance_query", { nodeId: "report.trial_balance", accountSetId: setId, period }), "trial_balance");
const balanceProjection = async (setId, period) =>
  (await okCall("finance_query", { nodeId: "report.balance_sheet", accountSetId: setId, period })).projection;
const balanceRaw = async (setId, period) =>
  localValue(await okCall("finance_query", { nodeId: "report.balance_sheet", accountSetId: setId, period }), "balance_sheet");
const incomeProjection = async (setId, period) =>
  (await okCall("finance_query", { nodeId: "report.income_statement", accountSetId: setId, period })).projection;
const incomeRaw = async (setId, period) =>
  localValue(await okCall("finance_query", { nodeId: "report.income_statement", accountSetId: setId, period }), "income_statement");
const cashFlowProjection = async (setId, period) =>
  (await okCall("finance_query", { nodeId: "report.cash_flow_statement", accountSetId: setId, period })).projection;
const cashFlowRaw = async (setId, period) =>
  localValue(await okCall("finance_query", { nodeId: "report.cash_flow_statement", accountSetId: setId, period }), "cash_flow");
const bsLine = (bs, label) => [...bs.assets, ...bs.liabilities].find((l) => l.label === label).value;

async function snapshot(setId, period) {
  const tb = await trialRaw(setId, period);
  const bsEnvelope = await okCall("finance_query", { nodeId: "report.balance_sheet", accountSetId: setId, period });
  const bs = await localValue(bsEnvelope, "snapshot balance sheet");
  const posted = (await localValue(await okCall("finance_query", {
    nodeId: "voucher.generated.list", accountSetId: setId, period,
  }), "posted vouchers")).map((v) => `${v.id}:${v.status}:${v.total_debit}:${v.total_credit}`).sort();
  const drafts = (await localValue(await okCall("finance_query", {
    nodeId: "voucher.draft.summary", accountSetId: setId, period,
  }), "draft vouchers")).map((v) => `${v.id}:${v.status}`).sort();
  return {
    tb: tb.totals,
    bs: { assets: bs.totals.assets, liabilities: bs.totals.liabilities, equity: bs.totals.equity, balanced: bs.balanced },
    posted, drafts,
  };
}

const FIX = fixtureExpectations();

try {
  if (REAL_DATA === resolve(dataDir)) throw new Error("临时数据目录不得指向工程 data/");

  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;

  backend = spawn(process.execPath, [WORKBENCH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", WORKBENCH_DATA_DIR: dataDir },
  });
  let backendErr = "";
  backend.stderr.on("data", (d) => { backendErr += d; });
  backend.on("exit", (code) => { if (code) backendErr += `\nbackend exited code=${code}`; });
  await waitReady(BASE);

  client = new McpStdioClient(join(here, "server.mjs"), {
    env: { FINANCE_API_BASE: BASE, FINANCE_API_TIMEOUT_MS: "10000" },
    timeoutMs: 20000,
  }).start();

  console.log(`\nMCP 闭环验收 @ ${BASE}（临时数据目录 ${dataDir}）\n`);
  await client.initialize("workflow");

  let importedSetId = null;
  let mainSetId = null;
  let salesVoucherId = null;
  let closedSnapshot = null;

  await test("导入：4 张示例 CSV 经 paths 预检不落库（默认 dryRun=true）", async () => {
    const before = await okCall("account_context", {});
    const r = await okCall("legacy_book_import", { enterprise: identityFixture(), paths: FIXTURE_PATHS });
    assert.equal(r.applied, false);
    assert.equal(r.appliedReason, "dry_run");
    assert.equal(r.accountSetId, null);
    assert.equal(r.projection.dryRun, true);
    assert.equal(r.projection.validationOk, true);
    // 业务明细计数走本机 raw 通道核对（模型通道只给固定摘要）；raw 路由不接受 paths，先把本机 CSV 读成 texts。
    const fixtureTexts = Object.fromEntries(Object.entries(FIXTURE_PATHS).map(([key, file]) => [key, readFileSync(file, "utf8")]));
    const raw = await rawAgent("legacy_book_import", { enterprise: identityFixture(), texts: fixtureTexts });
    assert.equal(raw.status, 200, JSON.stringify(raw.data));
    assert.equal(raw.data.created, null);
    assert.equal(raw.data.validation.ok, true, JSON.stringify(raw.data.validation.errors));
    assert.equal(raw.data.validation.summary.account_set, FIX.name);
    assert.equal(raw.data.validation.summary.accounts, FIX.accounts);
    assert.equal(raw.data.validation.summary.opening_balances, FIX.openingBalances);
    assert.equal(raw.data.validation.summary.vouchers, FIX.vouchers);
    const after = await okCall("account_context", {});
    assert.equal(after.projection.accountSetCount, before.projection.accountSetCount, "预检不得新增账套");
  });

  await test("导入：显式 dryRun=false 才正式导入示例账套（setId 取真实结果）", async () => {
    const r = await okCall("legacy_book_import", { enterprise: identityFixture(), paths: FIXTURE_PATHS, dryRun: false });
    assert.equal(r.applied, true);
    assert.equal(r.accountSetIdSource, "result");
    importedSetId = r.projection.createdAccountSetId;
    assert.ok(importedSetId > 0);
    const raw = await localValue(r, "legacy_book_import");
    assert.equal(raw.dryRun, false);
    assert.equal(raw.created.name, FIX.name);
    assert.equal(raw.created.start_period, FIX.startPeriod);
    assert.equal(raw.created.vouchers, FIX.vouchers);
    assert.equal(raw.created.opening_balances, FIX.openingBalances);
    assert.ok(raw.created.accounts >= 55, `标准科目数 ${raw.created.accounts}`);
    assert.equal(raw.created.id, importedSetId);
  });

  await test("导入：示例结果与独立推算一致（资产/负债/权益/利润/试算）", async () => {
    const period = FIX.startPeriod;
    const bs = await balanceProjection(importedSetId, period);
    const is = await incomeProjection(importedSetId, period);
    const tb = await trialProjection(importedSetId, period);
    eq(bs.assets, FIX.assets, "资产总计");
    eq(bs.liabilities, FIX.liabilities, "负债合计");
    eq(bs.equity, FIX.equity, "所有者权益合计");
    assert.equal(bs.balanced, true, "示例导入后资产负债表应平衡");
    eq(is.currentNetProfit, FIX.profit, "示例账套本期净利润");
    eq(is.currentRevenue, FIX.revenue, "示例账套营业收入");
    eq(is.currentCost, FIX.cost, "示例账套营业成本");
    eq(tb.closingDebit, FIX.closingDebit, "试算期末借方");
    eq(tb.closingCredit, FIX.closingCredit, "试算期末贷方");
    const bsRaw = await balanceRaw(importedSetId, period);
    assert.ok([...bsRaw.assets, ...bsRaw.liabilities].some((line) => line.label === "货币资金"));
  });

  await test("业务：新建单一临时账套并录入已知期初（借贷平衡）", async () => {
    const s = await okCall("account_set_create", { enterprise: identityFixture(),
      name: "闭环验收公司", taxpayer_type: "一般纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    mainSetId = s.accountSetId;
    assert.ok(mainSetId > 0 && mainSetId !== importedSetId);
    await okCall("opening_balance_set", {
      accountSetId: mainSetId,
      items: [
        { code: "1002", debit: MAIN.openingBank, credit: 0 },
        { code: "3001", debit: 0, credit: MAIN.openingCapital },
      ],
    });
    const g = await okCall("opening_balance_get", { accountSetId: mainSetId });
    eq(g.projection.totalDebit, MAIN.openingBank, "期初借方合计");
    const raw = await localValue(g, "opening_balance_get");
    eq(raw.items.find((o) => o.code === "1002").debit, MAIN.openingBank);
    eq(raw.items.find((o) => o.code === "3001").credit, MAIN.openingCapital);
  });

  await test("业务：上下文不持久保存账套，finance_query 缺 accountSetId 仍被拒", async () => {
    const ctx = await okCall("account_context", { accountSetId: mainSetId });
    assert.equal(ctx.scope, "account_set");
    assert.equal(ctx.projection.persisted, false);
    const global = await okCall("account_context", {});
    assert.equal(global.scope, "global");
    assert.equal(global.accountSetId, null);
    await failCall("finance_query", { nodeId: "report.income_statement", period: "2026-01" },
      "invalid_arguments", "finance_query 缺 accountSetId");
  });

  await test("业务：销售凭证 校验→创建草稿→过账", async () => {
    const entries = [
      { code: "1122", debit: MAIN.saleReceivable, credit: 0, summary: "销售商品" },
      { code: "5001", debit: 0, credit: MAIN.saleRevenue, summary: "销售商品" },
      { code: "2221", debit: 0, credit: MAIN.saleTax, summary: "销售商品" },
    ];
    const chk = await okCall("voucher_check", { accountSetId: mainSetId, entries });
    assert.equal(chk.projection.checkOk, true);
    const draft = await okCall("voucher_create", {
      accountSetId: mainSetId, period: "2026-01", voucher_date: "2026-01-10", summary: "销售商品", entries,
    });
    assert.equal(draft.projection.status, "draft", "默认必须为草稿");
    eq(draft.projection.totalDebit, MAIN.saleReceivable);
    eq(draft.projection.totalCredit, MAIN.saleReceivable);
    const posted = await okCall("voucher_post", { accountSetId: mainSetId, voucherId: draft.projection.voucherId });
    assert.equal(posted.projection.status, "posted");
    salesVoucherId = draft.projection.voucherId;
  });

  await test("业务：费用凭证 校验→创建草稿→过账", async () => {
    const entries = [
      { code: "5602", debit: MAIN.adminExpense, credit: 0, summary: "支付管理费" },
      { code: "1002", debit: 0, credit: MAIN.adminExpense, summary: "支付管理费" },
    ];
    const chk = await okCall("voucher_check", { accountSetId: mainSetId, entries });
    assert.equal(chk.projection.checkOk, true);
    const draft = await okCall("voucher_create", {
      accountSetId: mainSetId, period: "2026-01", voucher_date: "2026-01-20", summary: "支付管理费", entries,
    });
    assert.equal(draft.projection.status, "draft");
    await okCall("voucher_post", { accountSetId: mainSetId, voucherId: draft.projection.voucherId });
  });

  await test("资产：购入凭证（借 1601 / 贷 1002）校验→创建→过账", async () => {
    const entries = [
      { code: "1601", debit: MAIN.assetCost, credit: 0, summary: "购入生产设备" },
      { code: "1002", debit: 0, credit: MAIN.assetCost, summary: "购入生产设备" },
    ];
    const chk = await okCall("voucher_check", { accountSetId: mainSetId, entries });
    assert.equal(chk.projection.checkOk, true);
    const draft = await okCall("voucher_create", {
      accountSetId: mainSetId, period: "2026-01", voucher_date: "2026-01-25", summary: "购入生产设备", entries,
    });
    assert.equal(draft.projection.status, "draft");
    await okCall("voucher_post", { accountSetId: mainSetId, voucherId: draft.projection.voucherId });
  });

  await test("资产：卡片单独创建，原值/残值/期数明确，月折旧 950", async () => {
    const card = await okCall("asset_create", {
      accountSetId: mainSetId, kind: "fixed", name: "生产设备",
      original_cost: MAIN.assetCost, residual_rate: MAIN.residualRate,
      useful_life_months: MAIN.lifeMonths, start_period: "2026-01", acquired_period: "2026-01",
    });
    assert.equal(card.applied, true);
    eq(card.projection.originalCost, MAIN.assetCost);
    eq(card.projection.usefulLifeMonths, MAIN.lifeMonths);
    const raw = await localValue(card, "asset_create");
    eq(raw.original_cost, MAIN.assetCost);
    eq(raw.residual_rate, MAIN.residualRate);
    eq(raw.useful_life_months, MAIN.lifeMonths);
    eq(raw.depreciable, MAIN.depreciable);
    eq(raw.monthly, MAIN.monthlyDepreciation);
    eq(raw.accumulated, 0);
  });

  await test("资产：卡片本身不增加固定资产账面原价（1601 仍为 60000）", async () => {
    const tb = await trialRaw(mainSetId, "2026-01");
    const line1601 = tb.lines.find((l) => l.code === "1601");
    eq(line1601.closing_debit, MAIN.assetCost, "1601 账面原价");
    const gl = await okCall("ledger_query", { accountSetId: mainSetId, code: "1601", period: "2026-01" });
    eq(gl.projection.itemCount, 1, "1601 只应有购入凭证一笔");
    const rawGl = await localValue(gl, "ledger_query");
    eq(rawGl.items[0].balance, MAIN.assetCost);
  });

  await test("资产：2026-01 计提月折旧 950 并生成折旧凭证", async () => {
    const r = await okCall("depreciation_run", { accountSetId: mainSetId, period: "2026-01" });
    assert.ok(r.projection.voucherId > 0, "应生成折旧凭证");
    eq(r.projection.totalAmount, MAIN.monthlyDepreciation);
    eq(r.projection.runCount, 1);
    const raw = await localValue(r, "depreciation_run");
    assert.equal(raw.voucher.kind, "depreciation");
    eq(raw.voucher.total_debit, MAIN.monthlyDepreciation);
    eq(raw.voucher.total_credit, MAIN.monthlyDepreciation);
    assert.equal(raw.runs.length, 1);
    eq(raw.runs[0].amount, MAIN.monthlyDepreciation);
    const cards = await okCall("asset_list", { accountSetId: mainSetId });
    eq(cards.projection.cardCount, 1);
    eq(cards.projection.totalAccumulated, MAIN.monthlyDepreciation);
    const rawCards = await localValue(cards, "asset_list");
    eq(rawCards[0].accumulated, MAIN.monthlyDepreciation);
  });

  await test("结转前：利润表净利润 7050，资产负债表平衡且权益含未结转损益", async () => {
    const is = await incomeProjection(mainSetId, "2026-01");
    eq(is.currentRevenue, MAIN.saleRevenue);
    eq(is.currentExpenses, MAIN.adminExpense + MAIN.monthlyDepreciation);
    eq(is.currentNetProfit, MAIN.netProfit);
    const bs = await balanceProjection(mainSetId, "2026-01");
    assert.equal(bs.balanced, true);
    eq(bs.assets, MAIN.assets);
    eq(bs.liabilities, MAIN.liabilities);
    eq(bs.equity, MAIN.equity);
    const bsRaw = await balanceRaw(mainSetId, "2026-01");
    eq(bsLine(bsRaw, "未分配利润"), MAIN.netProfit, "结转前未分配利润应等于本期利润");
  });

  await test("现金流：直接法经营 −2000 / 投资 −60000，与货币资金变动勾稽", async () => {
    const cf = await cashFlowProjection(mainSetId, "2026-01");
    eq(cf.operating, MAIN.cashFlowOperating, "经营活动净额");
    eq(cf.investing, MAIN.cashFlowInvesting, "投资活动净额");
    eq(cf.financing, 0, "筹资活动净额");
    eq(cf.netIncrease, MAIN.cashFlowNet, "现金净增加额");
    eq(cf.cashBegin, MAIN.openingBank, "期初货币资金");
    eq(cf.cashEnd, MAIN.cashEnd, "期末货币资金");
    eq(cf.cashChange, MAIN.cashFlowNet, "货币资金变动");
    assert.equal(cf.reconciles, true, "直接法净额应与货币资金变动勾稽");
    const raw = await cashFlowRaw(mainSetId, "2026-01");
    eq(raw.supplement_indirect["净利润"], MAIN.netProfit);
    eq(raw.supplement_indirect["加_折旧与摊销"], MAIN.monthlyDepreciation);
  });

  await test("结转：carry_forward_profit 生成已过账损益结转凭证", async () => {
    const r = await okCall("carry_forward_profit", { accountSetId: mainSetId, period: "2026-01" });
    eq(r.projection.profit, MAIN.netProfit);
    assert.ok(r.projection.voucherId > 0, "应生成损益结转凭证");
    assert.equal(r.projection.yearEndVoucherId, undefined, "未要求年末结转时不应生成 3103→3104");
    const raw = await localValue(r, "carry_forward_profit");
    assert.equal(raw.voucher.kind, "carryforward");
    assert.equal(raw.voucher.status, "posted");
    eq(raw.yearEndVoucher, null, "未要求年末结转时不应生成 3103→3104");
  });

  await test("结转后：利润不重复（净利润仍 7050，未分配利润不翻倍）", async () => {
    const is = await incomeProjection(mainSetId, "2026-01");
    eq(is.currentNetProfit, MAIN.netProfit, "结转凭证不得计入利润表");
    const tb = await trialRaw(mainSetId, "2026-01");
    for (const code of ["5001", "5602"]) {
      const line = tb.lines.find((l) => l.code === code);
      eq(line.closing_debit + line.closing_credit, 0, `${code} 结转后应归零`);
    }
    const bs = await balanceProjection(mainSetId, "2026-01");
    assert.equal(bs.balanced, true);
    eq(bs.assets, MAIN.assets);
    const bsRaw = await balanceRaw(mainSetId, "2026-01");
    eq(bsLine(bsRaw, "未分配利润"), MAIN.netProfit, "结转后未分配利润仍应为本期利润");
  });

  await test("勾稽：资产卡原值/累计折旧与总账 1601/1602 一致（独立预期）", async () => {
    const cards = await localValue(await okCall("asset_list", { accountSetId: mainSetId }), "asset_list");
    const tb = await trialRaw(mainSetId, "2026-01");
    eq(cards[0].original_cost, MAIN.assetCost, "卡片原值");
    eq(tb.lines.find((l) => l.code === "1601").closing_debit, MAIN.assetCost, "总账固定资产原价");
    eq(cards[0].accumulated, MAIN.monthlyDepreciation, "卡片累计折旧");
    eq(tb.lines.find((l) => l.code === "1602").closing_credit, MAIN.monthlyDepreciation, "总账累计折旧");
  });

  await test("封账：2026-01 结账成功且期间状态为 closed", async () => {
    const r = await okCall("period_set_status", { accountSetId: mainSetId, period: "2026-01", status: "closed" });
    assert.equal(r.projection.status, "closed");
    assert.equal(r.applied, true);
    const periods = await localValue(await okCall("period_list", { accountSetId: mainSetId }), "period_list");
    assert.equal(periods.items.find((p) => p.period === "2026-01").status, "closed");
    closedSnapshot = await snapshot(mainSetId, "2026-01");
  });

  await test("封账后：反过账与新增凭证均被拒绝，且账簿不变", async () => {
    await failCall("voucher_unpost", { accountSetId: mainSetId, voucherId: salesVoucherId },
      "period_closed", "封账后反过账");
    await failCall("voucher_create", {
      accountSetId: mainSetId, period: "2026-01", status: "draft",
      entries: [{ code: "1001", debit: 1, credit: 0 }, { code: "1002", debit: 0, credit: 1 }],
    }, "period_closed", "封账后新增凭证");
    const after = await snapshot(mainSetId, "2026-01");
    assert.deepEqual(after, closedSnapshot, "失败操作不得改变账簿");
  });

  await test("反结账：重开 2026-01 后可继续录入，账簿最终与封账前一致", async () => {
    await failCall("period_set_status", { accountSetId: mainSetId, period: "2026-13", status: "open" },
      "period_invalid", "非法月份");
    const r = await okCall("period_set_status", { accountSetId: mainSetId, period: "2026-01", status: "open" });
    assert.equal(r.projection.status, "open");
    const probe = await okCall("voucher_create", {
      accountSetId: mainSetId, period: "2026-01", status: "draft",
      entries: [{ code: "1001", debit: 1, credit: 0 }, { code: "1002", debit: 0, credit: 1 }],
    });
    assert.equal(probe.projection.status, "draft");
    await okCall("voucher_delete", { accountSetId: mainSetId, voucherId: probe.projection.voucherId });
    const after = await snapshot(mainSetId, "2026-01");
    assert.deepEqual(after, closedSnapshot, "探针凭证删除后账簿应与封账前一致");
  });

  await test("新期间：登记并查询 2026-02 报表/试算，累计口径与 2026-01 一致", async () => {
    const r = await okCall("period_set_status", { accountSetId: mainSetId, period: "2026-02", status: "open" });
    assert.equal(r.projection.status, "open");
    const periods = await localValue(await okCall("period_list", { accountSetId: mainSetId }), "period_list");
    assert.equal(periods.items.find((p) => p.period === "2026-02").status, "open");
    const tb2 = await trialRaw(mainSetId, "2026-02");
    assert.deepEqual(tb2.totals, closedSnapshot.tb, "2026-02 无发生，试算应与 2026-01 相同");
    const bs2 = await balanceProjection(mainSetId, "2026-02");
    assert.equal(bs2.balanced, true);
    eq(bs2.assets, MAIN.assets);
    const cf2 = await cashFlowProjection(mainSetId, "2026-02");
    eq(cf2.netIncrease, 0, "2026-02 无发生，现金净增加额为 0");
    eq(cf2.cashEnd, MAIN.cashEnd);
    assert.equal(cf2.reconciles, true);
  });

  await test("边界：再次以 paths 导入示例仍默认预检且不落库", async () => {
    const before = await okCall("account_context", {});
    const r = await okCall("legacy_book_import", { enterprise: identityFixture(), paths: FIXTURE_PATHS });
    assert.equal(r.applied, false);
    assert.equal(r.projection.dryRun, true);
    const after = await okCall("account_context", {});
    assert.equal(after.projection.accountSetCount, before.projection.accountSetCount);
  });

  await test("边界：未实现的发票/申报/exec 工具如实返回 isError", async () => {
    for (const name of ["invoice_issue", "invoice_collect", "declaration_query", "exec"]) {
      const r = await client.call(name, {});
      assert.equal(r.isError, true, `${name} 应 isError`);
      assert.equal(r.data?.error, "not_implemented", `${name} 应 not_implemented`);
    }
  });

  await test("收尾：仅使用自身临时目录，不指向工程 data/", async () => {
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir())), `临时目录应在 tmpdir 下：${dataDir}`);
    assert.notEqual(resolve(dataDir), REAL_DATA);
    assert.ok(process.env.WORKBENCH_DATA_DIR !== REAL_DATA, "不得把工程 data/ 作为本次数据目录");
    assert.equal(backendErr.includes("Error"), false, backendErr.slice(0, 200));
  });
} catch (e) {
  results.push([false, "测试初始化"]);
  console.error("闭环验收初始化失败：", e.message);
} finally {
  if (client) await client.close();
  if (backend && !backend.killed) {
    const done = new Promise((r) => backend.once("exit", r));
    backend.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    if (backend.exitCode === null && backend.signalCode === null) {
      try { backend.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
process.exitCode = failed ? 1 : 0;
