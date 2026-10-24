#!/usr/bin/env node
// Fixed synthetic test identities, independent of display names and production defaults.
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-finance-model-adapter-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
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
import { mkdirSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

// ---------------------------------------------------------------- 合成敏感标记
const X = {
  enterpriseA: "合成机密企业名称甲",
  enterpriseB: "合成机密企业名称乙",
  enterpriseC: "合成机密企业名称丙",
  enterpriseD: "合成机密企业名称丁",
  enterpriseE: "合成机密企业名称癸",
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
const dataDir = resolve(tmpdir(), "m-"+randomUUID());mkdirSync(dataDir);
for(let p=dataDir;;p=dirname(p)){assert.equal(lstatSync(p).isSymbolicLink(),false);assert.equal(resolve(realpathSync.native(p)).toLowerCase(),p.toLowerCase());if(dirname(p)===p)break;}
Object.assign(process.env,{TEMP:dataDir,TMP:dataDir,WORKBENCH_DATA_DIR:dataDir,KEEP_FIXTURES:'1',WORKBENCH_TEST_KEEP_FIXTURES:'1'});
console.log('FIXTURES '+dataDir);
const A = await import("../server/accounting.mjs");
const { db: auditDb } = await import("../server/db.mjs");
let ownedPolicy;
try {
const { operationErrorEvidence } = await import("../server/local-audit-coordinator.mjs");
const { callAgentTool, AGENT_TOOL_NAMES } = await import("../server/agent-tools.mjs");
const { COA } = await import("../server/coa.mjs");
const ADAPTER = await import("../server/finance-model-adapter.mjs");
const { FinanceOutputPolicy, OUTPUT_POLICY_VERSION } = await import("../server/finance-output-policy.mjs");
const TRANSPORT = await import("../../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs");
const { createFinanceModelAdapter, FINANCE_QUERY_AVAILABLE, FINANCE_QUERY_UNIMPLEMENTED, PLAIN_MODEL_TOOLS, UNIMPLEMENTED_MODEL_TOOLS } = ADAPTER;

// ---------------------------------------------------------------- 执行计数 + 真实适配器
const executed = [];
let lastRealFailure;
function businessSnapshot() {
  const tables = auditDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const rows = tables.map(({name}) => [name, auditDb.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'" ORDER BY rowid').all()]);
  rows.push(['business_sequences',auditDb.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all()]);
  return JSON.stringify(rows);
}
const executeRaw = async (name, args) => {
  executed.push(name);
  const before = businessSnapshot();
  lastRealFailure = null;
  try { return await callAgentTool(name, args); }
  catch (error) {
    const prior=Object.fromEntries(JSON.parse(before)),setId=args.accountSetId,binding=prior.import_enterprise_account_sets.find(r=>r.account_set_id===setId);
    lastRealFailure = { proof: operationErrorEvidence(error), before, after: businessSnapshot(), resources:[`account-set:${setId}`,...(binding?[`book:${binding.enterprise_key}`]:[])] };
    throw error;
  }
};
function assertPrivateRollback(envelope) {
  assert.equal(envelope.applied, false);
  assert.ok(lastRealFailure?.proof, '真实 coordinator 私有提交证据必须存在');
  const {proof,before,after,resources} = lastRealFailure;
  assert.equal(proof.applied,false);
  assert.equal(proof.durability,'committed');
  const old=Object.fromEntries(JSON.parse(before)),current=Object.fromEntries(JSON.parse(after));
  const business=value=>Object.fromEntries(Object.entries(value).filter(([name])=>!['audit_events','audit_operations','local_batch_lock_epochs'].includes(name)).map(([name,rows])=>[name,name==='business_sequences'?rows.filter(r=>r.name!=='audit_events'):rows]));
  assert.deepEqual(business(current),business(old),'真实 rollback 后业务/来源/批次/全部业务序列/组件/实例逐字段零变');
  const priorEpoch=new Map(old.local_batch_lock_epochs.map(r=>[r.resource_key,r.last_token])),epochs=new Map(current.local_batch_lock_epochs.map(r=>[r.resource_key,r.last_token]));
  assert.deepEqual([...epochs.keys()].sort(),[...new Set([...priorEpoch.keys(),...resources])].sort(),'only exact acquired resources may gain epoch history');
  for(const [key,token] of epochs){assert.ok(Number.isSafeInteger(token)&&token>0);assert.equal(token,(priorEpoch.get(key)??0)+(resources.includes(key)?1:0),'exact resource epoch increment');}
  assert.deepEqual(current.local_batch_locks,old.local_batch_locks);assert.equal(current.local_batch_locks.length,0,'active locks released');
  for(const table of ['audit_events','audit_operations'])for(const row of old[table])assert.ok(current[table].some(r=>JSON.stringify(r)===JSON.stringify(row)),'original audit history remains exact');
  const added=table=>current[table].filter(r=>!old[table].some(o=>JSON.stringify(o)===JSON.stringify(r)));
  const newEvents=added('audit_events'),newOperations=added('audit_operations');assert.equal(newEvents.length,1);assert.equal(newOperations.length,1);
  assert.equal(newEvents[0].event_id,proof.receipt.eventId);assert.equal(newOperations[0].operation_id,proof.operationId);assert.deepEqual(JSON.parse(newOperations[0].receipt_json),proof.receipt);
  const seq=value=>value.business_sequences.find(r=>r.name==='audit_events')?.seq??0;assert.equal(seq(current),seq(old)+1,'exact single failure event sequence');
  assert.ok(['failed','rejected'].includes(proof.receipt.state));
  const saved = auditDb.prepare('SELECT receipt_json FROM audit_operations WHERE operation_id=? AND database_instance_id=? AND attempt=?').get(proof.operationId,proof.receipt.databaseInstanceId,proof.receipt.attempt);
  assert.deepEqual(JSON.parse(saved.receipt_json),proof.receipt,'失败 receipt 已真实持久化');
  const event = auditDb.prepare('SELECT outcome FROM audit_events WHERE event_id=?').get(proof.receipt.eventId);
  assert.equal(event.outcome,proof.receipt.state);
}
const adapter = createFinanceModelAdapter({ executeRaw });
const policy = adapter.policy;ownedPolicy=policy;
const TRANSPORT_REGISTRY = {
  operations: [
    ...Object.values(PLAIN_MODEL_TOOLS).map((spec) => spec.operation).filter((operation) => typeof operation === "string"),
    ...FINANCE_QUERY_AVAILABLE.map((nodeId) => `finance_query:${nodeId}`),
  ],
  tools: [...Object.keys(PLAIN_MODEL_TOOLS), ...UNIMPLEMENTED_MODEL_TOOLS],
  nodeIds: [...FINANCE_QUERY_AVAILABLE, ...FINANCE_QUERY_UNIMPLEMENTED],
};

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
const setA = identityFixtureCreate(A, { name: X.enterpriseA, start_period: "2026-01" });
const setB = identityFixtureCreate(A, { enterprise: { enterpriseKey: X.enterpriseKeyAppend }, name: X.enterpriseB, start_period: "2026-01" });
const setC = identityFixtureCreate(A, { name: X.enterpriseC, start_period: "2026-01" });
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
    acquired_period: "2026-02", opening_accumulated: 0, ledger_status: "booked", origin: "purchase",
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
  globalThis.__assetId = asset.projection.assetId;
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
    profile: "small_basic_v1", legacy: false, mappingStatus: "complete", complete: true, partialValues: false, diagnosticCount: 0, diagnosticCounts: {},
    period: "2026-01", assets: 1700, liabilities: 0, equity: 1700, balanced: true, lineCount: A.balanceSheet(setA.id, "2026-01").rows.length,
    cash: 1700, receivables: 0, inventory: 0, fixedAssetsNet: 0,
  });

  const income = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "report.income_statement", period: "2026-01" });
  assert.deepEqual(income.projection, {
    profile: "small_basic_v1", legacy: false, mappingStatus: "complete", complete: true, partialValues: false, diagnosticCount: 0, diagnosticCounts: {},
    period: "2026-01", currentRevenue: 1000, currentCost: 0, currentExpenses: 300,
    currentProfitBeforeTax: 700, currentNetProfit: 700, ytdRevenue: 1000, ytdNetProfit: 700,
  });

  const cashFlow = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "report.cash_flow_statement", period: "2026-01" });
  assert.deepEqual(cashFlow.projection, {
    profile: "small_basic_v1", legacy: false, mappingStatus: "complete", complete: true, partialValues: false, diagnosticCount: 0, diagnosticCounts: {},
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

  // 真实业务失败由 coordinator 证明已回滚，失败 receipt 与业务零变共同核证。
  const missingVoucher = await callExpectExecutions("voucher_post", { accountSetId: setA.id, voucherId: 987654 }, 1);
  assert.equal(missingVoucher.ok, false);
  assert.equal(missingVoucher.error.code, "voucher_not_found");
  assertPrivateRollback(missingVoucher);
  assert.equal(missingVoucher.needsLocalReview, true);
  assert.equal(missingVoucher.localRef, null);
  assert.equal(missingVoucher.refUnavailable, "outcome_unknown");
});

