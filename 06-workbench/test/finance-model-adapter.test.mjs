#!/usr/bin/env node
// finance-model-adapter acceptance — 普通财务工具的模型边界适配层。
//
// 运行：cd 06-workbench && node test/finance-model-adapter.test.mjs
//
// 隔离：**先**建全新临时 WORKBENCH_DATA_DIR，**再**动态 import 真实 accounting.mjs /
// agent-tools.mjs，把真实 callAgentTool 注入适配器实际执行（不是 fake DTO 自证）。
// 合成敏感标记（企业名 / 科目名 / 摘要 / 往来 / 人员 / 资产名 / 源路径 / 企业身份 / 批次 ID /
// 来源系统）全部是伪造字符串；断言任何模型返回、转换错误、测试捕获日志都不含这些原文。
//
// 预期金额全部是手算常量（不是调用实现反推，也不是两套计算器互相比对）：
//   期初 1002 借 1000 / 3001 贷 1000；V1 借 1002 1000、贷 5001 1000；
//   V2 借 5602 300、贷 1002 300；资产原值 1200、残值 5%、12 期 → 每月折旧 95。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- 合成敏感标记
const X = {
  enterpriseA: "合成机密企业名称甲",
  enterpriseB: "合成机密企业名称乙",
  enterpriseC: "合成机密企业名称丙",
  enterpriseD: "合成机密企业名称丁",
  importName: "合成机密导入企业辛",
  incrementalName: "合成机密增量企业壬",
  accountName: "合成机密科目名称乙",
  summary: "合成机密摘要丙",
  counterparty: "合成机密往来单位丁",
  person: "合成机密经办人戊",
  assetName: "合成机密资产名称庚",
  filePath: "D:/合成机密路径/凭证明细.zip",
  enterpriseKey: "91350000SECRETX01",
  enterpriseKeyAppend: "91350000SECRETX02",
  batchId: "syn-batch-20261022",
  sourceSystem: "syn-legacy-source",
};
const MARKERS = Object.values(X);
function assertNoLeak(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const hits = MARKERS.filter((marker) => text.includes(marker));
  assert.deepEqual(hits, [], `${label} 泄漏合成敏感原值：${hits.join(" / ")}`);
}

