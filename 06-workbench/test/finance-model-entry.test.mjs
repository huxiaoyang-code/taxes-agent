#!/usr/bin/env node
// finance-model-entry acceptance — LOCAL-08 真实模型入口组装 / 生命周期 / 并发 / 故障注入。
//
// 运行：cd 06-workbench && node test/finance-model-entry.test.mjs
//
// 隔离：**先**建全新临时 WORKBENCH_DATA_DIR，**再**动态 import 真实 accounting.mjs /
// agent-tools.mjs / finance-model-entry.mjs，注入真实 `callAgentTool` 实际执行。
// 全部金额为手算常量（期初 1002=1000 / 1601=1200 / 3001=2200；V1 收入 300；
// 资产 1200×95%÷12=95；净利 300−95=205；资产负债表 2405 / 0 / 2405）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- 合成敏感标记
const X = {
  enterpriseA: "合成机密企业名称甲",
  enterpriseB: "合成机密企业名称乙",
  enterpriseC: "合成机密企业名称丙",
  importName: "合成机密导入企业辛",
  incrementalName: "合成机密增量企业壬",
  accountName: "合成机密科目名称乙",
  summary: "合成机密摘要丙",
  assetName: "合成机密资产名称庚",
  note: "合成机密备注戊",
  enterpriseKey: "91350000ENTRYX01",
  batchId: "syn-entry-batch-20261022",
  sourceSystem: "syn-entry-source",
  filePath: "D:/合成机密路径/凭证明细.zip",
};
const MARKERS = Object.values(X);
function assertNoLeak(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const hits = MARKERS.filter((marker) => text.includes(marker));
  assert.deepEqual(hits, [], `${label} 泄漏合成敏感原值：${hits.join(" / ")}`);
}

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
const dataDir = mkdtempSync(join(tmpdir(), "wb-model-entry-"));
process.env.WORKBENCH_DATA_DIR = dataDir;
const A = await import("../server/accounting.mjs");
const { callAgentTool } = await import("../server/agent-tools.mjs");
const ENTRY = await import("../server/finance-model-entry.mjs");
const { createFinanceModelEntry } = ENTRY;
const { FINANCE_QUERY_AVAILABLE, PLAIN_MODEL_TOOLS } = await import("../server/finance-model-adapter.mjs");
const { OUTPUT_POLICY_VERSION } = await import("../server/finance-output-policy.mjs");

const executed = [];
const executeRaw = async (name, args) => {
  executed.push(name);
  return callAgentTool(name, args);
};
const entry = createFinanceModelEntry({ executeRaw });
const envelopes = [];

async function callExpectExecutions(name, args, times) {
  const before = executed.length;
  const envelope = await entry.callModelTool(name, args);
  assert.equal(executed.length - before, times, `${name} 执行次数应为 ${times}`);
  envelopes.push(envelope);
  assertNoLeak(envelope, `${name} 信封`);
  return envelope;
}
const queryOk = async (name, args) => {
  const envelope = await callExpectExecutions(name, args, 1);
  assert.equal(envelope.ok, true, `${name} 应成功：${JSON.stringify(envelope.error || null)}`);
  assert.equal(envelope.outputPolicy, OUTPUT_POLICY_VERSION);
  assert.equal(envelope.channel, "model");
  assert.equal(envelope.rawValuesIncluded, false);
  if (envelope.localRef !== null) assert.match(envelope.localRef, /^finref_[a-f0-9]{48}$/);
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
const expectFailure = async (name, args, code, executions = 0) => {
  const envelope = await callExpectExecutions(name, args, executions);
  assert.equal(envelope.ok, false, `${name} 应被拒绝`);
  assert.equal(envelope.error.code, code, `${name} 错误码应为 ${code}，实际 ${envelope.error.code}`);
  return envelope;
};
const expectRefError = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, `应报 ${code}，实际 ${error?.code || error?.message}`);
    return true;
  });
};