await test("写生命周期：反过账 / 过账 / 删除 / 结转 / 折旧 / 期间，成功与业务失败都如实", async () => {
  const unpost = await writeOk("voucher_unpost", { accountSetId: setA.id, voucherId: globalThis.__v1Id });
  assert.equal(unpost.projection.status, "draft");
  const repost = await writeOk("voucher_post", { accountSetId: setA.id, voucherId: globalThis.__v1Id });
  assert.equal(repost.projection.status, "posted");

  // 已过账凭证直接删除：域层真实回滚并持久化失败 receipt。
  const blockedDelete = await callExpectExecutions("voucher_delete", { accountSetId: setA.id, voucherId: globalThis.__v2Id }, 1);
  assert.equal(blockedDelete.ok, false);
  assert.equal(blockedDelete.error.code, "posted_voucher_requires_unpost");
  assertPrivateRollback(blockedDelete);
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
  assertPrivateRollback(again);

  // 真实完整资产登记：2026-02 用借贷平衡的购入凭证入账 1200（1601 / 1002），
  // 卡片取得 / 起提期间同为 2026-02，后续封账前置可真实通过。
  const assetPurchase = await writeOk("voucher_create", {
    accountSetId: setA.id, period: "2026-02", summary: X.summary, status: "posted",
    entries: [
      { code: "1601", summary: X.counterparty, debit: 1200, credit: 0 },
      { code: "1002", summary: X.person, debit: 0, credit: 1200 },
    ],
  });
  assert.equal(assetPurchase.projection.totalDebit, 1200);
  assert.equal(assetPurchase.projection.totalCredit, 1200);

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
  assertPrivateRollback(closedCreate);
  assert.equal(closedCreate.needsLocalReview, true);
  const reopened = await writeOk("period_set_status", { accountSetId: setA.id, period: "2026-01", status: "open" });
  assert.deepEqual(reopened.projection, { period: "2026-01", status: "open" });

  const badStatus = await callExpectExecutions("period_set_status", { accountSetId: setA.id, period: "2026-01", status: "bogus" }, 1);
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.error.code, "status_invalid");
  assertPrivateRollback(badStatus);

  // 折旧残留草稿 → 再次计提被拒；重过账恢复后不影响已计提金额
  await writeOk("voucher_unpost", { accountSetId: setA.id, voucherId: depreciation.projection.voucherId });
  const draftBlocked = await callExpectExecutions("depreciation_run", { accountSetId: setA.id, period: "2026-02" }, 1);
  assert.equal(draftBlocked.ok, false);
  assert.equal(draftBlocked.error.code, "depreciation_draft_exists");
  assertPrivateRollback(draftBlocked);
  const repostedDepreciation = await writeOk("voucher_post", { accountSetId: setA.id, voucherId: depreciation.projection.voucherId });
  assert.equal(repostedDepreciation.projection.status, "posted");

  // 期初 / 科目：真实业务失败也不伪装成功
  const openingAfterPosting = await callExpectExecutions("opening_balance_set", {
    accountSetId: setA.id, items: [{ code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 }],
  }, 1);
  assert.equal(openingAfterPosting.ok, false);
  assert.equal(openingAfterPosting.error.code, "opening_rewrite_after_posting");
  assertPrivateRollback(openingAfterPosting);
  const badAccount = await callExpectExecutions("account_create", {
    accountSetId: setA.id, code: "190103", name: "", category: "资产", direction: "debit",
  }, 1);
  assert.equal(badAccount.ok, false);
  assert.equal(badAccount.error.code, "code_and_name_required");
  assertPrivateRollback(badAccount);
});

