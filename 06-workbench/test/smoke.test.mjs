#!/usr/bin/env node
/**
 * 端到端冒烟测试：独立临时库 + 随机端口，不触碰 06-workbench/data/。
 * 运行：npm test   （或 node test/smoke.test.mjs）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "wb-test-"));
const PORT = 8000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [join(here, "..", "server", "server.mjs")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT), WORKBENCH_DATA_DIR: dataDir },
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
};

async function waitReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await api("GET", "/api/meta"); return; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("server_not_ready");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};

try {
  await waitReady();
  console.log(`\n记账+报表 端到端测试 @ ${BASE}\n`);

  let setId, v1;

  await test("创建账套并载入标准科目", async () => {
    const s = await api("POST", "/api/account-sets", {
      name: "测试贸易有限公司", taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    setId = s.id;
    const accs = await api("GET", `/api/account-sets/${setId}/accounts`);
    assert.ok(accs.length >= 55, `科目数应 >=55，实际 ${accs.length}`);
    assert.ok(accs.find((a) => a.code === "1002"));
  });

  await test("保存期初余额（借=贷）", async () => {
    await api("PUT", `/api/account-sets/${setId}/opening-balances`, { items: [
      { code: "1002", debit: 100000, credit: 0 },
      { code: "3001", debit: 0, credit: 100000 },
    ] });
  });

  await test("凭证借贷不平应被拒绝", async () => {
    await assert.rejects(
      api("POST", `/api/account-sets/${setId}/vouchers`, {
        period: "2026-01", summary: "不平衡", status: "posted",
        entries: [{ code: "1001", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 90 }],
      }),
      /voucher_invalid/
    );
  });

  await test("创建并过账销售凭证", async () => {
    v1 = await api("POST", `/api/account-sets/${setId}/vouchers`, {
      period: "2026-01", voucher_date: "2026-01-10", summary: "销售商品", status: "posted",
      entries: [
        { code: "1122", debit: 11300, credit: 0 },
        { code: "5001", debit: 0, credit: 10000 },
        { code: "2221", debit: 0, credit: 1300 },
      ],
    });
    assert.equal(v1.status, "posted");
    assert.equal(v1.total_debit, v1.total_credit);
  });

  await test("创建费用凭证并过账", async () => {
    await api("POST", `/api/account-sets/${setId}/vouchers`, {
      period: "2026-01", voucher_date: "2026-01-20", summary: "支付管理费", status: "posted",
      entries: [
        { code: "5602", debit: 2000, credit: 0 },
        { code: "1002", debit: 0, credit: 2000 },
      ],
    });
  });

  await test("试算平衡：期末借 = 期末贷", async () => {
    const tb = await api("GET", `/api/account-sets/${setId}/reports/trial-balance?period=2026-01`);
    assert.equal(tb.totals.closing_debit, tb.totals.closing_credit);
    assert.equal(tb.totals.closing_debit, 111300);
  });

  await test("资产负债表平衡：资产 = 负债 + 权益", async () => {
    const bs = await api("GET", `/api/account-sets/${setId}/reports/balance-sheet?period=2026-01`);
    assert.equal(bs.balanced, true);
    assert.equal(bs.totals.assets, bs.totals.liabilities + bs.totals.equity);
  });

  await test("利润表：净利润 = 收入 − 费用", async () => {
    const is = await api("GET", `/api/account-sets/${setId}/reports/income-statement?period=2026-01`);
    assert.equal(is.current["营业收入"], 10000);
    assert.equal(is.current["管理费用"], 2000);
    assert.equal(is.current["净利润"], 8000);
  });

  await test("结账后禁止录入凭证", async () => {
    await api("POST", `/api/account-sets/${setId}/periods`, { period: "2026-01", status: "closed" });
    await assert.rejects(
      api("POST", `/api/account-sets/${setId}/vouchers`, {
        period: "2026-01", summary: "结账后", status: "draft",
        entries: [{ code: "1001", debit: 1, credit: 0 }, { code: "1002", debit: 0, credit: 1 }],
      }),
      /period_closed/
    );
  });

  await test("Agent 工具：finance_query 出利润表", async () => {
    const r = await api("POST", "/agent/tools/finance_query", {
      nodeId: "report.income_statement", accountSetId: setId, period: "2026-01",
    });
    assert.equal(r.data.current["净利润"], 8000);
  });

  await test("Agent 工具：未实现的发票返回 not_implemented", async () => {
    const r = await api("POST", "/agent/tools/invoice_issue", { accountSetId: setId });
    assert.equal(r.not_implemented, true);
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }, 300);
}