// ---------------------------------------------------------------- 真实基础数据（本机 raw 路径建库）
const setA = A.createAccountSet({ name: X.enterpriseA, start_period: "2026-01" });
const setB = A.createAccountSet({ name: X.enterpriseB, start_period: "2026-01" });
A.setOpeningBalances(setA.id, [
  { code: "1002", debit: 1000, credit: 0 },
  { code: "1601", debit: 1200, credit: 0 },
  { code: "3001", debit: 0, credit: 2200 },
]);
A.setOpeningBalances(setB.id, [
  { code: "1002", debit: 2000, credit: 0 },
  { code: "3001", debit: 0, credit: 2000 },
]);
A.addAccount(setA.id, { code: "190101", name: X.accountName, category: "资产", direction: "debit" });
const v1 = A.createVoucher(setA.id, {
  period: "2026-01", voucher_date: "2026-01-10", summary: X.summary, status: "posted",
  entries: [
    { code: "1122", debit: 300, credit: 0, summary: X.summary },
    { code: "5001", debit: 0, credit: 300, summary: X.summary },
  ],
});
const assetIncrement = callAgentTool("book_import_incremental", {
  batchId: X.batchId,
  source: { system: X.sourceSystem, enterpriseKey: X.enterpriseKey, enterpriseName: X.incrementalName },
  payload: {
    account_set: { name: X.incrementalName, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
    opening_balances: [{ code: "1002", debit: 500, credit: 0 }, { code: "3001", debit: 0, credit: 500 }],
    vouchers: [],
  },
  dryRun: false,
});
const incremental = await assetIncrement;
const setD = incremental.created.accountSetId;

await test("0. 夹具证明标记确实进入真实 DTO（本机 raw 可读原文）", async () => {
  const raw = await callAgentTool("finance_query", {
    nodeId: "enterprise_account.account_set", accountSetId: setA.id, period: "2026-01",
  });
  assert.equal(raw.data.name, X.enterpriseA);
  const rawList = await callAgentTool("account_list", { accountSetId: setA.id });
  assert.ok(rawList.items.some((item) => item.name === X.accountName));
  const rawVoucher = await callAgentTool("finance_query", {
    nodeId: "voucher.detail", accountSetId: setA.id, params: { voucherId: v1.id },
  });
  assert.equal(rawVoucher.data.summary, X.summary);
  const rawBatch = await callAgentTool("book_import_batch", { batchId: X.batchId });
  assert.equal(Array.isArray(rawBatch.sourceTrace), true);
  assert.equal(rawBatch.batch.accountSetId, setD);
  assert.ok(setD > 0);
});

await test("1. 默认预算 / TTL / 持久化语义未被放大", async () => {
  const stats = entry.stats();
  assert.equal(stats.ttlMs, 15 * 60 * 1000);
  assert.equal(stats.maxRefs, 256);
  assert.equal(stats.nodeBudget, 1_000_000);
  assert.equal(stats.byteBudget, 64 * 1024 * 1024);
  assert.equal(stats.persistence, "process_memory");
  assert.equal(stats.version, "finance-model-entry/v1");
});

await test("2. 静态目录：只回固定 nodeId 与计数，不回业务数据", async () => {
  const envelope = await callExpectExecutions("finance_query_catalog", {}, 0);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.catalog.available, [...FINANCE_QUERY_AVAILABLE]);
  assert.equal(envelope.catalog.unimplemented.length, 11);
  assert.equal(envelope.operation, "finance_query_catalog");
  assert.equal(envelope.scope, "global");
  assert.equal(envelope.localRef, null);
  assert.equal(envelope.refUnavailable, "global_scope");
});

await test("3. update_plan 只回状态 / 条数，不回显计划文本", async () => {
  const envelope = await callExpectExecutions("update_plan", { plan: [X.summary, X.note, X.assetName] }, 0);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.projection.planItemCount, 3);
  assert.equal(envelope.projection.persisted, false);
  assertNoLeak(envelope, "update_plan");
});

await test("4. account_context：全局分页 / 指定账套真实绑定", async () => {
  const globalPage = await queryOk("account_context", { limit: 2, offset: 0 });
  assert.equal(globalPage.scope, "global");
  assert.equal(globalPage.accountSetId, null);
  assert.equal(globalPage.projection.scope, "global");
  assert.equal(globalPage.projection.returnedCount, 2);
  assert.equal(globalPage.projection.truncated, true);
  assert.equal(globalPage.projection.nextOffset, 2);
  assert.equal(globalPage.projection.accountSetIds.length, 2);
  assert.equal(globalPage.localRef, null);
  assertNoLeak(globalPage, "account_context global");

  const lastPage = await queryOk("account_context", { limit: 2, offset: 2 });
  assert.equal(lastPage.projection.returnedCount >= 1, true);
  assert.equal(lastPage.projection.hasNextPage, false);

  const scoped = await queryOk("finance_context_resolve", { accountSetId: setA.id });
  assert.equal(scoped.scope, "account_set");
  assert.equal(scoped.accountSetId, setA.id);
  assert.equal(scoped.projection.accountSetId, setA.id);
  assert.equal(scoped.projection.startPeriod, "2026-01");
  assert.ok(scoped.projection.periodCount >= 1);
  assertNoLeak(scoped, "account_context scoped");

  await expectFailure("account_context", { limit: 100 }, "model_context_page_invalid");
  await expectFailure("account_context", { accountSetId: 999999 }, "account_set_not_found", 1);
});