await test("LOCAL-02 兼容：period_end_check 只读固定投影 / asset_update 写 / 封账成功与前置拒绝", async () => {
  const updated = await writeOk("asset_update", {
    accountSetId: setA.id, assetId: globalThis.__assetId, patch: { ledger_note: X.summary },
  });
  assert.equal(updated.projection.assetId, globalThis.__assetId);
  assert.equal(updated.projection.acquiredPeriod, "2026-02");
  assert.equal(updated.projection.openingAccumulated, 0);
  assert.equal(updated.projection.ledgerStatus, "booked");
  assert.equal(updated.projection.origin, "purchase");
  assert.equal("name" in updated.projection, false);
  assert.equal("ledgerNote" in updated.projection, false);
  assertNoLeak(updated, "asset_update projection");
  assert.equal(TRANSPORT.validateModelEnvelope(updated, TRANSPORT_REGISTRY).ok, true);

  // 资产新字段校验错误：真实领域错误 → 固定 asset 分类，不降成 unknown。
  const badUpdate = await callExpectExecutions("asset_update", {
    accountSetId: setA.id, assetId: globalThis.__assetId, patch: { acquired_period: "2026-13" },
  }, 1);
  assert.equal(badUpdate.ok, false);
  assert.equal(badUpdate.error.code, "acquired_period_invalid");
  assert.equal(badUpdate.error.category, "asset");
  assertPrivateRollback(badUpdate);
  assert.equal(TRANSPORT.validateModelEnvelope(badUpdate, TRANSPORT_REGISTRY).ok, true);

  const jan = await queryOk("period_end_check", { accountSetId: setA.id, period: "2026-01" });
  assert.equal(jan.projection.period, "2026-01");
  assert.equal(jan.projection.ready, true);
  assert.equal(jan.projection.stepCount, 7);
  assert.equal(jan.projection.stepIds.length, 7);
  assert.equal(jan.projection.stepStatuses.length, 7);
  assert.equal(jan.projection.blockedStepCount, 0);
  assert.equal(jan.projection.blockingCount, 0);
  assert.deepEqual(jan.projection.blockingCodes, []);
  assert.equal(TRANSPORT.validateModelEnvelope(jan, TRANSPORT_REGISTRY).ok, true);

  const feb = await queryOk("period_end_check", { accountSetId: setA.id, period: "2026-02" });
  assert.equal(feb.projection.ready, false);
  assert.equal(feb.projection.stepIds.length, 7);
  assert.equal(feb.projection.stepStatuses.length, 7);
  assert.ok(feb.projection.blockingCount >= 1);
  assert.ok(feb.projection.blockingCodes.includes("profit_not_carried_forward"));
  assert.equal(TRANSPORT.validateModelEnvelope(feb, TRANSPORT_REGISTRY).ok, true);

  // 期末检查原始 DTO 里的标题 / 原因 / blocking message / details 都是自由文本，
  // 适配层只投影固定步骤 / 状态 / 计数 / 固定码；注入合成原文验证不泄漏。
  const noisy = createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (name === "period_end_check") {
        value.steps[0].title = X.enterpriseA;
        value.steps[0].reason = X.summary;
        value.blocking[0].message = X.counterparty;
        value.blocking[0].details = { assetName: X.assetName, note: X.summary };
      }
      return value;
    },
  });
  const noisyCheck = await noisy.callModelTool("period_end_check", { accountSetId: setA.id, period: "2026-02" });
  assert.equal(noisyCheck.ok, true);
  assertNoLeak(noisyCheck, "noisy period_end_check");
  assert.equal(JSON.stringify(noisyCheck.projection).includes("assetName"), false);
  noisy.policy.dispose();

  // 不满足前置：封账明确失败且给固定 period_end 分类（不是 unknown）。
  const blockedClose = await callExpectExecutions("period_set_status", {
    accountSetId: setA.id, period: "2026-02", status: "closed",
  }, 1);
  assert.equal(blockedClose.ok, false);
  assert.equal(blockedClose.error.code, "period_end_check_failed");
  assert.equal(blockedClose.error.category, "period_end");
  assertPrivateRollback(blockedClose);
  assert.equal(TRANSPORT.validateModelEnvelope(blockedClose, TRANSPORT_REGISTRY).ok, true);

  // 真正封账成功路径：1 月草稿 / 试算 / 计提 / 卡片核对 / 损益结转 / 期间顺序均满足。
  const closed = await writeOk("period_set_status", { accountSetId: setA.id, period: "2026-01", status: "closed" });
  assert.deepEqual(closed.projection, { period: "2026-01", status: "closed" });
  assert.equal(TRANSPORT.validateModelEnvelope(closed, TRANSPORT_REGISTRY).ok, true);
});

