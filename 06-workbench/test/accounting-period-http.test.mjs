#!/usr/bin/env node
// 固定的合成测试身份，不依赖显示名及生产默认值。
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-accounting-period-http-test-mjs-' + (++identityFixtureSequence) });

/**
 * LOCAL-02 期末完整性 HTTP / Agent 真实入口回归（合成临时库 + 随机回环端口，不连旧后端）。
 *
 * 串起一条完整的两月处理链（建账 → 期初 → 购入资产 → 计提 → 结转 → 期末检查 → 封账 → 次月），
 * 并覆盖关键负例：缺计提 / 缺结转阻止封账、封账后拒绝写入、更晚期间已封账阻止前期变动
 * （含真实 HTTP 增量导入入口）、资产补项与未入账登记、失败封账不改库。
 * 每个金额都用独立手算预期核对。
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "wb-period-http-"));
let child, exited, base, setId;

const api = async (method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
};
const ok = async (method, path, body) => {
  const r = await api(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const fails = async (method, path, body, status, codeRe) => {
  const r = await api(method, path, body);
  assert.equal(r.status, status, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  if (codeRe) assert.match(String(r.data.error ?? ""), codeRe);
  return r.data;
};
const snapshot = () => {
  const conn = new DatabaseSync(join(directory, "workbench.db"), { readOnly: true });
  try {
    return Object.fromEntries(
      conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .filter(({ name }) => !["schema_migrations", "schema_backups", "import_batches"].includes(name))
        .map(({ name }) => [
          name,
          conn.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((row) => JSON.stringify(row)),
        ]),
    );
  } finally { conn.close(); }
};


// 只有这些经过审计的动态操作可以追加终态审计行。
// 所有静态无效输入断言仍使用完整的原始 snapshot()。
function assertAuditAppend(after,before,actions,message,state='failure') {
 const row=v=>typeof v==='string'?JSON.parse(v):v;
 const business=value=>Object.fromEntries(Object.entries(value).filter(([name])=>!['audit_events','audit_operations'].includes(name)).map(([name,rows])=>[name,name==='sqlite_sequence'?rows.filter(v=>row(v).name!=='audit_events'):rows]));
 assert.deepEqual(business(after),business(before),message);
 for(const table of ['audit_events','audit_operations'])for(const original of before[table]??[])assert.ok((after[table]??[]).some(v=>JSON.stringify(v)===JSON.stringify(original)),table+' history must remain exact');
 const added=table=>(after[table]??[]).filter(v=>!(before[table]??[]).some(old=>JSON.stringify(old)===JSON.stringify(v))).map(row);
 const events=added('audit_events').sort((a,b)=>a.seq-b.seq),ops=added('audit_operations');
 assert.deepEqual(events.map(e=>e.action),actions);assert.equal(ops.length,actions.length);
 for(const event of events){
  const operation=ops.find(o=>o.operation_id===event.operation_id&&o.attempt===event.attempt&&o.database_instance_id===event.database_instance_id);assert.ok(operation);
  if(state==='failure')assert.ok(['failed','rejected'].includes(operation.state));else assert.equal(operation.state,state);
  assert.equal(event.outcome,operation.state);assert.equal(event.action,operation.action);assert.ok(operation.receipt_json);
  const receipt=JSON.parse(operation.receipt_json);
  assert.deepEqual(Object.keys(receipt).sort(),['receiptVersion','databaseInstanceId','operationId','attempt','state','resultCode','reasonCode','eventId','eventSeq','targets','resultRefs','resultDigest'].sort());
  assert.equal(receipt.receiptVersion,2);assert.equal(receipt.operationId,operation.operation_id);assert.equal(receipt.databaseInstanceId,operation.database_instance_id);assert.equal(receipt.attempt,operation.attempt);assert.equal(receipt.state,operation.state);assert.equal(receipt.eventId,event.event_id);assert.equal(receipt.eventSeq,event.seq);assert.equal(receipt.resultCode,event.result_code);assert.equal(receipt.reasonCode,event.reason_code);assert.match(receipt.resultDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.targets,{accountSetId:event.account_set_id,voucherId:event.voucher_id,period:event.period,jobId:event.job_id,itemId:event.item_id,stageId:event.stage_id,correlation:event.correlation});
 }
 const seq=value=>(value.sqlite_sequence??[]).map(row).find(r=>r.name==='audit_events')?.seq??0;
 assert.equal(seq(after)-seq(before),actions.length);
}

before(async () => {
  child = spawn(process.execPath, [join(here, "../server/server.mjs")], {
    env: { ...process.env, PORT: "0", WORKBENCH_DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  base = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`server startup timeout: ${stderr}`)), 15000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = /127\.0\.0\.1:(\d+)\//.exec(stdout);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
});

after(async () => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("建账 → 期初 → 购入资产（借 1601 / 贷 1002）→ 资产卡片", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(),
    name: "LOCAL-02 合成公司", taxpayer_type: "小规模纳税人",
    accounting_standard: "小企业会计准则", start_period: "2026-01",
  });
  setId = set.id;
  await ok("PUT", `/api/account-sets/${setId}/opening-balances`, {
    items: [{ code: "1002", debit: 100000, credit: 0 }, { code: "3001", debit: 0, credit: 100000 }],
  });
  const purchase = await ok("POST", `/api/account-sets/${setId}/vouchers`, {
    period: "2026-01", voucher_date: "2026-01-05", summary: "购入设备", status: "posted",
    entries: [{ code: "1601", debit: 60000, credit: 0 }, { code: "1002", debit: 0, credit: 60000 }],
  });
  assert.equal(purchase.status, "posted");
  const card = await ok("POST", `/api/account-sets/${setId}/assets`, {
    kind: "fixed", name: "合成设备", original_cost: 60000, residual_rate: 0.05,
    useful_life_months: 60, start_period: "2026-01", acquired_period: "2026-01",
  });
  assert.equal(card.depreciable, 57000);   // 手算：60000 × (1 − 5%) = 57000
  assert.equal(card.monthly, 950);         // 57000 ÷ 60 = 950
  assert.equal(card.acquired_period, "2026-01");
});

test("期末检查：缺计提明确阻止，无损益时结转标 not_applicable", async () => {
  const check = await ok("GET", `/api/account-sets/${setId}/period-end-check?period=2026-01`);
  assert.equal(check.ready, false);
  assert.equal(check.rules.rounding, "ROUND_HALF_UP");
  assert.equal(check.rules.moneyScale, 2);
  const dep = check.steps.find((s) => s.id === "depreciation");
  assert.equal(dep.status, "blocked");
  assert.equal(dep.blocking[0].code, "depreciation_missing");
  assert.equal(dep.blocking[0].details.dueAmount, 950);
  assert.equal(check.steps.find((s) => s.id === "asset_reconciliation").status, "ok");
  const profit = check.steps.find((s) => s.id === "profit_carry_forward");
  assert.equal(profit.status, "not_applicable");
  assert.match(profit.reason, /没有损益/);
  assert.equal(check.steps.find((s) => s.id === "year_end_carry_forward").status, "not_applicable");

  const before = snapshot();
  const err = await fails("POST", `/api/account-sets/${setId}/periods`, { period: "2026-01", status: "closed" }, 409,
    /period_end_check_failed/);
  assert.ok(err.details.blocking.some((b) => b.code === "depreciation_missing"));
  assertAuditAppend(snapshot(),before,["period.close"],"封账被拒不得改动任何业务表");
  const periods = await ok("GET", `/api/account-sets/${setId}/periods`);
  assert.equal(periods.find((p) => p.period === "2026-01").status, "open");
});

test("一月链：计提 950 → 收入 10000 → 缺结转阻止 → 结转 9050 → 封账", async () => {
  const dep = await ok("POST", `/api/account-sets/${setId}/depreciation`, { period: "2026-01" });
  assert.equal(dep.voucher.total_debit, 950);
  await ok("POST", `/api/account-sets/${setId}/vouchers`, {
    period: "2026-01", voucher_date: "2026-01-20", summary: "销售商品", status: "posted",
    entries: [
      { code: "1122", debit: 11300, credit: 0 },
      { code: "5001", debit: 0, credit: 10000 },
      { code: "2221", debit: 0, credit: 1300 },
    ],
  });
  const blocked = await fails("POST", `/api/account-sets/${setId}/periods`, { period: "2026-01", status: "closed" }, 409);
  assert.ok(blocked.details.blocking.some((b) => b.code === "profit_not_carried_forward"));

  const carry = await ok("POST", `/api/account-sets/${setId}/carry-forward`, { period: "2026-01" });
  assert.equal(carry.profit, 9050); // 手算：10000 − 950 = 9050
  const check = await ok("GET", `/api/account-sets/${setId}/period-end-check?period=2026-01`);
  assert.equal(check.ready, true, JSON.stringify(check.blocking));
  const closed = await ok("POST", `/api/account-sets/${setId}/periods`, { period: "2026-01", status: "closed" });
  assert.deepEqual(closed, { period: "2026-01", status: "closed" });

  // 封账后：新增凭证 / 重复计提都被拒绝，账簿不变。
  const before = snapshot();
  await fails("POST", `/api/account-sets/${setId}/vouchers`, {
    period: "2026-01", status: "draft",
    entries: [{ code: "1002", debit: 1, credit: 0 }, { code: "3001", debit: 0, credit: 1 }],
  }, 400, /period_closed/);
  await fails("POST", `/api/account-sets/${setId}/depreciation`, { period: "2026-01" }, 400, /period_closed/);
  assertAuditAppend(snapshot(),before,['voucher.create','asset.depreciate']);
});

test("二月链：计提 950 → 收入 20000 → 结转 19050 → 报表与封账（跨月累计手算）", async () => {
  const dep = await ok("POST", `/api/account-sets/${setId}/depreciation`, { period: "2026-02" });
  assert.equal(dep.voucher.total_debit, 950);
  await ok("POST", `/api/account-sets/${setId}/vouchers`, {
    period: "2026-02", voucher_date: "2026-02-18", summary: "销售商品", status: "posted",
    entries: [
      { code: "1122", debit: 22600, credit: 0 },
      { code: "5001", debit: 0, credit: 20000 },
      { code: "2221", debit: 0, credit: 2600 },
    ],
  });
  const carry = await ok("POST", `/api/account-sets/${setId}/carry-forward`, { period: "2026-02" });
  assert.equal(carry.profit, 19050); // 20000 − 950

  const income = await ok("GET", `/api/account-sets/${setId}/reports/income-statement?period=2026-02`);
  assert.equal(income.current["净利润"], 19050);
  assert.equal(income.ytd["净利润"], 28100); // 9050 + 19050

  // 手算资产负债表：资产 = 货币资金 40000 + 应收 33900 + 固定资产净值 58100 = 132000；
  // 负债 = 应交税费 3900；权益 = 实收资本 100000 + 未分配利润 28100 = 128100；合计 132000。
  const bs = await ok("GET", `/api/account-sets/${setId}/reports/balance-sheet?period=2026-02`);
  assert.equal(bs.totals.assets, 132000);
  assert.equal(bs.totals.liabilities, 3900);
  assert.equal(bs.totals.equity, 128100);
  assert.equal(bs.balanced, true);

  const check = await ok("GET", `/api/account-sets/${setId}/period-end-check?period=2026-02`);
  assert.equal(check.ready, true, JSON.stringify(check.blocking));
  assert.equal((await ok("POST", `/api/account-sets/${setId}/periods`, { period: "2026-02", status: "closed" })).status, "closed");
});

test("F1：已封账期间卡片事实维护经 HTTP / Agent 一致拒绝，纯显示信息可改", async () => {
  const cards = await ok("GET", `/api/account-sets/${setId}/assets`);
  const card = cards[0];
  const before = snapshot();
  for (const patch of [
    { original_cost: 61000 },
    { opening_accumulated: 100 },
    { acquired_period: "2025-12" },
    { start_period: "2026-03" },
    { ledger_status: "pending_purchase_voucher", ledger_note: "尝试改成待补凭证" },
    { asset_account: "1701" },
  ]) {
    const body = await fails("PATCH", `/api/account-sets/${setId}/assets/${card.id}`, patch, 409,
      /asset_card_affects_closed_period/);
    assert.deepEqual(body.details.closedPeriods, ["2026-01", "2026-02"]);
    assert.match(body.details.guidance, /倒序/);
  }
  await fails("DELETE", `/api/account-sets/${setId}/assets/${card.id}`, undefined, 409, /asset_card_affects_closed_period/);
  await fails("POST", `/api/account-sets/${setId}/assets`, {
    kind: "fixed", name: "封账后补录设备", original_cost: 100, residual_rate: 0,
    useful_life_months: 3, start_period: "2026-02", acquired_period: "2026-01",
  }, 409, /asset_card_affects_closed_period/);
  const agentDenied = await fails("POST", "/agent/tools/asset_update", {
    accountSetId: setId, assetId: card.id, patch: { original_cost: 61000 },
  }, 409, /asset_card_affects_closed_period/);
  assert.ok(Array.isArray(agentDenied.details.closedPeriods));
  assertAuditAppend(snapshot(),before,["asset.update", "asset.update", "asset.update", "asset.update", "asset.update", "asset.update", "asset.delete", "asset.create", "asset.update"],"拒绝的卡片维护不得写入任何内容");
  // 纯显示信息可正常维护。
  const renamed = await ok("PATCH", `/api/account-sets/${setId}/assets/${card.id}`, { name: "改名设备", ledger_note: "显示备注" });
  assert.equal(renamed.name, "改名设备");
  assert.equal(renamed.original_cost, 60000);
});

test("反结账顺序：更晚期间已封账时不能重开前期，按倒序后才可", async () => {
  const blocked = await fails("POST", `/api/account-sets/${setId}/periods`, { period: "2026-01", status: "open" }, 409,
    /later_period_closed/);
  assert.deepEqual(blocked.details.laterClosedPeriods, ["2026-02"]);
  assert.match(blocked.details.guidance, /2026-02/);
  await ok("POST", `/api/account-sets/${setId}/periods`, { period: "2026-02", status: "open" });
  assert.equal((await ok("POST", `/api/account-sets/${setId}/periods`, { period: "2026-01", status: "open" })).status, "open");
});

test("资产补项入口：未入账登记必须写原因；已过账后禁止改原值，但补项字段可维护", async () => {
  const cards = await ok("GET", `/api/account-sets/${setId}/assets`);
  const card = cards.find((c) => c.name === "改名设备") ?? cards[0];
  assert.equal(card.accumulated, 1900); // 950 × 2
  // 先清空显示备注：把卡片改为「未入账」必须在同一状态里有明确原因，不能沿用旧备注。
  await ok("PATCH", `/api/account-sets/${setId}/assets/${card.id}`, { ledger_note: "" });
  await fails("PATCH", `/api/account-sets/${setId}/assets/${card.id}`, { ledger_status: "pending_purchase_voucher" }, 400,
    /ledger_note_required/);
  const locked = await fails("PATCH", `/api/account-sets/${setId}/assets/${card.id}`, { original_cost: 61000 }, 409,
    /asset_card_locked_by_posted_runs/);
  assert.match(locked.details.guidance, /倒序/);
  const updated = await ok("PATCH", `/api/account-sets/${setId}/assets/${card.id}`, {
    ledger_note: "复核通过", acquired_period: "2025-12",
  });
  assert.equal(updated.ledger_note, "复核通过");
  assert.equal(updated.acquired_period, "2025-12");
  assert.equal(updated.original_cost, 60000);
});

test("Agent 工具：period_end_check 与 asset_update 走真实后端入口", async () => {
  const check = await ok("POST", "/agent/tools/period_end_check", { accountSetId: setId, period: "2026-01" });
  assert.equal(check.ready, true, JSON.stringify(check.blocking));
  assert.ok(check.steps.some((s) => s.id === "depreciation" && s.status === "ok"));
  // 上一个测试已反结账 2026-01：此时 2026-02 不应被允许封账（跨过有业务的更早期间）。
  const feb = await ok("POST", "/agent/tools/period_end_check", { accountSetId: setId, period: "2026-02" });
  assert.equal(feb.ready, false);
  assert.ok(feb.blocking.some((b) => b.code === "previous_period_open"), JSON.stringify(feb.blocking));
  const cards = await ok("POST", "/agent/tools/asset_list", { accountSetId: setId });
  const updated = await ok("POST", "/agent/tools/asset_update", {
    accountSetId: setId, assetId: cards[0].id, patch: { expense_account: "5602", ledger_note: "Agent 复核" },
  });
  assert.equal(updated.ledger_note, "Agent 复核");
  await fails("POST", "/agent/tools/period_end_check", { accountSetId: setId }, 400, /period_required/);
  await fails("POST", "/agent/tools/asset_update", { accountSetId: setId }, 400, /assetId_required/);
});

test("F2：后期普通损益结转依赖前期累计——HTTP / Agent 前期反过账 409，按倒序撤销后可重算", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: { enterpriseKey: "91350000F2HTTP0001X" }, name: "F2 依赖公司", start_period: "2026-01" });
  const id = set.id;
  await ok("PUT", `/api/account-sets/${id}/opening-balances`, { items: [
    { code: "1002", debit: 10000, credit: 0 }, { code: "3001", debit: 0, credit: 10000 },
  ] });
  const jan = await ok("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-01", status: "posted",
    entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "5001", debit: 0, credit: 100 }],
  });
  await ok("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-02", status: "posted",
    entries: [{ code: "1002", debit: 20, credit: 0 }, { code: "5001", debit: 0, credit: 20 }],
  });
  const carry = await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-02" });
  assert.equal(carry.profit, 120); // 手算：一月 100 + 二月 20
  const before = snapshot();
  const denied = await fails("POST", `/api/account-sets/${id}/vouchers/${jan.id}/unpost`, undefined, 409,
    /later_profit_carryforward_depends_on_period/);
  assert.deepEqual(denied.details.dependencies.map((d) => d.voucherId), [carry.voucher.id]);
  assert.match(denied.details.guidance, /反过账/);
  await fails("POST", "/agent/tools/voucher_unpost", { accountSetId: id, voucherId: jan.id }, 409,
    /later_profit_carryforward_depends_on_period/);
  await fails("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-01", status: "posted",
    entries: [{ code: "5602", debit: 3, credit: 0 }, { code: "1002", debit: 0, credit: 3 }],
  }, 409, /later_profit_carryforward_depends_on_period/);
  // 真实增量导入入口同样一致：前期追加写入口在事务内被同一守卫拒绝（409 + 依赖顺序，库不变）。
  const importDenied = await fails("POST", "/api/import/incremental", {
    batchId: "F2-IMP-2026-01", mode: "append", accountSetId: id, dryRun: false, confirmNewBinding: true,
    source: { system: "local-book", enterpriseKey: "91350000F2HTTP0001X", enterpriseName: "F2 依赖公司" },
    payload: {
      account_set: { name: "F2 依赖公司", start_period: "2026-01" },
      vouchers: [{
        period: "2026-01", date: "2026-01-20", word: "记", number: 9, summary: "补录费用",
        sourceVoucherId: "F2-IMP-V1",
        entries: [{ code: "5602", debit: 3, credit: 0 }, { code: "1002", debit: 0, credit: 3 }],
      }],
    },
  }, 409, /later_profit_carryforward_depends_on_period/);
  assert.match(importDenied.details.guidance, /反过账/);
  assertAuditAppend(snapshot(),before,["voucher.unpost", "voucher.unpost", "voucher.create_posted", "import.append"],"拒绝的前期写入不得留下任何内容（含导入批次 / 来源绑定）");
  // 正确顺序：反过账后期结转 → 撤销前期 → 重新结转。
  await ok("POST", `/api/account-sets/${id}/vouchers/${carry.voucher.id}/unpost`);
  await ok("POST", `/api/account-sets/${id}/vouchers/${jan.id}/unpost`);
  assert.equal((await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-02" })).profit, 20);
});

test("F3：前期零凭证但有应计提业务——HTTP 封账 409 + 撤销顺序，按期间完成 33.33/33.33/33.34", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "F3 连续期间公司", start_period: "2026-01" });
  const id = set.id;
  // 只有期初（无任何凭证）：期初投入资产 100。
  await ok("PUT", `/api/account-sets/${id}/opening-balances`, { items: [
    { code: "1601", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 },
  ] });
  await ok("POST", `/api/account-sets/${id}/assets`, {
    kind: "fixed", name: "期初投入设备", original_cost: 100, residual_rate: 0,
    useful_life_months: 3, start_period: "2026-01", acquired_period: "2026-01",
  });
  assert.equal((await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-02" })).voucher.total_debit, 33.33);
  const check = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-02`);
  const seq = check.steps.find((s) => s.id === "period_sequence");
  const pending = seq.blocking.find((b) => b.code === "previous_period_depreciation_pending");
  assert.ok(pending, JSON.stringify(seq.blocking));
  assert.deepEqual(pending.details.earlierDepreciationPending.map((x) => x.period), ["2026-01"]);
  const before = snapshot();
  const denied = await fails("POST", `/api/account-sets/${id}/periods`, { period: "2026-02", status: "closed" }, 409,
    /period_end_check_failed/);
  assert.ok(denied.details.blocking.some((b) => b.code === "previous_period_depreciation_pending"));
  assertAuditAppend(snapshot(),before,["period.close"],"拒绝封账不得改变数据");
  // 正确顺序：一月计提 33.33 → 结转 → 封账；二月结转 → 封账；三月 33.34 → 结转 → 封账。
  assert.equal((await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-01" })).voucher.total_debit, 33.33);
  await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-01" });
  await ok("POST", `/api/account-sets/${id}/periods`, { period: "2026-01", status: "closed" });
  await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-02" });
  await ok("POST", `/api/account-sets/${id}/periods`, { period: "2026-02", status: "closed" });
  assert.equal((await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-03" })).voucher.total_debit, 33.34);
  await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-03" });
  await ok("POST", `/api/account-sets/${id}/periods`, { period: "2026-03", status: "closed" });
  const cards = await ok("GET", `/api/account-sets/${id}/assets`);
  assert.equal(cards[0].accumulated, 100); // 手算：33.33 + 33.33 + 33.34
});

test("F4：未入账登记不是原值差异豁免——HTTP 计提 409、封账 409，补真实购入后才可继续", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "F4 待补凭证公司", start_period: "2026-01" });
  const id = set.id;
  await ok("PUT", `/api/account-sets/${id}/opening-balances`, { items: [
    { code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 },
  ] });
  const card = await ok("POST", `/api/account-sets/${id}/assets`, {
    kind: "fixed", name: "待补购入设备", original_cost: 600, residual_rate: 0,
    useful_life_months: 60, start_period: "2026-01", acquired_period: "2026-01",
    ledger_status: "pending_purchase_voucher", ledger_note: "购入凭证待补",
  });
  const check = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-01`);
  assert.ok(check.blocking.some((b) => b.code === "asset_cost_mismatch"), JSON.stringify(check.blocking));
  assert.ok(check.blocking.some((b) => b.code === "asset_purchase_voucher_pending"));
  const before = snapshot();
  await fails("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-01" }, 409, /asset_ledger_pending/);
  await fails("POST", "/agent/tools/depreciation_run", { accountSetId: id, period: "2026-01" }, 409, /asset_ledger_pending/);
  await fails("POST", `/api/account-sets/${id}/periods`, { period: "2026-01", status: "closed" }, 409, /period_end_check_failed/);
  assertAuditAppend(snapshot(),before,["asset.depreciate", "asset.depreciate", "period.close"],"未入账卡片不得生成折旧 / 封账");
  // 真实补录购入入账 → 改为 booked → 才能计提 10（600 ÷ 60）→ 结转 → 封账。
  await ok("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-01", status: "posted",
    entries: [{ code: "1601", debit: 600, credit: 0 }, { code: "1002", debit: 0, credit: 600 }],
  });
  await ok("PATCH", `/api/account-sets/${id}/assets/${card.id}`, { ledger_status: "booked" });
  assert.equal((await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-01" })).voucher.total_debit, 10);
  await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-01" });
  assert.equal((await ok("POST", `/api/account-sets/${id}/periods`, { period: "2026-01", status: "closed" })).status, "closed");
});

test("增量导入入口一致：更晚期间已封账时，向更早期追加返回 409 + 依赖处理顺序", async () => {
  const source = { system: "local-book", enterpriseKey: "91350000L02HTTP0001X", enterpriseName: "LOCAL-02 导入公司" };
  const meta = {
    name: "LOCAL-02 导入公司", taxpayer_type: "小规模纳税人",
    accounting_standard: "小企业会计准则", start_period: "2026-01",
  };
  const created = await ok("POST", "/api/import/incremental", {
    batchId: "L02-IMP-2026-02", source, dryRun: false,
    payload: {
      account_set: meta,
      vouchers: [{
        period: "2026-02", date: "2026-02-10", word: "记", number: 1, summary: "导入注资",
        sourceVoucherId: "L02-IMP-V1",
        entries: [{ code: "1002", debit: 500, credit: 0 }, { code: "3001", debit: 0, credit: 500 }],
      }],
    },
  });
  assert.equal(created.status, "applied");
  const importSetId = created.created.accountSetId;
  // 2026-02 无损益，可直接封账（开始期间 2026-01 无业务，不阻塞）。
  const closed = await ok("POST", `/api/account-sets/${importSetId}/periods`, { period: "2026-02", status: "closed" });
  assert.equal(closed.status, "closed");

  const before = snapshot();
  const err = await fails("POST", "/api/import/incremental", {
    batchId: "L02-IMP-2026-01", source, mode: "append", accountSetId: importSetId, dryRun: false,
    payload: {
      account_set: meta,
      vouchers: [{
        period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "补录一月",
        sourceVoucherId: "L02-IMP-V0",
        entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      }],
    },
  }, 409, /later_period_closed/);
  assert.deepEqual(err.details.laterClosedPeriods, ["2026-02"]);
  assert.match(err.details.guidance, /倒序/);
  assertAuditAppend(snapshot(),before,['import.append'],'被拒绝的导入不得留下任何业务写入');

  // 按正确顺序反结账后可正常追加。
  await ok("POST", `/api/account-sets/${importSetId}/periods`, { period: "2026-02", status: "open" });
  const appended = await ok("POST", "/api/import/incremental", {
    batchId: "L02-IMP-2026-01", source, mode: "append", accountSetId: importSetId, dryRun: false,
    payload: {
      account_set: meta,
      vouchers: [{
        period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "补录一月",
        sourceVoucherId: "L02-IMP-V0",
        entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      }],
    },
  });
  assert.equal(appended.status, "applied");
  assert.equal(appended.created.vouchersCreated, 1);
});

test("P1：旧折旧草稿（改寿命后）经 HTTP 不得重过账，检查不按“已过账”放行，撤销重算 20 后可封账", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "P1 旧草稿公司", start_period: "2026-01" });
  const id = set.id;
  await ok("PUT", `/api/account-sets/${id}/opening-balances`, { items: [
    { code: "1601", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 },
  ] });
  const card = await ok("POST", `/api/account-sets/${id}/assets`, {
    kind: "fixed", name: "旧草稿设备", original_cost: 100, residual_rate: 0,
    useful_life_months: 10, start_period: "2026-01", acquired_period: "2026-01",
  });
  assert.equal(card.monthly, 10); // 手算：100 ÷ 10
  const dep = await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-01" });
  assert.equal(dep.voucher.total_debit, 10);
  await ok("POST", `/api/account-sets/${id}/vouchers/${dep.voucher.id}/unpost`);
  assert.equal((await ok("PATCH", `/api/account-sets/${id}/assets/${card.id}`, { useful_life_months: 5 })).monthly, 20);

  const before = snapshot();
  const denied = await fails("POST", `/api/account-sets/${id}/vouchers/${dep.voucher.id}/post`, undefined, 409,
    /depreciation_run_stale/);
  assert.equal(denied.details.stale[0].period, "2026-01");
  assert.equal(denied.details.stale[0].recordedAmount, 10);
  assert.equal(denied.details.stale[0].expectedAmount, 20);
  assert.match(denied.details.guidance, /删除|重新计提/);
  assertAuditAppend(snapshot(),before,["voucher.post"],"拒绝重过账不得写入任何内容");
  // Agent 入口同样拒绝旧草稿重过账。
  await fails("POST", "/agent/tools/voucher_post", { accountSetId: id, voucherId: dep.voucher.id }, 409,
    /depreciation_run_stale/);
  // 期末检查 / 封账：旧草稿仍阻止，不能凭“有计提记录”放行。
  const blocked = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-01`);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blocking.some((b) => b.code === "depreciation_draft_exists"), JSON.stringify(blocked.blocking));
  // 封账仍被拒：既有草稿前置先报 period_has_draft_vouchers（400，保留旧错误码）。
  await fails("POST", `/api/account-sets/${id}/periods`, { period: "2026-01", status: "closed" }, 400,
    /period_has_draft_vouchers/);

  // 可行解除路径：删除旧草稿（连带旧 run）→ 按当前定义重新计提 20 → 结转 → 封账。
  await ok("DELETE", `/api/account-sets/${id}/vouchers/${dep.voucher.id}`);
  assert.equal((await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-01" })).voucher.total_debit, 20);
  await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-01" });
  const ready = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-01`);
  assert.equal(ready.ready, true, JSON.stringify(ready.blocking));
  assert.equal((await ok("POST", `/api/account-sets/${id}/periods`, { period: "2026-01", status: "closed" })).status, "closed");
  const cards = await ok("GET", `/api/account-sets/${id}/assets`);
  assert.equal(cards[0].accumulated, 20); // 手算：100 ÷ 5
});

test("P2：HTTP 凭证拒绝不足一分的非零数（全库不变），正常边界保留", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "P2 亚分公司", start_period: "2026-01" });
  const id = set.id;
  const before = snapshot();
  const body = await fails("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-01", status: "posted",
    entries: [
      { code: "1002", debit: 1, credit: 0.001 },
      { code: "1001", debit: 0.001, credit: 1 },
    ],
  }, 400, /voucher_invalid/);
  const messages = JSON.stringify(body.details);
  assert.match(messages, /不足一分/, messages);
  assert.deepEqual(snapshot(), before, "被拒绝的亚分凭证不得写入任何内容");
  // Agent 工具入口同样拒绝（voucher_check / voucher_create）。
  const agentCheck = await ok("POST", "/agent/tools/voucher_check", {
    accountSetId: id, entries: [{ code: "1002", debit: 1 }, { code: "1001", credit: 0.0049 }],
  });
  assert.equal(agentCheck.ok, false);
  assert.match(JSON.stringify(agentCheck.errors), /不足一分/);
  await fails("POST", "/agent/tools/voucher_create", {
    accountSetId: id, period: "2026-01",
    entries: [{ code: "1002", debit: 1 }, { code: "1001", credit: 0.001 }],
  }, 400, /voucher_invalid/);
  // 合法边界：0.005 四舍五入为 0.01。
  const okVoucher = await ok("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-01", status: "posted",
    entries: [{ code: "1002", debit: 0.005 }, { code: "1001", credit: 0.005 }],
  });
  assert.equal(okVoucher.total_debit, 0.01);
});

test("P3：未入账登记按取得期间计入（HTTP：1 月不阻塞 / 3、4 月阻塞），缺取得期间仍保守报告", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "P3 未入账期间公司", start_period: "2026-01" });
  const id = set.id;
  await ok("PUT", `/api/account-sets/${id}/opening-balances`, { items: [
    { code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 },
  ] });
  const card = await ok("POST", `/api/account-sets/${id}/assets`, {
    kind: "fixed", name: "三月待补购入设备", original_cost: 100, residual_rate: 0,
    useful_life_months: 10, start_period: "2026-04", acquired_period: "2026-03",
    ledger_status: "pending_purchase_voucher", ledger_note: "购入凭证待补",
  });
  assert.equal(card.ledger_status, "pending_purchase_voucher");
  const jan = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-01`);
  assert.equal(jan.ready, true, JSON.stringify(jan.blocking));
  assert.equal(jan.blocking.some((b) => b.code === "asset_purchase_voucher_pending"), false);
  const mar = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-03`);
  assert.ok(mar.blocking.some((b) => b.code === "asset_purchase_voucher_pending"), JSON.stringify(mar.blocking));
  const apr = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-04`);
  assert.ok(apr.blocking.some((b) => b.code === "asset_purchase_voucher_pending"));
  assert.ok(apr.blocking.some((b) => b.code === "asset_ledger_pending"));
  await fails("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-04" }, 409, /asset_ledger_pending/);
  // 真实补录购入 + 改回 booked 后 3 月不再阻塞。
  await ok("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-03", status: "posted",
    entries: [{ code: "1601", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 }],
  });
  await ok("PATCH", `/api/account-sets/${id}/assets/${card.id}`, { ledger_status: "booked" });
  const fixed = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-03`);
  assert.equal(fixed.blocking.some((b) => b.code === "asset_purchase_voucher_pending"), false, JSON.stringify(fixed.blocking));
  assert.equal(fixed.steps.find((s) => s.id === "asset_reconciliation").status, "ok");

  // 缺取得期间：仍保守报告，不因缺字段放宽真实未入账旁路。
  const set2 = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "P3 缺取得期间公司", start_period: "2026-01" });
  await ok("PUT", `/api/account-sets/${set2.id}/opening-balances`, { items: [
    { code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 },
  ] });
  await ok("POST", `/api/account-sets/${set2.id}/assets`, {
    kind: "fixed", name: "未登记取得的待补设备", original_cost: 100, residual_rate: 0,
    useful_life_months: 10, start_period: "2026-04",
    ledger_status: "pending_purchase_voucher", ledger_note: "购入凭证待补",
  });
  const missing = await ok("GET", `/api/account-sets/${set2.id}/period-end-check?period=2026-01`);
  assert.ok(missing.blocking.some((b) => b.code === "asset_purchase_voucher_pending"), JSON.stringify(missing.blocking));
  assert.ok(missing.blocking.some((b) => b.code === "asset_acquired_period_missing"));
});

test("P4：HTTP 资产写入口拒绝 2^32 / 2^32−1 / 非整数 / 超上限时不留半张卡片，1200 边界合法", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "P4 寿命边界公司", start_period: "2026-01" });
  const id = set.id;
  const before = snapshot();
  for (const bad of [4294967296, 4294967295, 1201, 0, -1, 1.5]) {
    await fails("POST", `/api/account-sets/${id}/assets`, {
      kind: "fixed", name: "寿命非法设备", original_cost: 100, residual_rate: 0,
      useful_life_months: bad, start_period: "2026-01", acquired_period: "2026-01",
    }, 400, /useful_life_months_(invalid|out_of_range)/);
  }
  assert.deepEqual(snapshot(), before, "非法寿命不得落库（不留半张卡片）");
  assert.equal((await ok("GET", `/api/account-sets/${id}/assets`)).length, 0);
  // Agent 入口：旧 pre-fix 行为会先落库再在 DTO 里抛错，现在写入前就拒绝。
  await fails("POST", "/agent/tools/asset_create", {
    accountSetId: id, name: "寿命非法设备", original_cost: 100, residual_rate: 0,
    useful_life_months: 4294967296, start_period: "2026-01", acquired_period: "2026-01",
  }, 400, /useful_life_months_out_of_range/);
  assert.equal((await ok("GET", `/api/account-sets/${id}/assets`)).length, 0);
  // 边界 1200 合法，列表 / 期末检查可正常读取（O(1) 分期）。
  const edge = await ok("POST", `/api/account-sets/${id}/assets`, {
    kind: "fixed", name: "边界寿命设备", original_cost: 1200, residual_rate: 0,
    useful_life_months: 1200, start_period: "2026-01", acquired_period: "2026-01",
  });
  assert.equal(edge.monthly, 1);
  await fails("PATCH", `/api/account-sets/${id}/assets/${edge.id}`, { useful_life_months: 4294967296 }, 400,
    /useful_life_months_out_of_range/);
  const unchanged = (await ok("GET", `/api/account-sets/${id}/assets`))[0];
  assert.equal(unchanged.useful_life_months, 1200);
  const check = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-01`);
  assert.equal(check.steps.find((s) => s.id === "depreciation").status, "blocked");
});

test("取得期间一致性（review3 P2）：HTTP 取得期间变更后历史期不再生成错误计提（无 stale 循环），正确适用期可计提并封账", async () => {
  const set = await ok("POST", "/api/account-sets", { enterprise: identityFixture(), name: "取得期间一致性公司", start_period: "2026-01" });
  const id = set.id;
  await ok("PUT", `/api/account-sets/${id}/opening-balances`, { items: [
    { code: "1002", debit: 1000, credit: 0 }, { code: "3001", debit: 0, credit: 1000 },
  ] });
  const purchase = await ok("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-01", status: "posted",
    entries: [{ code: "1601", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 }],
  });
  const card = await ok("POST", `/api/account-sets/${id}/assets`, {
    kind: "fixed", name: "取得期间设备", original_cost: 100, residual_rate: 0,
    useful_life_months: 10, start_period: "2026-01", acquired_period: "2026-01",
  });
  assert.equal(card.monthly, 10); // 手算：100 ÷ 10
  const dep = await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-01" });
  assert.equal(dep.voucher.total_debit, 10);
  await ok("POST", `/api/account-sets/${id}/vouchers/${dep.voucher.id}/unpost`);
  await ok("DELETE", `/api/account-sets/${id}/vouchers/${dep.voucher.id}`);
  await ok("PATCH", `/api/account-sets/${id}/assets/${card.id}`, { acquired_period: "2026-02" });

  // 旧实现：此处会再写一张一月计提 10，检查立即判 stale → 删了又生成，业务路径陷入循环。
  const before = snapshot();
  const rerun = await ok("POST", `/api/account-sets/${id}/depreciation`, { period: "2026-01" });
  assert.equal(rerun.voucher, null, "取得期间之前不生成计提凭证");
  assert.deepEqual(rerun.runs, []);
  assert.equal(rerun.skipped[0].status, "not_existed");
  assertAuditAppend(snapshot(),before,['asset.depreciate'],'不得写入任何凭证 / run','no_change');
  const janDep = (await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-01`))
    .steps.find((s) => s.id === "depreciation");
  assert.equal(janDep.status, "ok", JSON.stringify(janDep.blocking));
  assert.equal(janDep.details.cards[0].status, "not_existed");

  // 真实业务路径：把一月购入凭证也移到二月（一月总账不再有 1601）→ 一月可封账。
  await ok("POST", `/api/account-sets/${id}/vouchers/${purchase.id}/unpost`);
  await ok("DELETE", `/api/account-sets/${id}/vouchers/${purchase.id}`);
  await ok("POST", `/api/account-sets/${id}/vouchers`, {
    period: "2026-02", status: "posted",
    entries: [{ code: "1601", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 }],
  });
  const janReady = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-01`);
  assert.equal(janReady.ready, true, JSON.stringify(janReady.blocking));
  assert.equal((await ok("POST", `/api/account-sets/${id}/periods`, { period: "2026-01", status: "closed" })).status, "closed");

  // 正确适用期：Agent 入口在二月计提 10 → 改名称 / 备注不锁死 → 结转 → 封账。
  const feb = await ok("POST", "/agent/tools/depreciation_run", { accountSetId: id, period: "2026-02" });
  assert.equal(feb.voucher.total_debit, 10);
  await ok("PATCH", `/api/account-sets/${id}/assets/${card.id}`, { name: "改名后的设备", ledger_note: "只是备注" });
  const febDep = (await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-02`))
    .steps.find((s) => s.id === "depreciation");
  assert.equal(febDep.details.cards[0].status, "posted", "名称 / 备注变更不得让已过账计提变成 stale");
  await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-02" });
  const febCheck = await ok("GET", `/api/account-sets/${id}/period-end-check?period=2026-02`);
  assert.equal(febCheck.ready, true, JSON.stringify(febCheck.blocking));
  await ok("POST", `/api/account-sets/${id}/periods`, { period: "2026-02", status: "closed" });
  assert.equal((await ok("GET", `/api/account-sets/${id}/assets`))[0].accumulated, 10);
});

test("期末检查对不存在 / 非法期间给出稳定错误码", async () => {
  await fails("GET", `/api/account-sets/${setId}/period-end-check`, undefined, 400, /period_required/);
  await fails("GET", `/api/account-sets/${setId}/period-end-check?period=2026-13`, undefined, 400, /period_invalid/);
  await fails("GET", `/api/account-sets/${setId}/period-end-check?period=2025-11`, undefined, 400, /period_before_start/);
  await fails("POST", "/agent/tools/period_end_check", { accountSetId: 999999, period: "2026-01" }, 404, /account_set_not_found/);
});