await test("5. 查询工具全部返回非空摘要且金额与手算常量一致", async () => {
  const accounts = await queryOk("account_list", { accountSetId: setA.id });
  assert.ok(accounts.projection.accountCount >= 55);
  assert.deepEqual(accounts.projection.byCategory, {
    assets: accounts.projection.byCategory.assets, // 逐类计数由真实科目表派生（不硬编码实现）
    liabilities: accounts.projection.byCategory.liabilities,
    equity: accounts.projection.byCategory.equity,
    cost: accounts.projection.byCategory.cost,
    profit_loss: accounts.projection.byCategory.profit_loss,
  });
  assert.ok(accounts.projection.accountCount >= accounts.projection.leafCount);

  const opening = await queryOk("opening_balance_get", { accountSetId: setA.id });
  assert.equal(opening.projection.itemCount, 3);
  assert.equal(opening.projection.totalDebit, 2200);
  assert.equal(opening.projection.totalCredit, 2200);
  assert.equal(opening.projection.balanced, true);

  const periods = await queryOk("period_list", { accountSetId: setA.id });
  assert.equal(periods.projection.periodCount, 1);
  assert.equal(periods.projection.openPeriodCount, 1);

  const check = await queryOk("voucher_check", {
    accountSetId: setA.id,
    entries: [{ code: "1122", debit: 300 }, { code: "5001", credit: 300 }],
  });
  assert.equal(check.projection.checkOk, true);
  assert.equal(check.projection.totalDebit, 300);
  assert.equal(check.projection.totalCredit, 300);
  assert.equal(check.projection.balanced, true);

  const ledger = await queryOk("ledger_query", { accountSetId: setA.id, code: "1122", period: "2026-01" });
  assert.equal(ledger.projection.itemCount, 1);
  assert.equal(ledger.projection.periodDebit, 300);
  assert.equal(ledger.projection.closingBalance, 300);

  const cards = await queryOk("asset_list", { accountSetId: setA.id });
  assert.equal(cards.projection.cardCount, 0);
  assert.equal(cards.projection.fixedCount, 0);
  assert.equal(cards.projection.totalOriginalCost, 0);
  assert.equal(cards.projection.totalAccumulated, 0);
});