await test("LOCAL-02 回修1/2：真实 7 步期末检查长阻塞码完整、错误 DTO 形状（缺 / 重 / 矛盾）一律 model_result_invalid 不建引用", async () => {
  // 真实业务链：新账套 → 1 期寿命的导入卡片（2026-02 取得、起提 2026-01）→ 2026-03 真实购入凭证。
  // 手算预期：卡片在 2026-02 已是「超过寿命未提足」（index 1 ≥ life 1，累计 0 < 原值 1200），
  // 因 2026-02 未封账且不能跳过，2026-03 的期末检查应同时给出三条真实阻塞：
  //   depreciation 步骤：depreciation_life_expired_underprovided（39 字符）
  //   period_sequence 步骤：previous_period_depreciation_pending（36 字符）+ previous_period_open
  const setE = await writeOk("account_set_create", { enterprise: identityFixture(),
    name: X.enterpriseE, start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则",
  });
  const setIdE = setE.projection.accountSetId;
  const card = await writeOk("asset_create", {
    accountSetId: setIdE, kind: "fixed", name: X.assetName,
    original_cost: 1200, residual_rate: 0, useful_life_months: 1, start_period: "2026-01",
    acquired_period: "2026-02", opening_accumulated: 0, ledger_status: "booked", origin: "import",
  });
  assert.equal(card.projection.assetId > 0, true);
  const buy = await writeOk("voucher_create", {
    accountSetId: setIdE, period: "2026-03", summary: X.summary, status: "posted",
    entries: [
      { code: "1601", summary: X.counterparty, debit: 1200, credit: 0 },
      { code: "1002", summary: X.person, debit: 0, credit: 1200 },
    ],
  });
  assert.equal(buy.projection.status, "posted");

  const check = await queryOk("period_end_check", { accountSetId: setIdE, period: "2026-03" });
  assert.equal(check.projection.ready, false);
  assert.equal(check.projection.stepCount, 7);
  assert.equal(check.projection.stepIds.length, 7);
  assert.equal(check.projection.stepStatuses.length, 7);
  assert.deepEqual(check.projection.blockedStepIds, ["depreciation", "period_sequence"]);
  assert.equal(check.projection.blockedStepCount, 2);
  assert.equal(check.projection.blockingCount, 3);
  assert.deepEqual(check.projection.blockingCodes, [
    "depreciation_life_expired_underprovided",
    "previous_period_depreciation_pending",
    "previous_period_open",
  ]);
  // 两条真实长码都必须**完整**到达模型通道：投影丢弃计数为 0。
  assert.equal(check.projectionDropped, 0);
  assert.equal(JSON.stringify(check).includes(X.assetName), false);
  assert.equal(TRANSPORT.validateModelEnvelope(check, TRANSPORT_REGISTRY).ok, true);
  // 同一账套的未封账期间仍是真实阻塞（不能把长码丢弃后当成可封账）。
  const denied = await callExpectExecutions("period_set_status", {
    accountSetId: setIdE, period: "2026-03", status: "closed",
  }, 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "period_end_check_failed");

  // 真实 DTO 作为基底，注入矛盾形状：一律 model_result_invalid，且不创建任何引用。
  const realCheck = await callAgentTool("period_end_check", { accountSetId: setIdE, period: "2026-03" });
  const tamperedAdapter = (mutate) => createFinanceModelAdapter({
    executeRaw: async (name, args) => (name === "period_end_check"
      ? mutate(structuredClone(realCheck))
      : callAgentTool(name, args)),
  });
  const expectInvalidDto = async (label, mutate) => {
    const probe = tamperedAdapter(mutate);
    const before = probe.policy.stats().refs;
    const envelope = await probe.callModelTool("period_end_check", { accountSetId: setIdE, period: "2026-03" });
    assert.equal(envelope.ok, false, label);
    assert.equal(envelope.error.code, "model_result_invalid", label);
    assert.equal(envelope.error.category, "output_policy", label);
    assert.equal(envelope.localRef, undefined, `${label}：失败不得建引用`);
    assert.equal(probe.policy.stats().refs, before, `${label}：引用池不得变化`);
    assertNoLeak(envelope, label);
    probe.policy.dispose();
  };
  // 正例对照：同一套 harness 不改内容时确实成功并建引用（证明上面的拒绝不是“总是拒绝”）。
  const control = tamperedAdapter((value) => value);
  const controlEnvelope = await control.callModelTool("period_end_check", { accountSetId: setIdE, period: "2026-03" });
  assert.equal(controlEnvelope.ok, true);
  assert.equal(control.policy.stats().refs, 1);
  control.policy.dispose();

  await expectInvalidDto("ready:true + steps:[] + blocking:[]", (value) => ({
    ...value, ready: true, steps: [], blocking: [], missing: [],
  }));
  await expectInvalidDto("ready:true + 7 个重复 draft_vouchers", (value) => ({
    ...value,
    ready: true,
    steps: value.steps.map((step) => ({ ...step, id: "draft_vouchers", status: "ok" })),
    blocking: [],
    missing: [],
  }));
  await expectInvalidDto("ready:true + 全部步骤 blocked + blocking 非空", (value) => ({
    ...value,
    ready: true,
    steps: value.steps.map((step) => ({ ...step, status: "blocked" })),
  }));
  await expectInvalidDto("缺一个步骤", (value) => ({
    ...value, steps: value.steps.slice(0, 6), blocking: [], missing: [], ready: true,
  }));
  await expectInvalidDto("多一个重复步骤", (value) => ({
    ...value, steps: [...value.steps, { ...value.steps[0] }],
  }));
  await expectInvalidDto("blocking 归属到未阻塞步骤", (value) => ({
    ...value, blocking: value.blocking.map((item) => ({ ...item, step: "draft_vouchers" })),
  }));
  await expectInvalidDto("未知步骤 id（自由文本不得当 token）", (value) => ({
    ...value, steps: [...value.steps.slice(0, 6), { ...value.steps[6], id: "synthetic_sensitive_step" }],
  }));
});