// 捕获日志（tee 到原实现）：最后断言「模型返回 / 转换错误 / 测试捕获日志」都不含原文。
const logBuffer = [];
for (const level of ["log", "error", "warn"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    try { logBuffer.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ")); } catch { /* ignore */ }
    original(...args);
  };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  PASS ${name}`); }
  catch (error) { results.push(false); console.error(`  FAIL ${name}\n${error.stack}`); }
}

// ---------------------------------------------------------------- 隔离临时库 + 动态 import
const dataDir = mkdtempSync(join(tmpdir(), "wb-adapter-"));
process.env.WORKBENCH_DATA_DIR = dataDir;
const A = await import("../server/accounting.mjs");
const { callAgentTool, AGENT_TOOL_NAMES } = await import("../server/agent-tools.mjs");
const { COA } = await import("../server/coa.mjs");
const ADAPTER = await import("../server/finance-model-adapter.mjs");
const { FinanceOutputPolicy, OUTPUT_POLICY_VERSION } = await import("../server/finance-output-policy.mjs");
const { createFinanceModelAdapter, FINANCE_QUERY_AVAILABLE, FINANCE_QUERY_UNIMPLEMENTED, PLAIN_MODEL_TOOLS } = ADAPTER;

// ---------------------------------------------------------------- 执行计数 + 真实适配器
const executed = [];
const executeRaw = async (name, args) => {
  executed.push(name);
  return callAgentTool(name, args);
};
const adapter = createFinanceModelAdapter({ executeRaw });
const policy = adapter.policy;

async function callExpectExecutions(name, args, times) {
  const before = executed.length;
  const envelope = await adapter.callModelTool(name, args);
  assert.equal(executed.length - before, times, `${name} 执行次数应为 ${times}`);
  assertNoLeak(envelope, `${name} 信封`);
  return envelope;
}

const queryOk = async (name, args) => {
  const envelope = await callExpectExecutions(name, args, 1);
  assert.equal(envelope.ok, true, `${name} 应成功：${JSON.stringify(envelope.error || null)}`);
  assert.equal(envelope.outputPolicy, OUTPUT_POLICY_VERSION);
  assert.equal(envelope.channel, "model");
  assert.equal(envelope.rawValuesIncluded, false);
  assert.match(envelope.localRef, /^finref_[a-f0-9]{48}$/);
  return envelope;
};
const writeOk = async (name, args) => {
  const envelope = await callExpectExecutions(name, args, 1);
  assert.equal(envelope.ok, true, `${name} 应成功：${JSON.stringify(envelope.error || null)}`);
  assert.equal(envelope.applied, true, `${name} applied 应为 true`);
  assert.equal(envelope.needsLocalReview, false);
  assert.equal(envelope.rawValuesIncluded, false);
  return envelope;
};
const expectFailure = async (name, args, code, { applied, executions } = {}) => {
  const envelope = await callExpectExecutions(name, args, executions);
  assert.equal(envelope.ok, false, `${name} 应被拒绝`);
  assert.equal(envelope.error.code, code, `${name} 错误码应为 ${code}，实际 ${envelope.error.code}`);
  if (applied !== undefined) assert.equal(envelope.applied, applied);
  return envelope;
};

const expectCode = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, `应报 ${code}，实际 ${error?.code || error?.message}`);
    return true;
  });
};

// ---------------------------------------------------------------- 基础数据（本机路径建 3 个账套）
const setA = A.createAccountSet({ name: X.enterpriseA, start_period: "2026-01" });
const setB = A.createAccountSet({ name: X.enterpriseB, start_period: "2026-01" });
const setC = A.createAccountSet({ name: X.enterpriseC, start_period: "2026-01" });
const categoryCounts = { assets: 0, liabilities: 0, equity: 0, cost: 0, profit_loss: 0 };
const CATEGORY_KEY = { 资产: "assets", 负债: "liabilities", 权益: "equity", 成本: "cost", 损益: "profit_loss" };
for (const account of COA) categoryCounts[CATEGORY_KEY[account.category]]++;
categoryCounts.assets += 1; // 下面通过适配器新增的 190101（资产类）

let channel;

await test("写：账户 / 期初 / 凭证 / 资产经适配器真实落库，applied=true 且只执行一次", async () => {
  const account = await writeOk("account_create", {
    accountSetId: setA.id, code: "190101", name: X.accountName, category: "资产", direction: "debit",
  });
  assert.deepEqual(account.projection, { accountCount: COA.length + 1 });
  assert.equal(account.accountSetId, setA.id);
  assert.equal(account.accountSetIdSource, "argument");

  const opening = await writeOk("opening_balance_set", {
    accountSetId: setA.id,
    items: [{ code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 }],
  });
  assert.deepEqual(opening.projection, { itemCount: 2 });

  const v1 = await writeOk("voucher_create", {
    accountSetId: setA.id, period: "2026-01", summary: X.summary,
    entries: [
      { code: "1002", summary: X.counterparty, debit: 1000, credit: 0 },
      { code: "5001", summary: X.person, debit: 0, credit: 1000 },
    ],
  });
  assert.equal(v1.projection.voucherId > 0, true);
  assert.deepEqual(
    { ...v1.projection, voucherId: undefined },
    { voucherId: undefined, period: "2026-01", status: "draft", lineCount: 2, totalDebit: 1000, totalCredit: 1000, balanced: true },
  );
  const v1Id = v1.projection.voucherId;

  const v2 = await writeOk("voucher_create", {
    accountSetId: setA.id, period: "2026-01", summary: X.summary, status: "posted",
    entries: [{ code: "5602", summary: X.counterparty, debit: 300, credit: 0 }, { code: "1002", summary: X.person, debit: 0, credit: 300 }],
  });
  const v2Id = v2.projection.voucherId;
  assert.equal(v2.projection.status, "posted");
  assert.equal(v2.projection.totalDebit, 300);

  const posted = await writeOk("voucher_post", { accountSetId: setA.id, voucherId: v1Id });
  assert.equal(posted.projection.voucherId, v1Id);
  assert.equal(posted.projection.status, "posted");

  const asset = await writeOk("asset_create", {
    accountSetId: setA.id, kind: "fixed", name: X.assetName,
    original_cost: 1200, useful_life_months: 12, start_period: "2026-02",
  });
  assert.equal(asset.projection.assetId > 0, true);
  assert.deepEqual(
    { ...asset.projection, assetId: undefined },
    { assetId: undefined, kind: "fixed", startPeriod: "2026-02", usefulLifeMonths: 12, originalCost: 1200 },
  );

  // 真实落库核对（本机直接读取）：只核对与手算常量一致的关键状态。
  const vouchers = A.listVouchers(setA.id, { period: "2026-01" });
  assert.equal(vouchers.length, 2);
  assert.deepEqual(vouchers.map((v) => v.status).sort(), ["posted", "posted"]);
  assert.deepEqual(A.getOpeningBalances(setA.id).map((o) => [o.code, o.debit, o.credit]).sort(), [["1002", 1000, 0], ["3001", 0, 1000]]);
  assert.equal(A.listAssetCards(setA.id).length, 1);

  // 本机通道：拿到引用后再用 channel 取原文（模型通道与原文通道确实是两条路）
  channel = policy.issueChannel("local_ui");
  assert.ok(channel);
  globalThis.__v1Id = v1Id;
  globalThis.__v2Id = v2Id;
});

await test("finance_query：12 个真实 node 逐个投影，金额等于手算常量且不含原文", async () => {
  const list = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "voucher.generated.list", period: "2026-01" });
  assert.equal(list.operation, "finance_query:voucher.generated.list");
  assert.equal(list.nodeId, "voucher.generated.list");
  assert.deepEqual(list.projection, {
    voucherCount: 2, entryCount: 4, postedCount: 2, draftCount: 0,
    totalDebit: 1300, totalCredit: 1300, balanced: true,
  });

  const summary = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "voucher.generated.summary", period: "2026-01" });
  assert.deepEqual(summary.projection, list.projection);

  const drafts = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "voucher.draft.summary", period: "2026-01" });
  assert.deepEqual(drafts.projection, {
    voucherCount: 0, entryCount: 0, postedCount: 0, draftCount: 0,
    totalDebit: 0, totalCredit: 0, balanced: true,
  });

  const detail = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "voucher.detail", voucherId: globalThis.__v1Id });
  assert.deepEqual(detail.projection, {
    voucherId: globalThis.__v1Id, period: "2026-01", status: "posted", lineCount: 2,
    totalDebit: 1000, totalCredit: 1000, balanced: true,
  });

  const sheets = await queryOk("finance_query", {
    accountSetId: setA.id, nodeId: "enterprise_account.account_set",
  });
  assert.deepEqual(sheets.projection, {
    accountSetId: setA.id, startPeriod: "2026-01", taxpayerType: "small_scale",
    accountingStandard: "small_business", hasDisplayName: true,
  });

  const subjects = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "enterprise_account.subject_system.all" });
  assert.deepEqual(subjects.projection, {
    accountCount: COA.length + 1, leafCount: COA.length + 1, contraCount: 2, byCategory: categoryCounts,
  });

  const balance = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "report.balance_sheet", period: "2026-01" });
  assert.deepEqual(balance.projection, {
    period: "2026-01", assets: 1700, liabilities: 0, equity: 1700, balanced: true, lineCount: 28,
    cash: 1700, receivables: 0, inventory: 0, fixedAssetsNet: 0,
  });

  const income = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "report.income_statement", period: "2026-01" });
  assert.deepEqual(income.projection, {
    period: "2026-01", currentRevenue: 1000, currentCost: 0, currentExpenses: 300,
    currentProfitBeforeTax: 700, currentNetProfit: 700, ytdRevenue: 1000, ytdNetProfit: 700,
  });

  const cashFlow = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "report.cash_flow_statement", period: "2026-01" });
  assert.deepEqual(cashFlow.projection, {
    period: "2026-01", operating: 700, investing: 0, financing: 0, netIncrease: 700,
    cashBegin: 1000, cashEnd: 1700, cashChange: 700, reconciles: true, lineCount: 2,
  });

  const trial = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "report.trial_balance", period: "2026-01" });
  assert.deepEqual(trial.projection, {
    period: "2026-01", lineCount: COA.length + 1,
    openingDebit: 1000, openingCredit: 1000, periodDebit: 1300, periodCredit: 1300,
    closingDebit: 2000, closingCredit: 2000, balanced: true,
  });

  const periodEnd = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "period_end.summary", period: "2026-01" });
  assert.deepEqual(periodEnd.projection, {
    periodCount: 1, openPeriodCount: 1, closedPeriodCount: 0, period: "2026-01",
    closingDebit: 2000, closingCredit: 2000, balanced: true,
  });

  const ledger = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "ledger.general", period: "2026-01", params: { code: "1002" } });
  assert.deepEqual(ledger.projection, {
    period: "2026-01", direction: "debit", itemCount: 2, openingDebit: 1000, openingCredit: 0,
    periodDebit: 1000, periodCredit: 300, closingBalance: 1700,
  });

  // 本机通道仍能取到全量原文（模型信封里没有这些字段）
  const raw = policy.localRead(list.localRef, {
    channel, accountSetId: setA.id, operation: "finance_query:voucher.generated.list",
  });
  assert.equal(raw.channel, "local");
  assert.equal(raw.value.length, 2);
  const rawText = JSON.stringify(raw.value);
  for (const marker of [X.summary, X.counterparty, X.person]) assert.ok(rawText.includes(marker));
  const computed = policy.localCompute(detail.localRef, {
    channel, accountSetId: setA.id, operation: detail.operation, op: "sum", path: "entries.[].debit",
  });
  assert.equal(computed.value, 1000);
  assert.equal(computed.matched, 2);

  // 本机直接读 / 导出全量原文依旧可用（没有被适配器削弱）
  assert.ok(JSON.stringify(A.listVouchers(setA.id, { period: "2026-01" })).includes(X.summary));
  assert.ok(JSON.stringify(A.balanceSheet(setA.id, "2026-01")).includes("货币资金"));
});

await test("普通只读工具：账户 / 期初 / 期间 / 明细账 / 资产 / 凭证预检都走同一套白名单投影", async () => {
  const accounts = await queryOk("account_list", { accountSetId: setA.id });
  assert.deepEqual(accounts.projection, {
    accountCount: COA.length + 1, leafCount: COA.length + 1, contraCount: 2, byCategory: categoryCounts,
  });

  const opening = await queryOk("opening_balance_get", { accountSetId: setA.id });
  assert.deepEqual(opening.projection, { itemCount: 2, totalDebit: 1000, totalCredit: 1000, balanced: true });

  const periods = await queryOk("period_list", { accountSetId: setA.id });
  assert.deepEqual(periods.projection, { periodCount: 1, openPeriodCount: 1, closedPeriodCount: 0 });

  const ledger = await queryOk("ledger_query", { accountSetId: setA.id, code: "1002", period: "2026-01" });
  assert.deepEqual(ledger.projection, {
    period: "2026-01", direction: "debit", itemCount: 2, openingDebit: 1000, openingCredit: 0,
    periodDebit: 1000, periodCredit: 300, closingBalance: 1700,
  });

  const assets = await queryOk("asset_list", { accountSetId: setA.id });
  assert.deepEqual(assets.projection, {
    cardCount: 1, fixedCount: 1, intangibleCount: 0,
    totalOriginalCost: 1200, totalAccumulated: 0, totalRemaining: 1140,
  });

  const check = await queryOk("voucher_check", {
    accountSetId: setA.id,
    entries: [{ code: "1002", debit: 500, credit: 0 }, { code: "5001", debit: 0, credit: 500 }],
  });
  assert.deepEqual(check.projection, { checkOk: true, errorCount: 0, totalDebit: 500, totalCredit: 500, balanced: true });

  // 不存在的科目编码是真实领域错误：安全码 + 原 message 不回传
  const missing = await callExpectExecutions("ledger_query", { accountSetId: setA.id, code: "NO-SUCH-CODE", period: "2026-01" }, 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "account_not_found");
  assert.equal(missing.error.retriable, false);
});

await test("全局上下文：无 setId 时明确 global scope + 有界分页，不伪造 setId、不含企业名", async () => {
  const page1 = await callExpectExecutions("account_context", { limit: 2 }, 1);
  assert.equal(page1.ok, true);
  assert.equal(page1.operation, "account_context");
  assert.equal(page1.scope, "global");
  assert.equal(page1.accountSetId, null);
  assert.equal(page1.localRef, null);
  assert.equal(page1.refUnavailable, "global_scope");
  assert.deepEqual(page1.projection, {
    scope: "global", accountSetCount: 3, returnedCount: 2, pageOffset: 0, pageLimit: 2,
    truncated: true, hasNextPage: true, nextOffset: 2,
    accountSetIds: [setC.id, setB.id], startPeriods: ["2026-01", "2026-01"],
    taxpayerTypes: ["small_scale", "small_scale"], accountingStandards: ["small_business", "small_business"],
    displayNameFlags: [true, true], selectionRequirement: "explicit_account_set_id", persisted: false,
  });
  assertNoLeak(page1, "global context page1");

  const page2 = await callExpectExecutions("account_context", { limit: 2, offset: 2 }, 1);
  assert.equal(page2.projection.returnedCount, 1);
  assert.deepEqual(page2.projection.accountSetIds, [setA.id]);
  assert.equal(page2.projection.truncated, false);
  assert.equal(page2.projection.hasNextPage, false);
  assert.equal("nextOffset" in page2.projection, false);

  // 超页大小在执行前拒绝（不会悄悄少给）
  await expectFailure("account_context", { limit: 33 }, "model_context_page_invalid", { executions: 0 });
  await expectFailure("account_context", { offset: -1 }, "model_context_page_invalid", { executions: 0 });

  const scoped = await callExpectExecutions("account_context", { accountSetId: setA.id }, 1);
  assert.equal(scoped.ok, true);
  assert.equal(scoped.scope, "account_set");
  assert.equal(scoped.accountSetId, setA.id);
  assert.deepEqual(scoped.projection, {
    scope: "account_set", accountSetId: setA.id, startPeriod: "2026-01", taxpayerType: "small_scale",
    accountingStandard: "small_business", hasDisplayName: true,
    periodCount: 1, openPeriodCount: 1, closedPeriodCount: 0,
    selectionRequirement: "explicit_account_set_id", persisted: false,
  });
  assert.equal(scoped.localRef, null);

  const alias = await callExpectExecutions("finance_context_resolve", { accountSetId: setA.id }, 1);
  assert.equal(alias.operation, "finance_context_resolve");
  assert.deepEqual(alias.projection, scoped.projection);

  // 指定账套必须真实存在（归属校验），不是凭入参伪造
  await expectFailure("account_context", { accountSetId: 999999 }, "account_set_not_found", { executions: 1 });
  await expectFailure("account_context", { accountSetId: "abc" }, "account_set_id_invalid", { executions: 0 });
});

await test("静态目录 / update_plan：不执行工具、不回显入参文本，目录与真实实现一一对齐", async () => {
  const catalog = await callExpectExecutions("finance_query_catalog", {}, 0);
  assert.equal(catalog.ok, true);
  assert.equal(catalog.operationCategory, "static");
  assert.deepEqual(catalog.catalog.available, FINANCE_QUERY_AVAILABLE);
  assert.deepEqual(catalog.catalog.unimplemented, FINANCE_QUERY_UNIMPLEMENTED);
  assert.deepEqual(catalog.catalog.localExtensions, ["report.trial_balance", "ledger.general"]);
  assert.deepEqual(catalog.projection, {
    availableCount: 12, unimplementedCount: 11, localExtensionCount: 2, staticCatalog: true,
  });

  const plan = await callExpectExecutions("update_plan", { plan: [X.summary, X.enterpriseA, X.filePath] }, 0);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.projection, { status: "not_persisted", persisted: false, saved: false, planItemCount: 3 });
  assertNoLeak(plan, "update_plan");

  // 与真实 agent-tools 交叉核对：可用能力集合一致，且每个可用 node 都有 policy 投影 spec
  const realCatalog = await callAgentTool("finance_query_catalog", {});
  const realIds = new Set([...realCatalog.capabilities, ...realCatalog.local_extensions]);
  assert.deepEqual([...realIds].sort(), [...FINANCE_QUERY_AVAILABLE].sort());
  for (const nodeId of FINANCE_QUERY_AVAILABLE) {
    assert.ok(ADAPTER.MODEL_TOOL_INVENTORY.financeQuery.available.includes(nodeId));
    const op = `finance_query:${nodeId}`;
    assert.ok((await import("../server/finance-output-policy.mjs")).SUPPORTED_OPERATIONS.query.includes(op), `${op} 缺少 spec`);
  }
  // 普通工具清单完整（未登记的才拒绝；税务名只做精确拒绝，不做放行）
  const inventoryNames = new Set([
    ...ADAPTER.MODEL_TOOL_INVENTORY.projected,
    ...ADAPTER.MODEL_TOOL_INVENTORY.static,
    ...ADAPTER.MODEL_TOOL_INVENTORY.context,
    ...ADAPTER.MODEL_TOOL_INVENTORY.write,
    ...ADAPTER.MODEL_TOOL_INVENTORY.create,
    ...ADAPTER.MODEL_TOOL_INVENTORY.unimplemented,
  ]);
  for (const name of AGENT_TOOL_NAMES) {
    if (name.startsWith("tax_")) continue;
    assert.ok(inventoryNames.has(name), `普通工具未盘点：${name}`);
  }
  for (const name of inventoryNames) assert.ok(AGENT_TOOL_NAMES.includes(name), `盘点项不在 agent-tools：${name}`);
});

await test("未知 / 税务 / 未实现 / 未知 node：默认拒绝且从不执行", async () => {
  await expectFailure("voucher_approve", {}, "model_tool_unknown", { executions: 0 });
  await expectFailure("tax_regions", {}, "model_tool_tax_excluded", { executions: 0 });
  await expectFailure("tax_login_start", { region: "x" }, "model_tool_tax_excluded", { executions: 0 });
  await expectFailure("invoice_collect", {}, "model_tool_not_implemented", { executions: 0 });
  await expectFailure("exec", { cmd: "x" }, "model_tool_not_implemented", { executions: 0 });
  await expectFailure("finance_query", { accountSetId: setA.id, nodeId: "invoice.some_unknown_node" }, "model_node_unknown", { executions: 0 });
  await expectFailure("finance_query", { accountSetId: setA.id, nodeId: "enterprise_account.bank" }, "model_node_not_implemented", { executions: 0 });
  await expectFailure("finance_query", { nodeId: "report.balance_sheet", period: "2026-01" }, "account_set_id_required", { executions: 0 });
  await expectFailure("finance_query", { accountSetId: true, nodeId: "report.balance_sheet" }, "account_set_id_invalid", { executions: 0 });
  await expectFailure("voucher_create", { period: "2026-01" }, "account_set_id_required", { applied: false, executions: 0 });
  await expectFailure("book_import_batch", {}, "batchId_required", { executions: 0 });

  // 缺少 period 属于业务校验，由真实 agent-tools 报错；适配器把它转成固定安全码
  const noPeriod = await callExpectExecutions("finance_query", { accountSetId: setA.id, nodeId: "report.balance_sheet" }, 1);
  assert.equal(noPeriod.ok, false);
  assert.equal(noPeriod.error.code, "period_required");
  assertNoLeak(noPeriod, "period_required");

  // 写动作的真实业务失败：结果未知（不能无依据标 applied:false）
  const missingVoucher = await callExpectExecutions("voucher_post", { accountSetId: setA.id, voucherId: 987654 }, 1);
  assert.equal(missingVoucher.ok, false);
  assert.equal(missingVoucher.error.code, "voucher_not_found");
  assert.equal(missingVoucher.applied, "unknown");
  assert.equal(missingVoucher.needsLocalReview, true);
  assert.equal(missingVoucher.localRef, null);
  assert.equal(missingVoucher.refUnavailable, "outcome_unknown");
});

await test("写生命周期：反过账 / 过账 / 删除 / 结转 / 折旧 / 期间，成功与业务失败都如实", async () => {
  const unpost = await writeOk("voucher_unpost", { accountSetId: setA.id, voucherId: globalThis.__v1Id });
  assert.equal(unpost.projection.status, "draft");
  const repost = await writeOk("voucher_post", { accountSetId: setA.id, voucherId: globalThis.__v1Id });
  assert.equal(repost.projection.status, "posted");

  // 已过账凭证直接删除：域层拒绝，结果未知（不伪造成 applied:false）
  const blockedDelete = await callExpectExecutions("voucher_delete", { accountSetId: setA.id, voucherId: globalThis.__v2Id }, 1);
  assert.equal(blockedDelete.ok, false);
  assert.equal(blockedDelete.error.code, "posted_voucher_requires_unpost");
  assert.equal(blockedDelete.applied, "unknown");
  assert.equal(A.listVouchers(setA.id, { period: "2026-01" }).length, 2);

  await writeOk("voucher_unpost", { accountSetId: setA.id, voucherId: globalThis.__v2Id });
  const deleted = await writeOk("voucher_delete", { accountSetId: setA.id, voucherId: globalThis.__v2Id });
  assert.deepEqual(deleted.projection, { deletedVoucherId: globalThis.__v2Id });
  assert.throws(() => A.getVoucher(setA.id, globalThis.__v2Id), /voucher_not_found/);

  // 结转本期损益：本期只剩 V1（收入 1000 / 费用 0）→ 利润 1000
  const carry = await writeOk("carry_forward_profit", { accountSetId: setA.id, period: "2026-01" });
  assert.equal(carry.projection.profit, 1000);
  assert.equal(carry.projection.revenue, 1000);
  assert.equal(carry.projection.expense, 0);
  assert.equal(carry.projection.voucherId > 0, true);
  const carryVoucher = A.getVoucher(setA.id, carry.projection.voucherId);
  assert.equal(carryVoucher.kind, "carryforward");
  assert.equal(carryVoucher.status, "posted");
  const again = await callExpectExecutions("carry_forward_profit", { accountSetId: setA.id, period: "2026-01" }, 1);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "already_carried_forward");
  assert.equal(again.applied, "unknown");

  // 折旧：1200 × (1 − 5%) ÷ 12 = 95（手算常量）
  const depreciation = await writeOk("depreciation_run", { accountSetId: setA.id, period: "2026-02" });
  assert.equal(depreciation.projection.runCount, 1);
  assert.equal(depreciation.projection.totalAmount, 95);
  assert.equal(depreciation.projection.period, "2026-02");
  const depreciationEntries = A.getVoucher(setA.id, depreciation.projection.voucherId).entries;
  assert.deepEqual(depreciationEntries.map((e) => [e.code, e.debit, e.credit]), [["5602", 95, 0], ["1602", 0, 95]]);
  // 同期间再计提：本期无需计提 → applied=false（nothing_due），仍只有一次执行
  const nothingDue = await callExpectExecutions("depreciation_run", { accountSetId: setA.id, period: "2026-02" }, 1);
  assert.equal(nothingDue.ok, true);
  assert.equal(nothingDue.applied, false);
  assert.equal(nothingDue.appliedReason, "nothing_due");
  assert.deepEqual(nothingDue.projection, { runCount: 0, totalAmount: 0 });

  const closed = await writeOk("period_set_status", { accountSetId: setA.id, period: "2026-01", status: "closed" });
  assert.deepEqual(closed.projection, { period: "2026-01", status: "closed" });
  // 封账期间再建凭证：域层拒绝，结果未知
  const closedCreate = await callExpectExecutions("voucher_create", {
    accountSetId: setA.id, period: "2026-01",
    entries: [{ code: "1002", debit: 1, credit: 0 }, { code: "5001", debit: 0, credit: 1 }],
  }, 1);
  assert.equal(closedCreate.ok, false);
  assert.equal(closedCreate.error.code, "period_closed");
  assert.equal(closedCreate.applied, "unknown");
  assert.equal(closedCreate.needsLocalReview, true);
  const reopened = await writeOk("period_set_status", { accountSetId: setA.id, period: "2026-01", status: "open" });
  assert.deepEqual(reopened.projection, { period: "2026-01", status: "open" });

  const badStatus = await callExpectExecutions("period_set_status", { accountSetId: setA.id, period: "2026-01", status: "bogus" }, 1);
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.error.code, "status_invalid");
  assert.equal(badStatus.applied, "unknown");

  // 折旧残留草稿 → 再次计提被拒；重过账恢复后不影响已计提金额
  await writeOk("voucher_unpost", { accountSetId: setA.id, voucherId: depreciation.projection.voucherId });
  const draftBlocked = await callExpectExecutions("depreciation_run", { accountSetId: setA.id, period: "2026-02" }, 1);
  assert.equal(draftBlocked.ok, false);
  assert.equal(draftBlocked.error.code, "depreciation_draft_exists");
  assert.equal(draftBlocked.applied, "unknown");
  const repostedDepreciation = await writeOk("voucher_post", { accountSetId: setA.id, voucherId: depreciation.projection.voucherId });
  assert.equal(repostedDepreciation.projection.status, "posted");

  // 期初 / 科目：真实业务失败也不伪装成功
  const openingAfterPosting = await callExpectExecutions("opening_balance_set", {
    accountSetId: setA.id, items: [{ code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 }],
  }, 1);
  assert.equal(openingAfterPosting.ok, false);
  assert.equal(openingAfterPosting.error.code, "opening_rewrite_after_posting");
  assert.equal(openingAfterPosting.applied, "unknown");
  const badAccount = await callExpectExecutions("account_create", {
    accountSetId: setA.id, code: "190103", name: "", category: "资产", direction: "debit",
  }, 1);
  assert.equal(badAccount.ok, false);
  assert.equal(badAccount.error.code, "code_and_name_required");
  assert.equal(badAccount.applied, "unknown");
});

await test("建账类写动作：setId 只能来自真实结果；dry-run / 失败明确未绑定，不造假 ID", async () => {
  const created = await writeOk("account_set_create", {
    name: X.enterpriseD, start_period: "2026-01", taxpayer_type: "一般纳税人", accounting_standard: "企业会计准则",
  });
  assert.equal(created.accountSetIdSource, "result");
  assert.equal(created.accountSetId > 0, true);
  assert.equal(A.getAccountSet(created.accountSetId).name, X.enterpriseD);
  assert.deepEqual(created.projection, { accountSetId: created.accountSetId, startPeriod: "2026-01" });
  // 引用绑定到真实新账套：换成别的账套必须拒绝
  const resolved = policy.resolveForModel(created.localRef, { accountSetId: created.accountSetId, operation: "account_set_create" });
  assert.equal(resolved.projection.accountSetId, created.accountSetId);
  expectCode(() => policy.resolveForModel(created.localRef, { accountSetId: setA.id, operation: "account_set_create" }), "output_policy_ref_cross_account");
  assertNoLeak(resolved, "account_set_create resolve");

  const payload = {
    account_set: { name: X.importName, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" },
    accounts: [{ code: "190102", name: X.accountName, category: "资产", direction: "debit" }],
    opening_balances: [],
    vouchers: [{
      period: "2026-01", word: "记", number: 1, summary: X.summary,
      entries: [
        { code: "1002", summary: X.counterparty, debit: 800, credit: 0 },
        { code: "5001", summary: X.person, debit: 0, credit: 800 },
      ],
    }],
  };
  const beforeSets = A.listAccountSets().length;
  const dry = await callExpectExecutions("legacy_book_import", { payload }, 1);
  assert.equal(dry.ok, true);
  assert.equal(dry.applied, false);
  assert.equal(dry.appliedReason, "dry_run");
  assert.equal(dry.accountSetId, null);
  assert.equal(dry.localRef, null);
  assert.equal(dry.refUnavailable, "not_applied");
  assert.deepEqual(dry.projection, {
    dryRun: true, validationOk: true, blockedByValidation: false, warningCount: 0,
  });
  assert.equal(A.listAccountSets().length, beforeSets, "dry-run 不得建账套");

  const imported = await writeOk("legacy_book_import", { payload, dryRun: false });
  assert.equal(imported.accountSetIdSource, "result");
  assert.equal(A.getAccountSet(imported.projection.createdAccountSetId).name, X.importName);
  assert.deepEqual(imported.projection, {
    dryRun: false, validationOk: true, blockedByValidation: false,
    createdAccountSetId: imported.projection.createdAccountSetId,
    createdAccountCount: COA.length + 1, createdVoucherCount: 1, warningCount: 0,
  });
  assert.equal(imported.accountSetId, imported.projection.createdAccountSetId);
  const importedRaw = policy.localRead(imported.localRef, {
    channel, accountSetId: imported.accountSetId, operation: "legacy_book_import",
  });
  assert.ok(JSON.stringify(importedRaw.value).includes(X.importName));
});

await test("增量导入：preview / 正式 / 回放 / 冲突，批次审计由真实结果确定账套", async () => {
  const payload = {
    account_set: { name: X.incrementalName, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" },
    accounts: [],
    opening_balances: [],
    vouchers: [{
      period: "2026-01", word: "记", number: 1, summary: X.summary,
      entries: [
        { code: "1002", summary: X.counterparty, debit: 50, credit: 0 },
        { code: "5001", summary: X.person, debit: 0, credit: 50 },
      ],
    }],
  };
  const source = { system: X.sourceSystem, enterpriseKey: X.enterpriseKey, enterpriseName: X.enterpriseA };
  const beforeSets = A.listAccountSets().length;

  const preview = await callExpectExecutions("book_import_incremental", { payload, source, batchId: X.batchId, mode: "create" }, 1);
  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.appliedReason, "dry_run");
  assert.equal(preview.accountSetId, null);
  assert.equal(preview.localRef, null);
  assert.equal(preview.projection.status, "preview");
  assert.equal(preview.projection.validationOk, true);
  assert.equal(preview.projection.plannedVouchers, 1);
  assert.equal(A.listAccountSets().length, beforeSets, "preview 不得建账套");

  const applied = await writeOk("book_import_incremental", { payload, source, batchId: X.batchId, mode: "create", dryRun: false });
  assert.equal(applied.accountSetIdSource, "result");
  assert.equal(applied.projection.status, "applied");
  assert.equal(applied.projection.accountSetCreated, true);
  assert.equal(applied.projection.vouchersCreated, 1);
  assert.equal(applied.projection.vouchersDeduplicated, 0);
  assert.equal(A.getAccountSet(applied.projection.accountSetId).name, X.incrementalName);
  const incrementalSetId = applied.projection.accountSetId;

  const replay = await callExpectExecutions("book_import_incremental", { payload, source, batchId: X.batchId, mode: "create", dryRun: false }, 1);
  assert.equal(replay.ok, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.appliedReason, "idempotent_replay");
  assert.equal(replay.projection.status, "idempotent_replay");
  assert.equal(replay.projection.replayed, true);
  assert.equal(A.listVouchers(incrementalSetId).length, 1, "回放不得重复写凭证");

  const conflictPayload = {
    ...payload,
    vouchers: [{
      period: "2026-01", word: "记", number: 1, summary: X.summary,
      entries: [
        { code: "1002", summary: X.counterparty, debit: 60, credit: 0 },
        { code: "5001", summary: X.person, debit: 0, credit: 60 },
      ],
    }],
  };
  const setsBeforeConflict = A.listAccountSets().length;
  const conflict = await callExpectExecutions(
    "book_import_incremental",
    { payload: conflictPayload, source, batchId: X.batchId, mode: "create", dryRun: false },
    1,
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "import_conflict");
  assert.equal(conflict.applied, "unknown");
  assert.equal(conflict.needsLocalReview, true);
  assert.equal(A.listAccountSets().length, setsBeforeConflict, "冲突不得建账套");
  assert.equal(A.listVouchers(incrementalSetId).length, 1);

  const batch = await queryOk("book_import_batch", { batchId: X.batchId });
  assert.equal(batch.accountSetId, incrementalSetId);
  assert.equal(batch.accountSetIdSource, "result");
  assert.equal(batch.scope, "batch");
  assert.deepEqual(batch.projection, {
    batchStatus: "completed", batchMode: "create", accountSetId: incrementalSetId,
    traceCount: 1, okTraceCount: 1, inconsistentTraceCount: 0, voucherCount: 1,
    accountSetCreated: true, vouchersCreated: 1, vouchersDeduplicated: 0,
  });
  assertNoLeak(batch, "book_import_batch");

  // 追加（append）：向已有账套按同一企业身份追加，账套由真实结果确定；不新键账套
  const appendPayload = {
    account_set: { name: "合成机密追加名称癸", start_period: "2026-01", accounting_standard: "小企业会计准则" },
    accounts: [],
    opening_balances: [],
    vouchers: [{
      period: "2026-01", word: "记", number: 1, summary: X.summary,
      entries: [
        { code: "1002", summary: X.counterparty, debit: 20, credit: 0 },
        { code: "5001", summary: X.person, debit: 0, credit: 20 },
      ],
    }],
  };
  const appendSource = { system: X.sourceSystem, enterpriseKey: X.enterpriseKeyAppend };
  const appendId = "syn-append-batch-20261022";
  const setsBeforeAppend = A.listAccountSets().length;
  const appended = await writeOk("book_import_incremental", {
    payload: appendPayload, source: appendSource, batchId: appendId, mode: "append",
    accountSetId: setB.id, confirmNewBinding: true, dryRun: false,
  });
  assert.equal(appended.accountSetIdSource, "result");
  assert.equal(appended.projection.accountSetId, setB.id);
  assert.equal(appended.projection.accountSetCreated, false);
  assert.equal(appended.projection.vouchersCreated, 1);
  assert.equal(A.listAccountSets().length, setsBeforeAppend, "append 不得新建账套");
  assert.equal(A.listVouchers(setB.id).length, 1);
  // 同一企业身份、同账套，但新来源未登记且未确认 → 结构化冲突，不写入
  const appendUnconfirmed = await callExpectExecutions("book_import_incremental", {
    payload: appendPayload, source: { system: "syn-other-source", enterpriseKey: X.enterpriseKeyAppend },
    batchId: "syn-append-unconfirmed-20261022", mode: "append", accountSetId: setB.id, dryRun: false,
  }, 1);
  assert.equal(appendUnconfirmed.ok, false);
  assert.equal(appendUnconfirmed.error.code, "import_conflict");
  assert.equal(appendUnconfirmed.applied, "unknown");
  assert.equal(A.listVouchers(setB.id).length, 1, "冲突不得追加凭证");

  // 入参账套只能用于核对：不匹配安全拒绝，绝不替换结果所属账套
  const matched = await queryOk("book_import_batch", { batchId: X.batchId, accountSetId: incrementalSetId });
  assert.equal(matched.accountSetId, incrementalSetId);
  await expectFailure("book_import_batch", { batchId: X.batchId, accountSetId: setA.id }, "model_scope_mismatch", { executions: 1 });
  const missing = await callExpectExecutions("book_import_batch", { batchId: "no-such-batch-id" }, 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "batch_not_found");
});

await test("async 写语义：真实拒绝 / 同步抛错 / 写后投影失败都只执行一次且不伪造 applied", async () => {
  const calls = { n: 0 };
  const rejecting = createFinanceModelAdapter({
    executeRaw: async (name) => {
      calls.n++;
      throw new Error(`synthetic_rejected_${X.summary}`);
    },
  });
  const rejected = await rejecting.callModelTool("voucher_create", { accountSetId: setA.id, period: "2026-01", entries: [] });
  assert.equal(calls.n, 1);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.applied, "unknown");
  assert.equal(rejected.needsLocalReview, true);
  assert.equal(rejected.error.code, "operation_failed");
  assertNoLeak(rejected, "async rejection");

  let syncCalls = 0;
  const syncThrow = createFinanceModelAdapter({
    executeRaw: () => {
      syncCalls++;
      throw new Error(`synthetic_sync_${X.filePath}`);
    },
  });
  const syncFailure = await syncThrow.callModelTool("voucher_post", { accountSetId: setA.id, voucherId: 1 });
  assert.equal(syncCalls, 1);
  assert.equal(syncFailure.applied, "unknown");
  assertNoLeak(syncFailure, "sync throw");

  // 写已发生（id/status 是数据属性 → applied=true），但结果含访问器 → 只能降级引用
  let getterCalls = 0;
  let degradeCalls = 0;
  const degrade = createFinanceModelAdapter({
    executeRaw: async () => {
      degradeCalls++;
      return {
        id: 4321, account_set_id: setA.id, period: "2026-01", status: "draft",
        get entries() { getterCalls++; throw new Error(`synthetic_getter_${X.enterpriseA}`); },
      };
    },
  });
  const degraded = await degrade.callModelTool("voucher_create", { accountSetId: setA.id, period: "2026-01", entries: [] });
  assert.equal(degradeCalls, 1);
  assert.equal(getterCalls, 0, "摘要阶段不得触发 getter");
  assert.equal(degraded.ok, true);
  assert.equal(degraded.applied, true);
  assert.equal(degraded.needsLocalReview, false);
  assert.equal(degraded.localRef, null);
  assert.equal(degraded.refUnavailable, "value_invalid");
  assert.deepEqual(degraded.projection, {});
  assertNoLeak(degraded, "post-write degradation");

  // 写后超预算（单值 4 MiB 上限未被调大）：仍保留 applied，丢弃引用
  const oversized = createFinanceModelAdapter({
    executeRaw: async () => ({
      id: 55, account_set_id: setA.id, period: "2026-01", status: "draft",
      entries: [{ line_no: 1, code: "1002", summary: "x".repeat(4 * 1024 * 1024 + 1), debit: 1, credit: 0 }],
    }),
  });
  const tooBig = await oversized.callModelTool("voucher_create", { accountSetId: setA.id, period: "2026-01", entries: [] });
  assert.equal(tooBig.ok, true);
  assert.equal(tooBig.applied, true);
  assert.equal(tooBig.localRef, null);
  assert.equal(tooBig.refUnavailable, "value_limit");

  // 只读通道超预算：明确拒绝，不返回空投影冒充成功
  const bigQuery = createFinanceModelAdapter({
    executeRaw: async () => ({
      nodeId: "report.balance_sheet",
      label: "x",
      data: {
        period: "2026-01", assets: [{ label: "货币资金", value: 1, huge: "y".repeat(4 * 1024 * 1024 + 1) }],
        liabilities: [], totals: { assets: 1, liabilities: 0, equity: 1 }, balanced: true,
      },
    }),
  });
  const bigQueryResult = await bigQuery.callModelTool("finance_query", { accountSetId: setA.id, nodeId: "report.balance_sheet", period: "2026-01" });
  assert.equal(bigQueryResult.ok, false);
  assert.equal(bigQueryResult.error.code, "output_policy_value_too_large");
});

await test("投影 / 绑定 / 过期 / 伪造 channel：跨账套、换 operation、跨重启失效语义保持", async () => {
  const list = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "voucher.generated.list", period: "2026-01" });
  const ref = list.localRef;

  expectCode(() => policy.resolveForModel(ref, { accountSetId: setB.id, operation: list.operation }), "output_policy_ref_cross_account");
  expectCode(
    () => policy.resolveForModel(ref, { accountSetId: setA.id, operation: "finance_query:report.balance_sheet" }),
    "output_policy_ref_binding_mismatch",
  );
  expectCode(() => policy.resolveForModel(ref, { accountSetId: setA.id }), "output_policy_operation_required");
  expectCode(
    () => policy.localRead(ref, { local: true, accountSetId: setA.id, operation: list.operation }),
    "output_policy_channel_untrusted",
  );
  expectCode(
    () => policy.localRead(ref, { channel: "local", accountSetId: setA.id, operation: list.operation }),
    "output_policy_channel_untrusted",
  );
  expectCode(
    () => policy.localRead(ref, { channel: { channelId: channel.channelId }, accountSetId: setA.id, operation: list.operation }),
    "output_policy_channel_untrusted",
  );
  // 伪造 ref 字符串也不通
  expectCode(
    () => policy.resolveForModel("finref_" + "a".repeat(48), { accountSetId: setA.id, operation: list.operation }),
    "output_policy_ref_unknown",
  );

  // 过期：用可注入时钟的策略实例验证 TTL 语义（引用仅进程内，跨重启失效）
  let clock = 1_000_000;
  const expiring = new FinanceOutputPolicy({ now: () => clock, ttlMs: 1000 });
  const expiringAdapter = createFinanceModelAdapter({
    policy: expiring,
    executeRaw: async () => ({
      nodeId: "voucher.generated.list", label: "x",
      data: [{ id: 1, period: "2026-01", status: "posted", entries: [] }],
    }),
  });
  const expiringEnvelope = await expiringAdapter.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "voucher.generated.list", period: "2026-01",
  });
  assert.equal(expiringEnvelope.ok, true);
  clock += 1001;
  expectCode(
    () => expiring.resolveForModel(expiringEnvelope.localRef, { accountSetId: setA.id, operation: expiringEnvelope.operation }),
    "output_policy_ref_expired",
  );

  // 预算保持既有本地策略（未调大）
  const stats = policy.stats();
  assert.equal(stats.persistence, "process_memory");
  assert.equal(stats.maxRefs, 256);
  assert.equal(stats.ttlMs, 15 * 60 * 1000);
  assert.equal(stats.nodeBudget, 1_000_000);
  assert.equal(stats.byteBudget, 64 * 1024 * 1024);
  assert.ok(stats.byteBudget === 67108864);
});

await test("模型返回 / 错误投影 / 测试日志都不含合成敏感原文", async () => {
  // 通道释放后本机读取必须失效（能力对象是唯一凭据）
  policy.releaseChannel(channel);
  const list2 = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "voucher.generated.list", period: "2026-01" });
  expectCode(
    () => policy.localRead(list2.localRef, { channel, accountSetId: setA.id, operation: list2.operation }),
    "output_policy_channel_revoked",
  );

  const joined = logBuffer.join("\n");
  const hits = MARKERS.filter((marker) => joined.includes(marker));
  assert.deepEqual(hits, [], `测试捕获日志含合成敏感原值：${hits.join(" / ")}`);

  // 已产出的信封集合再整体扫一遍
  const last = await queryOk("book_import_batch", { batchId: X.batchId });
  assertNoLeak(JSON.stringify(last), "final envelope");
});

// ---------------------------------------------------------------- 汇总与清理
policy.dispose();
try { (await import("../server/db.mjs")).db.close(); } catch { /* 已关闭或不可用 */ }
try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 已在退出时释放 */ }

console.log(`\nFinance model adapter acceptance: ${results.filter(Boolean).length}/${results.length} passed`);
if (results.some((passed) => !passed)) process.exitCode = 1;