await test("6. finance_query 全部 12 个已实现 node：只投影 data，金额与手算一致", async () => {
  const cases = [
    ["enterprise_account.account_set", {}, (p) => {
      assert.equal(p.accountSetId, setA.id);
      assert.equal(p.startPeriod, "2026-01");
      assert.equal(p.hasDisplayName, true);
    }],
    ["enterprise_account.subject_system.all", {}, (p) => assert.ok(p.accountCount >= 55)],
    ["voucher.generated.list", { period: "2026-01" }, (p) => {
      assert.equal(p.voucherCount, 1);
      assert.equal(p.totalDebit, 300);
      assert.equal(p.totalCredit, 300);
      assert.equal(p.balanced, true);
    }],
    ["voucher.generated.summary", { period: "2026-01" }, (p) => assert.equal(p.voucherCount, 1)],
    ["voucher.detail", { params: { voucherId: v1.id } }, (p) => {
      assert.equal(p.voucherId, v1.id);
      assert.equal(p.status, "posted");
      assert.equal(p.lineCount, 2);
      assert.equal(p.totalDebit, 300);
    }],
    ["report.balance_sheet", { period: "2026-01" }, (p) => {
      assert.equal(p.assets, 2500);
      assert.equal(p.liabilities, 0);
      assert.equal(p.equity, 2500);
      assert.equal(p.balanced, true);
      assert.equal(p.cash, 1000);
      assert.equal(p.receivables, 300);
      assert.equal(p.fixedAssetsNet, 1200);
    }],
    ["report.income_statement", { period: "2026-01" }, (p) => {
      assert.equal(p.currentRevenue, 300);
      assert.equal(p.currentNetProfit, 300);
      assert.equal(p.ytdRevenue, 300);
    }],
    ["report.cash_flow_statement", { period: "2026-01" }, (p) => {
      assert.equal(p.cashBegin, 1000);
      assert.equal(p.cashEnd, 1000);
      assert.equal(p.cashChange, 0);
      assert.equal(p.reconciles, true);
    }],
    ["period_end.summary", { period: "2026-01" }, (p) => {
      assert.equal(p.periodCount, 1);
      assert.equal(p.closingDebit, 2500);
      assert.equal(p.closingCredit, 2500);
      assert.equal(p.balanced, true);
    }],
    ["report.trial_balance", { period: "2026-01" }, (p) => {
      assert.equal(p.closingDebit, 2500);
      assert.equal(p.closingCredit, 2500);
      assert.equal(p.balanced, true);
    }],
    ["ledger.general", { period: "2026-01", params: { code: "1122" } }, (p) => {
      assert.equal(p.itemCount, 1);
      assert.equal(p.closingBalance, 300);
    }],
  ];
  // draft.summary 需要真实草稿：先建、查询、再删除，保持后续封账可执行。
  const draft = await writeOk("voucher_create", {
    accountSetId: setA.id, period: "2026-01",
    entries: [{ code: "1001", debit: 50 }, { code: "1002", credit: 50 }],
  });
  assert.equal(draft.projection.status, "draft");

  for (const [nodeId, extra, check] of cases) {
    const envelope = await queryOk("finance_query", { nodeId, accountSetId: setA.id, ...extra });
    assert.equal(envelope.nodeId, nodeId);
    assert.equal(envelope.operation, `finance_query:${nodeId}`);
    // 只投影真实 data：wrapper 的 nodeId / label / data 不进入 projection，也不二次投影。
    assert.equal(Object.prototype.hasOwnProperty.call(envelope.projection, "data"), false, `${nodeId} 不得二次套 wrapper`);
    assert.equal(Object.prototype.hasOwnProperty.call(envelope.projection, "label"), false);
    check(envelope.projection, envelope);
  }

  const drafts = await queryOk("finance_query", { nodeId: "voucher.draft.summary", accountSetId: setA.id, period: "2026-01" });
  assert.equal(drafts.projection.draftCount, 1);
  assert.equal(drafts.projection.voucherCount, 1);
  await writeOk("voucher_delete", { accountSetId: setA.id, voucherId: draft.projection.voucherId });

  // 未实现 / 未知 node 不执行后端。
  const rawBefore = await callAgentTool("finance_query", { nodeId: "report.trial_balance", accountSetId: setA.id, period: "2026-01" });
  assert.ok(rawBefore.data.totals);
  await expectFailure("finance_query", { nodeId: "invoice.detail", accountSetId: setA.id, period: "2026-01" }, "model_node_not_implemented");
  await expectFailure("finance_query", { nodeId: "nope.nope", accountSetId: setA.id, period: "2026-01" }, "model_node_unknown");
  await expectFailure("finance_query", { nodeId: "report.balance_sheet", accountSetId: setA.id }, "period_required", 1);
  await expectFailure("finance_query", { nodeId: "report.balance_sheet", period: "2026-01" }, "account_set_id_required");
});