await test("建账类写动作：setId 只能来自真实结果；dry-run / 失败明确未绑定，不造假 ID", async () => {
  const created = await writeOk("account_set_create", { enterprise: identityFixture(),
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
  const dry = await callExpectExecutions("legacy_book_import", { enterprise: identityFixture(), payload }, 1);
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

  const imported = await writeOk("legacy_book_import", { enterprise: identityFixture(), payload, dryRun: false });
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
  assert.equal(degraded.needsLocalReview, true);
  assert.equal(degraded.localRef, null);
  assert.equal(degraded.refUnavailable, "value_invalid");
  assert.deepEqual(degraded.projection, { voucherId: 4321 });
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
        accountingContext: A.balanceSheet(setA.id, "2026-01").accountingContext,
        reportStatus: { status: "complete", complete: true, partialValues: false, diagnostics: [] },
        period: "2026-01",
        assets: [
          { label: "货币资金", value: 1, huge: "y".repeat(4 * 1024 * 1024 + 1) },
          { label: "应收账款", value: 0 },
          { label: "存货", value: 0 },
          { label: "固定资产账面价值", value: 0 },
        ],
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

await test("review2 F2: async 边界前固定参数快照，调用方改账套 / 嵌套 payload 不能串账", async () => {
  const delayed = createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      // 模拟真实 async 工具：在 Promise 挂起之后才读取参数。
      await new Promise((resolve) => setTimeout(resolve, 5));
      return callAgentTool(name, args);
    },
  });
  const channelD = delayed.policy.issueChannel("local_ui");

  // 查询：预验 C，调用方改成 B；真实执行必须仍是 C，且引用只能属于 C。
  const queryArgs = { accountSetId: setC.id };
  const pendingQuery = delayed.callModelTool("account_list", queryArgs);
  queryArgs.accountSetId = setB.id;
  const queryEnvelope = await pendingQuery;
  assert.equal(queryEnvelope.ok, true, `查询不应串账：${JSON.stringify(queryEnvelope.error || null)}`);
  assert.equal(queryEnvelope.accountSetId, setC.id);
  const raw = delayed.policy.localRead(queryEnvelope.localRef, {
    channel: channelD, accountSetId: setC.id, operation: "account_list",
  });
  assert.equal(raw.value.accountSetId, setC.id);
  expectCode(
    () => delayed.policy.localRead(queryEnvelope.localRef, { channel: channelD, accountSetId: setB.id, operation: "account_list" }),
    "output_policy_ref_cross_account",
  );

  // 写：预验 C，调用方改账号并改嵌套 entries；真实必须只写 C 一次，金额保持快照值。
  const vouchersBeforeC = A.listVouchers(setC.id, { period: "2026-01" }).length;
  const vouchersBeforeB = A.listVouchers(setB.id).length;
  const writeArgs = {
    accountSetId: setC.id, period: "2026-01", summary: X.summary,
    entries: [
      { code: "1002", summary: X.counterparty, debit: 11, credit: 0 },
      { code: "5001", summary: X.person, debit: 0, credit: 11 },
    ],
  };
  const pendingWrite = delayed.callModelTool("voucher_create", writeArgs);
  writeArgs.accountSetId = setB.id;
  writeArgs.entries[0].debit = 999;
  writeArgs.entries.push({ code: "1002", debit: 1, credit: 0 });
  const writeEnvelope = await pendingWrite;
  assert.equal(writeEnvelope.ok, true, `写不应串账：${JSON.stringify(writeEnvelope.error || null)}`);
  assert.equal(writeEnvelope.applied, true);
  assert.equal(writeEnvelope.accountSetId, setC.id);
  assert.equal(A.listVouchers(setC.id, { period: "2026-01" }).length, vouchersBeforeC + 1);
  assert.equal(A.listVouchers(setB.id).length, vouchersBeforeB, "B 账套不得被写入");
  const createdVoucher = A.listVouchers(setC.id, { period: "2026-01" })
    .find((voucher) => voucher.id === writeEnvelope.projection.voucherId);
  assert.deepEqual(createdVoucher.entries.map((entry) => [entry.code, entry.debit, entry.credit]),
    [["1002", 11, 0], ["5001", 0, 11]]);
  assertNoLeak(writeEnvelope, "snapshot write envelope");

  // 查询结果回显另一个账套：不建错误绑定引用。
  const mismatched = createFinanceModelAdapter({
    executeRaw: async () => ({ accountSetId: setB.id, items: [] }),
  });
  const mismatchEnvelope = await mismatched.callModelTool("account_list", { accountSetId: setC.id });
  assert.equal(mismatchEnvelope.ok, false);
  assert.equal(mismatchEnvelope.error.code, "model_scope_mismatch");
  assert.equal("localRef" in mismatchEnvelope, false);

  // 原型继承 / 别名冲突 / 访问器：执行前安全拒绝，不调用真实工具，也不执行 getter。
  let guardCalls = 0;
  const guard = createFinanceModelAdapter({
    executeRaw: async (name, args) => { guardCalls++; return callAgentTool(name, args); },
  });
  const inherited = Object.create({ accountSetId: setB.id });
  inherited.account_set_id = setC.id;
  const inheritedEnvelope = await guard.callModelTool("account_list", inherited);
  assert.equal(inheritedEnvelope.ok, false);
  assert.equal(inheritedEnvelope.error.code, "model_arguments_invalid");
  const conflictEnvelope = await guard.callModelTool("account_list", {
    accountSetId: setC.id, account_set_id: setB.id,
  });
  assert.equal(conflictEnvelope.ok, false);
  assert.equal(conflictEnvelope.error.code, "account_set_id_conflict");
  let accessorCalls = 0;
  const accessorArgs = {};
  Object.defineProperty(accessorArgs, "accountSetId", {
    enumerable: true,
    get() { accessorCalls++; return setC.id; },
  });
  const accessorEnvelope = await guard.callModelTool("account_list", accessorArgs);
  assert.equal(accessorEnvelope.ok, false);
  assert.equal(accessorEnvelope.error.code, "model_arguments_invalid");
  assert.equal(accessorCalls, 0, "参数快照不得执行 getter");
  assert.equal(guardCalls, 0, "参数非法时不得调用真实工具");
  assertNoLeak(accessorEnvelope, "snapshot rejection");
  delayed.policy.dispose();
});

await test("review2 F3: 真实利润表删除 ytd 字段 / 变形结果必须失败，不用 0 冒充；真零值保留", async () => {
  const zero = await queryOk("finance_query", {
    accountSetId: setC.id, nodeId: "report.income_statement", period: "2026-01",
  });
  assert.equal(zero.projection.currentRevenue, 0);
  assert.equal(zero.projection.ytdRevenue, 0);

  const mutateIncome = createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (name === "finance_query" && value?.data?.ytd) delete value.data.ytd["营业收入"];
      return value;
    },
  });
  const brokenIncome = await mutateIncome.callModelTool("finance_query", {
    accountSetId: setC.id, nodeId: "report.income_statement", period: "2026-01",
  });
  assert.equal(brokenIncome.ok, false);
  assert.equal(brokenIncome.error.code, "model_result_invalid");
  assert.equal(JSON.stringify(brokenIncome).includes("ytdRevenue"), false);

  const mutateTrial = createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (name === "finance_query" && value?.data?.totals) delete value.data.totals.closing_debit;
      return value;
    },
  });
  const brokenTrial = await mutateTrial.callModelTool("finance_query", {
    accountSetId: setC.id, nodeId: "report.trial_balance", period: "2026-01",
  });
  assert.equal(brokenTrial.ok, false);
  assert.equal(brokenTrial.error.code, "model_result_invalid");
  assertNoLeak(brokenIncome, "broken income summary");
  assertNoLeak(brokenTrial, "broken trial summary");
});

await test("review2 F4: 真实 create / 增量 / 缺参错误与未应用写结果都能通过 transport", async () => {
  const createFailure = await callExpectExecutions("account_set_create", { enterprise: identityFixture(),}, 1);
  assert.equal(createFailure.ok, false);
  assert.equal(createFailure.error.code, "name_required");
  assert.equal(createFailure.operationCategory, "create");
  assert.equal(createFailure.scope, "result");
  assert.equal(TRANSPORT.validateModelEnvelope(createFailure, TRANSPORT_REGISTRY).ok, true);

  const incrementalFailure = await callExpectExecutions("book_import_incremental", {}, 1);
  assert.equal(incrementalFailure.ok, false);
  assert.equal(incrementalFailure.error.code, "import_validation_failed");
  assert.equal(incrementalFailure.operationCategory, "create");
  assert.equal(incrementalFailure.scope, "result");
  assert.equal(TRANSPORT.validateModelEnvelope(incrementalFailure, TRANSPORT_REGISTRY).ok, true);

  const noNode = await callExpectExecutions("finance_query", { accountSetId: setC.id }, 0);
  assert.equal(noNode.ok, false);
  assert.equal(noNode.error.code, "nodeId_required");
  assert.equal(TRANSPORT.validateModelEnvelope(noNode, TRANSPORT_REGISTRY).ok, true);

  const noVoucher = await callExpectExecutions("voucher_post", { accountSetId: setC.id }, 1);
  assert.equal(noVoucher.ok, false);
  assert.equal(noVoucher.error.code, "voucherId_required");
  assert.equal(TRANSPORT.validateModelEnvelope(noVoucher, TRANSPORT_REGISTRY).ok, true);

  const queryError = await callExpectExecutions("ledger_query", {
    accountSetId: setC.id, code: "NO-SUCH-CODE", period: "2026-01",
  }, 1);
  assert.equal(queryError.ok, false);
  assert.equal(queryError.error.code, "account_not_found");
  assert.equal(TRANSPORT.validateModelEnvelope(queryError, TRANSPORT_REGISTRY).ok, true);

  for (const [name, code] of [["voucher_approve", "model_tool_unknown"], ["tax_login_start", "model_tool_tax_excluded"], ["invoice_collect", "model_tool_not_implemented"]]) {
    const envelope = await callExpectExecutions(name, {}, 0);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, code);
    assert.equal(TRANSPORT.validateModelEnvelope(envelope, TRANSPORT_REGISTRY).ok, true);
  }

  // 真实 legacy dry-run：未应用写结果 applied:false / needsLocalReview:true 保留为正例。
  const dryRun = await callExpectExecutions("legacy_book_import", { enterprise: identityFixture(),
    payload: {
      account_set: { name: X.importName, start_period: "2026-01" },
      accounts: [], opening_balances: [], vouchers: [],
    },
  }, 1);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.needsLocalReview, true);
  assert.equal(TRANSPORT.validateModelEnvelope(dryRun, TRANSPORT_REGISTRY).ok, true);
});

