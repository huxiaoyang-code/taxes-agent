#!/usr/bin/env node
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
  const set = await ok("POST", "/api/account-sets", {
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
  assert.deepEqual(snapshot(), before, "封账被拒不得改动任何业务表");
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
  assert.deepEqual(snapshot(), before);
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
  assert.deepEqual(snapshot(), before, "拒绝的卡片维护不得写入任何内容");
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
  const set = await ok("POST", "/api/account-sets", { name: "F2 依赖公司", start_period: "2026-01" });
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
  assert.deepEqual(snapshot(), before, "拒绝的前期写入不得留下任何内容（含导入批次 / 来源绑定）");
  // 正确顺序：反过账后期结转 → 撤销前期 → 重新结转。
  await ok("POST", `/api/account-sets/${id}/vouchers/${carry.voucher.id}/unpost`);
  await ok("POST", `/api/account-sets/${id}/vouchers/${jan.id}/unpost`);
  assert.equal((await ok("POST", `/api/account-sets/${id}/carry-forward`, { period: "2026-02" })).profit, 20);
});

test("F3：前期零凭证但有应计提业务——HTTP 封账 409 + 撤销顺序，按期间完成 33.33/33.33/33.34", async () => {
  const set = await ok("POST", "/api/account-sets", { name: "F3 连续期间公司", start_period: "2026-01" });
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
  assert.deepEqual(snapshot(), before, "拒绝封账不得改变数据");
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
  const set = await ok("POST", "/api/account-sets", { name: "F4 待补凭证公司", start_period: "2026-01" });
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
  assert.deepEqual(snapshot(), before, "未入账卡片不得生成折旧 / 封账");
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
  assert.deepEqual(snapshot(), before, "被拒绝的导入不得留下任何业务写入");

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

test("期末检查对不存在 / 非法期间给出稳定错误码", async () => {
  await fails("GET", `/api/account-sets/${setId}/period-end-check`, undefined, 400, /period_required/);
  await fails("GET", `/api/account-sets/${setId}/period-end-check?period=2026-13`, undefined, 400, /period_invalid/);
  await fails("GET", `/api/account-sets/${setId}/period-end-check?period=2025-11`, undefined, 400, /period_before_start/);
  await fails("POST", "/agent/tools/period_end_check", { accountSetId: 999999, period: "2026-01" }, 404, /account_set_not_found/);
});