await test("7. 写工具真实落库、applied=true，且无原文外发", async () => {
  const created = await writeOk("account_set_create", {
    name: X.enterpriseC, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01",
  });
  assert.equal(created.operationCategory, "create");
  assert.equal(created.scope, "result");
  assert.equal(created.accountSetIdSource, "result");
  assert.equal(created.projection.startPeriod, "2026-01");
  assert.ok(created.accountSetId > 0);

  const account = await writeOk("account_create", {
    accountSetId: setA.id, code: "190102", name: X.accountName, category: "资产", direction: "debit",
  });
  assert.ok(account.projection.accountCount >= 56);

  const opening = await writeOk("opening_balance_set", {
    accountSetId: setB.id,
    items: [{ code: "1002", debit: 2000, credit: 0 }, { code: "3001", debit: 0, credit: 2000 }],
  });
  assert.equal(opening.projection.itemCount, 2);

  const voucher = await writeOk("voucher_create", {
    accountSetId: setB.id, period: "2026-01", summary: X.summary,
    entries: [{ code: "1001", debit: 10 }, { code: "1002", credit: 10 }],
  });
  assert.equal(voucher.projection.status, "draft");
  assert.equal(voucher.projection.totalDebit, 10);
  const posted = await writeOk("voucher_post", { accountSetId: setB.id, voucherId: voucher.projection.voucherId });
  assert.equal(posted.projection.status, "posted");
  const unposted = await writeOk("voucher_unpost", { accountSetId: setB.id, voucherId: voucher.projection.voucherId });
  assert.equal(unposted.projection.status, "draft");
  const deleted = await writeOk("voucher_delete", { accountSetId: setB.id, voucherId: voucher.projection.voucherId });
  assert.equal(deleted.projection.deletedVoucherId, voucher.projection.voucherId);

  const period = await writeOk("period_set_status", { accountSetId: setB.id, period: "2026-02", status: "open" });
  assert.equal(period.projection.period, "2026-02");
  assert.equal(period.projection.status, "open");

  const asset = await writeOk("asset_create", {
    accountSetId: setA.id, kind: "fixed", name: X.assetName, original_cost: 1200,
    residual_rate: 0.05, useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01",
  });
  assert.equal(asset.projection.assetId > 0, true);
  assert.equal(asset.projection.originalCost, 1200);
  assert.equal(asset.projection.usefulLifeMonths, 12);
  const rawAssets = await callAgentTool("asset_list", { accountSetId: setA.id });
  assert.equal(rawAssets[0].name, X.assetName, "夹具证明资产名进入了真实 DTO");

  // 计提前的期末检查：应计提未计提必须阻止封账（不按“曾经计提过”放行）。
  const beforeDep = await queryOk("period_end_check", { accountSetId: setA.id, period: "2026-01" });
  assert.equal(beforeDep.projection.blockingCodes.includes("depreciation_missing"), true);
  assert.equal(beforeDep.projection.ready, false);

  const updated = await writeOk("asset_update", {
    accountSetId: setA.id, assetId: asset.projection.assetId, patch: { ledger_note: X.note },
  });
  assert.equal(updated.projection.assetId, asset.projection.assetId);
  assert.equal(updated.projection.ledgerStatus, "booked");
  assertNoLeak(updated, "asset_update");

  const dep = await writeOk("depreciation_run", { accountSetId: setA.id, period: "2026-01" });
  assert.equal(dep.projection.runCount, 1);
  assert.equal(dep.projection.totalAmount, 95);
  assert.ok(dep.projection.voucherId > 0);

  const pcheck = await queryOk("period_end_check", { accountSetId: setA.id, period: "2026-01" });
  assert.equal(pcheck.projection.blockingCodes.includes("profit_not_carried_forward"), true);
  assert.equal(pcheck.projection.stepCount, 7);

  const carry = await writeOk("carry_forward_profit", { accountSetId: setA.id, period: "2026-01" });
  assert.equal(carry.projection.profit, 205); // 300 − 95
  assert.ok(carry.projection.voucherId > 0);

  const ready = await queryOk("period_end_check", { accountSetId: setA.id, period: "2026-01" });
  assert.equal(ready.projection.ready, true);
  assert.equal(ready.projection.blockingCount, 0);

  const closed = await writeOk("period_set_status", { accountSetId: setA.id, period: "2026-01", status: "closed" });
  assert.equal(closed.projection.status, "closed");
});