await test("review3 F2: period / startPeriod / status 等投影字段按固定值域校验（自由 ASCII / 非法月份 / 缺字段 / 真零）", async () => {
  const mutate = (mutator) => createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      mutator(name, value);
      return value;
    },
  });

  // 利润表期间被塞入自由 ASCII 串：不是期间就失败，不回声原值
  const badIncomePeriod = mutate((name, value) => {
    if (name === "finance_query") value.data.period = "synthetic_sensitive_period";
  });
  const incomeBroken = await badIncomePeriod.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "report.income_statement", period: "2026-01",
  });
  assert.equal(incomeBroken.ok, false);
  assert.equal(incomeBroken.error.code, "model_result_invalid");
  assertNoLeak(incomeBroken, "bad income period");
  assert.equal(JSON.stringify(incomeBroken).includes("synthetic_sensitive_period"), false);

  // 非法月份 / 缺字段：同样明确失败
  const badMonth = mutate((name, value) => {
    if (name === "finance_query") value.data.period = "2026-13";
  });
  const monthBroken = await badMonth.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "report.balance_sheet", period: "2026-01",
  });
  assert.equal(monthBroken.ok, false);
  assert.equal(monthBroken.error.code, "model_result_invalid");

  const missingPeriod = mutate((name, value) => {
    if (name === "finance_query") delete value.data.period;
  });
  const periodMissing = await missingPeriod.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "report.trial_balance", period: "2026-01",
  });
  assert.equal(periodMissing.ok, false);
  assert.equal(periodMissing.error.code, "model_result_invalid");
  assert.equal(JSON.stringify(periodMissing).includes("period"), false);

  // 凭证详情 status 不能是任意小写 token
  const badVoucherStatus = mutate((name, value) => {
    if (name === "finance_query") value.data.status = "synthetic_sensitive_status";
  });
  const statusBroken = await badVoucherStatus.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "voucher.detail", voucherId: globalThis.__v1Id,
  });
  assert.equal(statusBroken.ok, false);
  assert.equal(statusBroken.error.code, "model_result_invalid");
  assertNoLeak(statusBroken, "bad voucher status");
  assert.equal(JSON.stringify(statusBroken).includes("synthetic_sensitive_status"), false);

  // 账套节点 startPeriod 必须严格 YYYY-MM
  const badStartPeriod = mutate((name, value) => {
    if (name === "finance_query") value.data.start_period = "2026-13";
  });
  const startBroken = await badStartPeriod.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "enterprise_account.account_set",
  });
  assert.equal(startBroken.ok, false);
  assert.equal(startBroken.error.code, "model_result_invalid");

  // 普通工具的状态 / 枚举同样按固定值域（不是“小写 ASCII 就是 token”）
  const badPeriodStatus = createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (name === "period_list") value.items[0].status = "synthetic_sensitive_status";
      return value;
    },
  });
  const periodListBroken = await badPeriodStatus.callModelTool("period_list", { accountSetId: setA.id });
  assert.equal(periodListBroken.ok, false);
  assert.equal(periodListBroken.error.code, "model_result_invalid");

  const badCategory = createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (name === "account_list") value.items[0].category = "synthetic_sensitive_category";
      return value;
    },
  });
  const categoryBroken = await badCategory.callModelTool("account_list", { accountSetId: setA.id });
  assert.equal(categoryBroken.ok, false);
  assert.equal(categoryBroken.error.code, "model_result_invalid");
  assert.equal(JSON.stringify(categoryBroken).includes("synthetic_sensitive_category"), false);

  const badKind = createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      if (name === "asset_list") value[0].kind = "synthetic_sensitive_kind";
      return value;
    },
  });
  const kindBroken = await badKind.callModelTool("asset_list", { accountSetId: setA.id });
  assert.equal(kindBroken.ok, false);
  assert.equal(kindBroken.error.code, "model_result_invalid");

  // 未受影响：合法期间 / 普通工具照常可用，真 0 保留
  const periods = await queryOk("period_list", { accountSetId: setA.id });
  assert.ok(periods.projection.periodCount >= 1);
  assert.ok(periods.projection.openPeriodCount >= 1);
  const zero = await queryOk("finance_query", { accountSetId: setC.id, nodeId: "report.income_statement", period: "2026-01" });
  assert.equal(zero.projection.currentRevenue, 0);
  assert.equal(zero.projection.currentNetProfit, 0);
  assert.equal(zero.projection.ytdRevenue, 0);
});