await test("8. 建账 / 导入类写：setId 只取真实结果，默认预检不写", async () => {
  const legacyDry = await callExpectExecutions("legacy_book_import", {
    payload: {
      account_set: { name: X.importName, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
      opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      vouchers: [],
    },
  }, 1);
  assert.equal(legacyDry.ok, true);
  assert.equal(legacyDry.applied, false);
  assert.equal(legacyDry.appliedReason, "dry_run");
  assert.equal(legacyDry.accountSetId, null);
  assert.equal(legacyDry.localRef, null);
  assert.equal(legacyDry.refUnavailable, "not_applied");
  assert.equal(legacyDry.projection.dryRun, true);
  assert.equal(legacyDry.projection.createdAccountSetId, undefined);

  const legacyApplied = await writeOk("legacy_book_import", {
    dryRun: false,
    payload: {
      account_set: { name: X.importName, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
      opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      vouchers: [],
    },
  });
  assert.equal(legacyApplied.accountSetIdSource, "result");
  assert.equal(legacyApplied.projection.createdAccountSetId, legacyApplied.accountSetId);
  assert.equal(legacyApplied.projection.createdAccountCount >= 55, true);

  const preview = await callExpectExecutions("book_import_incremental", {
    batchId: `${X.batchId}-preview`, source: { system: X.sourceSystem, enterpriseKey: `${X.enterpriseKey}-P` },
    payload: {
      account_set: { name: X.incrementalName, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
      opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      vouchers: [],
    },
  }, 1);
  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.appliedReason, "dry_run");
  assert.equal(preview.projection.status, "preview");
  assert.equal(preview.projection.plannedAccountSetCreated, true);

  const applied = await writeOk("book_import_incremental", {
    batchId: `${X.batchId}-apply`, source: { system: X.sourceSystem, enterpriseKey: `${X.enterpriseKey}-A` },
    payload: {
      account_set: { name: X.incrementalName, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
      opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      vouchers: [],
    },
    dryRun: false,
  });
  assert.equal(applied.projection.status, "applied");
  assert.equal(applied.accountSetIdSource, "result");
  assert.ok(applied.accountSetId > 0);

  const replay = await callExpectExecutions("book_import_incremental", {
    batchId: `${X.batchId}-apply`, source: { system: X.sourceSystem, enterpriseKey: `${X.enterpriseKey}-A` },
    payload: {
      account_set: { name: X.incrementalName, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
      opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      vouchers: [],
    },
    dryRun: false,
  }, 1);
  assert.equal(replay.ok, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.appliedReason, "idempotent_replay");
  assert.equal(replay.projection.replayed, true);
  assert.equal(replay.accountSetId, applied.accountSetId);

  const batch = await queryOk("book_import_batch", { batchId: `${X.batchId}-apply` });
  assert.equal(batch.scope, "batch");
  assert.equal(batch.accountSetId, applied.accountSetId);
  assert.equal(batch.projection.batchStatus, "completed");
  assert.equal(batch.projection.accountSetId, applied.accountSetId);

  // 入参账套只能核对、不能替换真实结果所属账套。
  const mismatch = await callExpectExecutions("book_import_batch", { batchId: `${X.batchId}-apply`, accountSetId: setA.id }, 1);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "model_scope_mismatch");
});

await test("9. 本机引用：读原文 / 算合计 / 绑定与伪造拒绝", async () => {
  const listEnvelope = await queryOk("account_list", { accountSetId: setA.id });
  const raw = entry.readLocalReference({
    ref: listEnvelope.localRef, accountSetId: setA.id, operation: listEnvelope.operation,
  });
  assert.equal(raw.ok, true);
  assert.equal(raw.channel, "local");
  assert.equal(raw.value.accountSetId, setA.id);
  assert.ok(raw.value.items.some((item) => item.name === X.accountName));

  const ledgerEnvelope = await queryOk("ledger_query", { accountSetId: setA.id, code: "1122", period: "2026-01" });
  const sum = entry.computeLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: ledgerEnvelope.operation,
    op: "sum", path: "items.[].debit",
  });
  assert.equal(sum.value, 300);
  assert.equal(sum.matched, 1);
  const count = entry.computeLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: ledgerEnvelope.operation,
    op: "count", path: "items.[].debit",
  });
  assert.equal(count.value, 1);

  expectRefError(() => entry.readLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setB.id, operation: ledgerEnvelope.operation,
  }), "output_policy_ref_cross_account");
  expectRefError(() => entry.readLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: "account_list",
  }), "output_policy_ref_binding_mismatch");
  expectRefError(() => entry.readLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id,
  }), "output_policy_operation_required");
  expectRefError(() => entry.readLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: ledgerEnvelope.operation, local: true,
  }), "output_policy_channel_untrusted");
  expectRefError(() => entry.readLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: ledgerEnvelope.operation, channel: "local",
  }), "output_policy_channel_untrusted");
  expectRefError(() => entry.readLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: ledgerEnvelope.operation, channel: { channelId: "localch_fake" },
  }), "output_policy_channel_untrusted");
  expectRefError(() => entry.readLocalReference({ ref: "finref_" + "0".repeat(48), accountSetId: setA.id, operation: "account_list" }),
    "output_policy_ref_unknown");
  expectRefError(() => entry.readLocalReference({ ref: "not-a-ref", accountSetId: setA.id, operation: "account_list" }),
    "output_policy_ref_invalid");
  expectRefError(() => entry.computeLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: ledgerEnvelope.operation, op: "avg", path: "items",
  }), "output_policy_compute_op_invalid");
  expectRefError(() => entry.computeLocalReference({
    ref: ledgerEnvelope.localRef, accountSetId: setA.id, operation: ledgerEnvelope.operation, op: "sum", path: "__proto__.x",
  }), "output_policy_path_invalid");
});

await test("10. TTL 到期 / 撤销 / 释放额度（受控时钟，不暴露配置）", async () => {
  let clock = 1_000_000;
  const ttlEntry = createFinanceModelEntry({
    executeRaw,
    policyOptions: { now: () => clock, maxRefs: 2 },
  });
  const first = await ttlEntry.callModelTool("account_list", { accountSetId: setA.id });
  assert.equal(first.ok, true);
  clock += 15 * 60 * 1000 - 1;
  assert.equal(ttlEntry.readLocalReference({
    ref: first.localRef, accountSetId: setA.id, operation: first.operation,
  }).ok, true);
  clock += 2;
  expectRefError(() => ttlEntry.readLocalReference({
    ref: first.localRef, accountSetId: setA.id, operation: first.operation,
  }), "output_policy_ref_expired");
  assert.equal(ttlEntry.stats().refs, 0, "过期引用应立即归还额度");

  const second = await ttlEntry.callModelTool("account_list", { accountSetId: setA.id });
  const third = await ttlEntry.callModelTool("account_list", { accountSetId: setA.id });
  assert.equal(second.ok && third.ok, true);
  const over = await ttlEntry.callModelTool("account_list", { accountSetId: setA.id });
  assert.equal(over.ok, false);
  assert.equal(over.error.code, "output_policy_ref_capacity_exceeded");
  ttlEntry.revokeLocalReference({ ref: second.localRef, accountSetId: setA.id, operation: second.operation });
  expectRefError(() => ttlEntry.readLocalReference({ ref: second.localRef, accountSetId: setA.id, operation: second.operation }),
    "output_policy_ref_unknown");
  const reused = await ttlEntry.callModelTool("account_list", { accountSetId: setA.id });
  assert.equal(reused.ok, true, "撤销后额度应释放");
});

await test("11. 并发 / 参数快照：引用不串账套、同一请求只执行一次", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const wrappedEntry = createFinanceModelEntry({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (name === "account_list") await gate;
      return value;
    },
  });
  const pendingA = wrappedEntry.callModelTool("account_list", { accountSetId: setA.id });
  const pendingB = wrappedEntry.callModelTool("account_list", { accountSetId: setB.id });
  release();
  const [envA, envB] = await Promise.all([pendingA, pendingB]);
  assert.equal(envA.accountSetId, setA.id);
  assert.equal(envB.accountSetId, setB.id);
  const rawA = wrappedEntry.readLocalReference({ ref: envA.localRef, accountSetId: setA.id, operation: envA.operation });
  const rawB = wrappedEntry.readLocalReference({ ref: envB.localRef, accountSetId: setB.id, operation: envB.operation });
  assert.equal(rawA.value.accountSetId, setA.id);
  assert.equal(rawB.value.accountSetId, setB.id);

  // 调用方在异步挂起期间改入参：预验与执行必须使用同一份快照。
  const mutable = { accountSetId: setA.id };
  const before = executed.length;
  const pending = entry.callModelTool("account_list", mutable);
  mutable.accountSetId = 999999;
  const snapshotEnv = await pending;
  assert.equal(executed.length - before, 1);
  assert.equal(snapshotEnv.accountSetId, setA.id);
  assert.equal(snapshotEnv.ok, true);
  const snapshotRaw = entry.readLocalReference({
    ref: snapshotEnv.localRef, accountSetId: setA.id, operation: snapshotEnv.operation,
  });
  assert.equal(snapshotRaw.value.accountSetId, setA.id);
});