await test("review3 F3: finance_query 数据层账套核对（wrapper 无 id 也不能漏；聚合节点不误伤）", async () => {
  // 注入：wrapper 仍是 {nodeId,label,data}（无账套字段），但真实执行的是另一个账套。
  const crossSet = createFinanceModelAdapter({
    executeRaw: async (name, args) => (name === "finance_query"
      ? callAgentTool(name, { ...args, accountSetId: setB.id })
      : callAgentTool(name, args)),
  });
  assert.equal(crossSet.policy.stats().refs, 0);

  // 账套节点：data.id 直接暴露 B
  const accountSetNode = await crossSet.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "enterprise_account.account_set",
  });
  assert.equal(accountSetNode.ok, false);
  assert.equal(accountSetNode.error.code, "model_scope_mismatch");
  assert.equal("localRef" in accountSetNode, false, "不一致的查询不得创建引用");

  // 凭证节点：data.account_set_id
  const voucherB = A.listVouchers(setB.id)[0];
  assert.ok(voucherB, "B 账套应有真实凭证");
  assert.equal(voucherB.account_set_id, setB.id);
  const voucherNode = await crossSet.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "voucher.detail", voucherId: voucherB.id,
  });
  assert.equal(voucherNode.ok, false);
  assert.equal(voucherNode.error.code, "model_scope_mismatch");

  // 科目体系：逐行 account_set_id
  const subjects = await crossSet.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "enterprise_account.subject_system.all",
  });
  assert.equal(subjects.ok, false);
  assert.equal(subjects.error.code, "model_scope_mismatch");

  // 凭证列表：逐行 account_set_id（按 B 凭证真实状态选择对应 node）
  const listNode = voucherB.status === "posted" ? "voucher.generated.list" : "voucher.draft.summary";
  const listed = await crossSet.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: listNode, period: "2026-01",
  });
  assert.equal(listed.ok, false);
  assert.equal(listed.error.code, "model_scope_mismatch");

  // 三次不一致都不得留下引用
  assert.equal(crossSet.policy.stats().refs, 0);

  // 无账套字段的聚合节点不臆造必需字段：仍按 wrapper 结果正常通过
  const aggregate = await crossSet.callModelTool("finance_query", {
    accountSetId: setA.id, nodeId: "report.trial_balance", period: "2026-01",
  });
  assert.equal(aggregate.ok, true, `聚合节点不应被误拒：${JSON.stringify(aggregate.error || null)}`);
  assert.equal(aggregate.accountSetId, setA.id);

  // 真实 A 结果照常成功（归属一致时不误拒）
  const normal = await queryOk("finance_query", { accountSetId: setA.id, nodeId: "enterprise_account.account_set" });
  assert.equal(normal.projection.accountSetId, setA.id);

  // 普通只读工具里同样带 account_set_id 的 DTO（科目列表行）也按数据层核对
  const crossPlain = createFinanceModelAdapter({
    executeRaw: async (name, args) => callAgentTool(name, { ...args, accountSetId: setB.id }),
  });
  const crossAccounts = await crossPlain.callModelTool("account_list", { accountSetId: setA.id });
  assert.equal(crossAccounts.ok, false);
  assert.equal(crossAccounts.error.code, "model_scope_mismatch");
  assert.equal(crossPlain.policy.stats().refs, 0);
});