await test("12. 写三态：执行前拒绝 / 已写未确认 / 已写但投影降级（不重试）", async () => {
  const before = executed.length;
  const rejected = await expectFailure("voucher_create", {
    period: "2026-01", entries: [{ code: "1001", debit: 1 }, { code: "1002", credit: 1 }],
  }, "account_set_id_required", 0);
  assert.equal(rejected.applied, false);
  assert.equal(rejected.needsLocalReview, true);
  assert.equal(rejected.appliedReason, "rejected_before_execution");
  assert.equal(executed.length, before);

  // 写真实发生后再抛：只执行一次，applied 必须是 unknown（不能断言失败诱导重试）。
  const draft = await writeOk("voucher_create", {
    accountSetId: setB.id, period: "2026-01",
    entries: [{ code: "1001", debit: 20 }, { code: "1002", credit: 20 }],
  });
  let dropAfterWrite = false;
  const flakyEntry = createFinanceModelEntry({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (dropAfterWrite && name === "voucher_post") throw new Error("synthetic transport loss");
      return value;
    },
  });
  dropAfterWrite = true;
  const unknown = await flakyEntry.callModelTool("voucher_post", { accountSetId: setB.id, voucherId: draft.projection.voucherId });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.applied, "unknown");
  assert.equal(unknown.needsLocalReview, true);
  assert.equal(unknown.appliedReason, "unverified_result");
  const actual = await callAgentTool("finance_query", {
    nodeId: "voucher.detail", accountSetId: setB.id, params: { voucherId: draft.projection.voucherId },
  });
  assert.equal(actual.data.status, "posted", "写必须真实发生且只发生一次");

  // 已写但结果形状导致投影降级：applied=true 与真实 ID 保留，只丢引用。
  const degradedEntry = createFinanceModelEntry({
    executeRaw: async () => ({
      id: 4242,
      status: "posted",
      get entries() { throw new Error("synthetic getter"); },
    }),
  });
  const degraded = await degradedEntry.callModelTool("voucher_post", { accountSetId: setA.id, voucherId: 4242 });
  assert.equal(degraded.ok, true);
  assert.equal(degraded.applied, true);
  assert.equal(degraded.needsLocalReview, true);
  assert.equal(degraded.localRef, null);
  assert.equal(degraded.refUnavailable, "value_invalid");
  assert.equal(degraded.projection.voucherId, 4242);

  let writes = 0, getters = 0, committedId;
  const realDegraded = createFinanceModelEntry({ executeRaw: async (name, args) => {
    writes++;
    const value = await callAgentTool(name, args);
    committedId = value.id;
    Object.defineProperty(value, "syntheticSensitive", { enumerable: true, get() { getters++; throw new Error(X.summary); } });
    return value;
  } });
  const args = (amount) => ({ accountSetId: setB.id, period: "2026-01", summary: X.summary,
    entries: [{ code: "1001", debit: amount }, { code: "1002", credit: amount }] });
  const beforeReal = A.listVouchers(setB.id).length;
  const real = await realDegraded.callModelTool("voucher_create", args(19));
  assert.equal(A.listVouchers(setB.id).length, beforeReal + 1);
  assert.equal(writes, 1); assert.equal(getters, 0);
  assert.equal(real.applied, true); assert.equal(real.needsLocalReview, true);
  assert.equal(real.projection.voucherId, committedId);
  assert.equal(real.localRef, null); assert.equal(real.refUnavailable, "value_invalid");
  const detail = await callAgentTool("finance_query", { nodeId: "voucher.detail", accountSetId: setB.id, params: { voucherId: committedId } });
  assert.equal(detail.data.entries[0].debit, 19);
  assertNoLeak(real, "真实提交后降级");
  realDegraded.policy.dispose();

  let capacityWrites = 0;
  const capacity = createFinanceModelEntry({ policyOptions: { maxRefs: 1 }, executeRaw: async (name, a) => {
    capacityWrites++; return callAgentTool(name, a);
  } });
  const beforeCapacity = A.listVouchers(setB.id).length;
  const first = await capacity.callModelTool("voucher_create", args(17));
  const second = await capacity.callModelTool("voucher_create", args(23));
  assert.equal(A.listVouchers(setB.id).length, beforeCapacity + 2);
  assert.ok(first.localRef); assert.equal(second.localRef, null);
  assert.equal(second.refUnavailable, "capacity"); assert.equal(second.applied, true);
  assert.equal(second.needsLocalReview, false); assert.equal(capacityWrites, 2);
  const secondDetail = await callAgentTool("finance_query", { nodeId: "voucher.detail", accountSetId: setB.id, params: { voucherId: second.projection.voucherId } });
  assert.equal(secondDetail.data.entries[0].debit, 23);
  capacity.policy.dispose();
});

await test("13. 未知 / 未实现 / 税务工具：固定拒绝且不执行", async () => {
  for (const [name, code] of [
    ["no_such_tool", "model_tool_unknown"],
    ["invoice_issue", "model_tool_not_implemented"],
    ["tax_login_start", "model_tool_tax_excluded"],
    ["tax_api_catalog_search", "model_tool_tax_excluded"],
    ["book_import_batch", "batchId_required"],
  ]) {
    const envelope = await expectFailure(name, {}, code);
    assert.equal(envelope.channel, "model");
    assert.equal(envelope.rawValuesIncluded, false);
  }
  // 原型属性名不得被当作已登记工具。
  for (const name of ["toString", "constructor", "__proto__"]) {
    await expectFailure(name, {}, "model_tool_unknown");
  }
});

await test("14. 所有信封与捕获日志都不含合成敏感标记", async () => {
  assert.ok(envelopes.length > 20, `应收集到足够多的信封，实际 ${envelopes.length}`);
  for (const envelope of envelopes) assertNoLeak(envelope, "信封集合");
  assertNoLeak(logBuffer.join("\n"), "测试捕获日志");
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
process.exitCode = failed ? 1 : 0;