await test("review5 F1/F2: 上下文必需期间 / 可表示 ID 不得静默丢弃，projectionDropped 回真实计数", async () => {
  const contextExecutor = (sets, periods = []) => createFinanceModelAdapter({
    executeRaw: async (name) => {
      assert.equal(name, "account_context");
      return { account_sets: sets, periods };
    },
  });

  // 合法边界对照：上限 1e12 与相邻 999999999999 都是可表示 / 可选择的 ID。
  const atLimit = contextExecutor([
    { id: 999_999_999_999, name: X.enterpriseA, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-12" },
    { id: 1_000_000_000_000, name: X.enterpriseB, taxpayer_type: "一般纳税人", accounting_standard: "企业会计准则", start_period: "2026-01" },
  ]);
  const legal = await atLimit.callModelTool("account_context", { limit: 2 });
  assert.equal(legal.ok, true, `合法边界 ID 不应被拒：${JSON.stringify(legal.error || null)}`);
  assert.deepEqual(legal.projection.accountSetIds, [999_999_999_999, 1_000_000_000_000]);
  assert.equal(legal.projection.returnedCount, 2);
  assert.equal(legal.projection.truncated, false);
  assert.equal(legal.projectionDropped, 0);
  assert.equal(TRANSPORT.validateModelEnvelope(legal, TRANSPORT_REGISTRY).ok, true);
  assertNoLeak(legal, "legal context ids");
  atLimit.policy.dispose();

  // 超过 1e12 的合法正安全整数 ID：projection 无法表示 → 明确失败，不得 returnedCount=1 + 空列表。
  const overLimit = contextExecutor([
    { id: 1_000_000_000_001, name: X.enterpriseC, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" },
  ]);
  const rejected = await overLimit.callModelTool("account_context", {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "model_result_invalid");
  assert.equal("projection" in rejected, false);
  assert.equal(JSON.stringify(rejected).includes("1000000000001"), false, "拒绝回包不得回显不可表示 ID");
  overLimit.policy.dispose();

  // scoped：非法 / 缺失 start_period 与 global 分支一致明确失败（不再静默省略）。
  const badScoped = contextExecutor([
    { id: 1, name: "synthetic", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-13" },
  ]);
  const scopedBad = await badScoped.callModelTool("account_context", { accountSetId: 1 });
  assert.equal(scopedBad.ok, false);
  assert.equal(scopedBad.error.code, "model_result_invalid");
  assert.equal(JSON.stringify(scopedBad).includes("2026-13"), false);
  badScoped.policy.dispose();

  const missingScoped = contextExecutor([{ id: 1, name: "synthetic" }]);
  const scopedMissing = await missingScoped.callModelTool("account_context", { accountSetId: 1 });
  assert.equal(scopedMissing.ok, false);
  assert.equal(scopedMissing.error.code, "model_result_invalid");
  missingScoped.policy.dispose();

  // global 同一条路径：非法必需月份同样拒绝（不是只有 scoped 才校验）。
  const badGlobal = contextExecutor([{ id: 1, name: "synthetic", start_period: "2026-13" }]);
  const globalBad = await badGlobal.callModelTool("account_context", {});
  assert.equal(globalBad.ok, false);
  assert.equal(globalBad.error.code, "model_result_invalid");
  badGlobal.policy.dispose();

  // scoped 超界 ID：同样明确拒绝，不返回缺 accountSetId 的“完整”投影。
  const overScoped = contextExecutor([
    { id: 1_000_000_000_001, name: "synthetic", start_period: "2026-01" },
  ]);
  const scopedOver = await overScoped.callModelTool("account_context", { accountSetId: 1_000_000_000_001 });
  assert.equal(scopedOver.ok, false);
  assert.equal(scopedOver.error.code, "model_result_invalid");
  overScoped.policy.dispose();

  // 合法对照：scoped 期间正常投影，transport 可校验。
  const legalScoped = contextExecutor(
    [{ id: 2, name: X.enterpriseD, taxpayer_type: "一般纳税人", accounting_standard: "企业会计准则", start_period: "2026-12" }],
    [{ period: "2026-12", status: "open" }],
  );
  const scopedOk = await legalScoped.callModelTool("account_context", { accountSetId: 2 });
  assert.equal(scopedOk.ok, true, `合法 scoped 上下文不应被拒：${JSON.stringify(scopedOk.error || null)}`);
  assert.equal(scopedOk.scope, "account_set");
  assert.equal(scopedOk.accountSetId, 2);
  assert.equal(scopedOk.projection.startPeriod, "2026-12");
  assert.equal(scopedOk.projection.periodCount, 1);
  assert.equal(scopedOk.projectionDropped, 0);
  assert.equal(TRANSPORT.validateModelEnvelope(scopedOk, TRANSPORT_REGISTRY).ok, true);
  legalScoped.policy.dispose();
});

await test("review5 F3: 现金流 reconciles 是必需布尔，缺失 / 类型错明确失败，真实 false 仍保留", async () => {
  const cashFlow = await queryOk("finance_query", { accountSetId: setC.id, nodeId: "report.cash_flow_statement", period: "2026-01" });
  assert.equal(cashFlow.projection.reconciles, true);

  const mutate = (mutator) => createFinanceModelAdapter({
    executeRaw: async (name, args) => {
      const value = await callAgentTool(name, args);
      mutator(name, value);
      return value;
    },
  });

  // 完整合法零值 DTO 删掉 reconciles：必须失败，不能投影成 reconciles:false 并生成引用。
  const missing = mutate((name, value) => {
    if (name === "finance_query") delete value.data.reconciles;
  });
  const missingEnvelope = await missing.callModelTool("finance_query", {
    accountSetId: setC.id, nodeId: "report.cash_flow_statement", period: "2026-01",
  });
  assert.equal(missingEnvelope.ok, false);
  assert.equal(missingEnvelope.error.code, "model_result_invalid");
  assert.equal("localRef" in missingEnvelope, false, "未知勾稽状态不得建引用");
  assert.equal(JSON.stringify(missingEnvelope).includes("reconciles"), false);
  missing.policy.dispose();

  // 类型错（字符串 / 数字）同样失败。
  for (const forged of ["true", 1]) {
    const wrongType = mutate((name, value) => {
      if (name === "finance_query") value.data.reconciles = forged;
    });
    const wrongEnvelope = await wrongType.callModelTool("finance_query", {
      accountSetId: setC.id, nodeId: "report.cash_flow_statement", period: "2026-01",
    });
    assert.equal(wrongEnvelope.ok, false);
    assert.equal(wrongEnvelope.error.code, "model_result_invalid");
    wrongType.policy.dispose();
  }

  // 合法边界：真实的 false 是业务状态，必须原样保留并可通过 transport。
  const legitFalse = mutate((name, value) => {
    if (name === "finance_query") value.data.reconciles = false;
  });
  const falseEnvelope = await legitFalse.callModelTool("finance_query", {
    accountSetId: setC.id, nodeId: "report.cash_flow_statement", period: "2026-01",
  });
  assert.equal(falseEnvelope.ok, true);
  assert.equal(falseEnvelope.projection.reconciles, false);
  assert.equal(falseEnvelope.projectionDropped, 0);
  assert.equal(TRANSPORT.validateModelEnvelope(falseEnvelope, TRANSPORT_REGISTRY).ok, true);
  legitFalse.policy.dispose();
});

await test('银行只接受本机草稿；真实提交后投影/ref失败仍不重写', async()=>{
 assert.equal(AGENT_TOOL_NAMES.length,89);assert.equal(new Set(AGENT_TOOL_NAMES).size,89);
 const {prepareBankDraft}=await import('../server/agent-tools.mjs'),{db}=await import('../server/db.mjs');
 const target=identityFixtureCreate(A,{name:'Synthetic bank adapter',start_period:'2026-01'}).id;
 let calls=0;const isolated=createFinanceModelAdapter({executeRaw:async(name,args)=>{calls++;return callAgentTool(name,args);}});
 for(const args of [{accountSetId:target,draftRef:'bankdraft_'+'a'.repeat(48),approved:true},{accountSetId:target,draftRef:'bankdraft_'+'a'.repeat(48),reason:X.summary},{accountSetId:target,draftRef:'finref_'+'a'.repeat(48)}]){const r=await isolated.callModelTool('bank_accounts',args);assert.equal(r.ok,false);assertNoLeak(r,'bank invalid input');}assert.equal(calls,0);
 const registered=await prepareBankDraft(target,{tool:'bank_account_register',payload:{bankAccountId:'bank-adapter',sourceId:'source-adapter',glAccountCode:'1002',currency:'CNY'},confirm:true});await callAgentTool('bank_account_register',{accountSetId:target,draftRef:registered.draftRef});
 const payload={bankAccountId:'bank-adapter',period:'2026-01',asOf:'2026-01-31',coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:X.summary,statementOpenCents:0,statementCloseCents:0};
 for(const failure of ['summary','ref']){
  const prepared=await prepareBankDraft(target,{tool:'bank_reconcile',payload,confirm:true}),before=db.prepare('SELECT COUNT(*) n FROM bank_reconcile_runs WHERE account_set_id=?').get(target).n;
  let first=true;const tiny=failure==='ref'?new FinanceOutputPolicy({valueBytes:100}):new FinanceOutputPolicy();
  const a=createFinanceModelAdapter({policy:tiny,executeRaw:async(name,args)=>{const raw=await callAgentTool(name,args);assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_reconcile_runs WHERE account_set_id=?').get(target).n,before+1);if(failure==='summary'&&first)raw.result.book.closingCents=Number.MAX_SAFE_INTEGER;first=false;return raw;}});
  const args={accountSetId:target,draftRef:prepared.draftRef},done=await a.callModelTool('bank_reconcile',args);assert.equal(done.applied,true);assert.equal(done.needsLocalReview,true);assert.equal(done.localRef,null);assert.ok(done.refUnavailable);assertNoLeak(done,'bank committed summary/ref failed');
  const replay=await a.callModelTool('bank_reconcile',args);assert.equal(replay.applied,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_reconcile_runs WHERE account_set_id=?').get(target).n,before+1);a.policy.dispose();
 }
 isolated.policy.dispose();
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
} finally {
 ownedPolicy?.dispose();auditDb.close();console.log("model-adapter SQLite actualclose");
 if(!process.env.KEEP_FIXTURES)rmSync(dataDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}

console.log(`\nFinance model adapter acceptance: ${results.filter(Boolean).length}/${results.length} passed`);
if (results.some((passed) => !passed)) process.exitCode = 1;
