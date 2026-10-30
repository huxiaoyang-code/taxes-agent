#!/usr/bin/env node
// 固定的合成测试身份，不依赖显示名及生产默认值。
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-smoke-test-mjs-' + (++identityFixtureSequence) });

/**
 * 端到端测试：独立临时库 + 随机端口，不触碰 06-workbench/data/。
 * 覆盖：账套/科目、期初、凭证校验与过账、报表、P1（折旧摊销/结转损益/现金流量表）、Agent 工具。
 * 运行：npm test
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "wb-test-"));
// PORT=0：端口由子进程分配，必须从它的 stdout 读取实际端口，避免与现有真实后端碰撞后误连。
const child = spawn(process.execPath, [join(here, "..", "server", "server.mjs")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: "0", WORKBENCH_DATA_DIR: dataDir },
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

let BASE = "";
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

// 等待子进程自己打印实际监听端口；同时监听超时与提前退出，不盲目轮询固定端口。
function waitReady(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server_not_ready_timeout")), timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = /127\.0\.0\.1:(\d+)\//.exec(buf);
      if (m) { clearTimeout(timer); BASE = `http://127.0.0.1:${Number(m[1])}`; resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server_exited_before_ready code=${code}`)); });
  });
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
    const s = await api("POST", "/api/account-sets", { enterprise: identityFixture(),
      name: "测试贸易有限公司", taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    setId = s.id;
    const accs = await api("GET", `/api/account-sets/${setId}/accounts`);
    assert.ok(accs.length >= 55, `科目数应 >=55，实际 ${accs.length}`);
    assert.ok(accs.find((a) => a.code === "1002"));
  });

  await test("保存期初余额（借=贷）", async () => {
    // 真实业务事实：期初已投入固定资产 60000（原值已入固定资产账），
    // 因此 1601 期初 = 60000，实收资本 = 100000 + 60000 = 160000。
    await api("PUT", `/api/account-sets/${setId}/opening-balances`, { items: [
      { code: "1002", debit: 100000, credit: 0 },
      { code: "1601", debit: 60000, credit: 0 },
      { code: "3001", debit: 0, credit: 160000 },
    ] });
  });

  await test("凭证借贷不平被拒绝", async () => {
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
    // 手算：货币资金 98000 + 应收 11300 + 固定资产原值 60000（期初已入账） + 管理费用 2000 = 171300。
    assert.equal(tb.totals.closing_debit, 171300);
  });

  await test("资产负债表平衡（计提前）", async () => {
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

  // ---------------- P1: 固定资产折旧 ----------------
  let asset;
  await test("P1 资产卡片：新增固定资产（60000 / 5% / 60 期）", async () => {
    asset = await api("POST", `/api/account-sets/${setId}/assets`, {
      kind: "fixed", name: "办公设备", original_cost: 60000,
      residual_rate: 0.05, useful_life_months: 60, start_period: "2026-01",
      // LOCAL-02：显式登记取得 / 入账期间（不能用计提开始期间推测取得日）。
      acquired_period: "2026-01",
    });
    assert.equal(asset.monthly, 950);
    assert.equal(asset.depreciable, 57000);
    assert.equal(asset.remaining, 57000);
  });

  await test("P1 计提折旧：生成凭证并记录 run", async () => {
    const r = await api("POST", `/api/account-sets/${setId}/depreciation`, { period: "2026-01" });
    assert.ok(r.voucher, "应生成折旧凭证");
    assert.equal(r.voucher.total_debit, 950);
    assert.equal(r.runs.length, 1);
  });

  await test("P1 折旧不可重复计提（同期幂等）", async () => {
    const r = await api("POST", `/api/account-sets/${setId}/depreciation`, { period: "2026-01" });
    assert.equal(r.voucher, null);
  });

  await test("P1 计提后利润表含折旧费用（净利 7050）", async () => {
    const is = await api("GET", `/api/account-sets/${setId}/reports/income-statement?period=2026-01`);
    assert.equal(is.current["管理费用"], 2950);
    assert.equal(is.current["净利润"], 7050);
  });

  await test("P1 计提后资产负债表仍平衡", async () => {
    const bs = await api("GET", `/api/account-sets/${setId}/reports/balance-sheet?period=2026-01`);
    assert.equal(bs.balanced, true);
    // 手算：货币资金 98000 + 应收 11300 + 固定资产净值（60000 − 950）59050 = 168350；
    // 负债 = 应交税费 1300；权益 = 实收资本 160000（含期初投入固定资产 60000）+ 净利 7050 = 167050；1300 + 167050 = 168350。
    assert.equal(bs.totals.assets, 168350);
  });

  // ---------------- P1: 现金流量表 ----------------
  await test("P1 现金流量表：与货币资金变动勾稽", async () => {
    const cf = await api("GET", `/api/account-sets/${setId}/reports/cash-flow-statement?period=2026-01`);
    assert.equal(cf.reconciles, true);
    assert.equal(cf.totals.operating, -2000);
    assert.equal(cf.cash.begin, 100000);
    assert.equal(cf.cash.end, 98000);
    assert.equal(cf.cash.change, -2000);
    assert.equal(cf.supplement_indirect["净利润"], 7050);
    assert.equal(cf.supplement_indirect["加_折旧与摊销"], 950);
  });

  // ---------------- P1: 期末结转损益 ----------------
  await test("P1 结转损益：生成结转凭证并年度结转 3103→3104", async () => {
    const r = await api("POST", `/api/account-sets/${setId}/carry-forward`, { period: "2026-01", yearEnd: true });
    assert.ok(r.voucher, "应生成结转损益凭证");
    assert.equal(r.voucher.kind, "carryforward");
    assert.equal(r.profit, 7050);
    assert.ok(r.yearEndVoucher, "应生成结转本年利润凭证");
  });

  await test("P1 结转不重复：同期再次结转被拒绝", async () => {
    await assert.rejects(
      api("POST", `/api/account-sets/${setId}/carry-forward`, { period: "2026-01" }),
      /already_carried_forward/
    );
  });

  await test("P1 结转凭证不计入利润表（净利润仍 7050）", async () => {
    const is = await api("GET", `/api/account-sets/${setId}/reports/income-statement?period=2026-01`);
    assert.equal(is.current["营业收入"], 10000);
    assert.equal(is.current["净利润"], 7050);
  });

  await test("P1 结转后损益类科目余额归零，未分配利润 = 7050", async () => {
    const tb = await api("GET", `/api/account-sets/${setId}/reports/trial-balance?period=2026-01`);
    const pl = tb.lines.filter((l) => ["5001", "5602", "5403"].includes(l.code));
    for (const l of pl) assert.equal(l.closing_debit + l.closing_credit, 0, `${l.code} 应归零`);
    const bs = await api("GET", `/api/account-sets/${setId}/reports/balance-sheet?period=2026-01`);
    assert.equal(bs.balanced, true);
    const undistributed = bs.liabilities.find((l) => l.label === "未分配利润");
    assert.equal(undistributed.value, 7050);
  });

  // ---------------- 期间与 Agent ----------------
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
    assert.equal(r.data.current["净利润"], 7050);
  });

  await test("Agent 工具：finance_query 出现金流量表", async () => {
    const r = await api("POST", "/agent/tools/finance_query", {
      nodeId: "report.cash_flow_statement", accountSetId: setId, period: "2026-01",
    });
    assert.equal(r.data.reconciles, true);
  });

  await test("Agent 工具：未实现的发票返回 not_implemented", async () => {
    const r = await api("POST", "/agent/tools/invoice_issue", { accountSetId: setId });
    assert.equal(r.not_implemented, true);
  });

  // ---------------- 导入账套 ----------------
  const csv = {
    meta: "键,值\n账套名称,导入测试公司\n纳税人性质,一般纳税人\n会计准则,小企业会计准则\n启用期间,2026-01\n",
    accounts: "科目编码,科目名称,类别,方向\n5602,管理费用,损益,借\n",
    openings: "科目编码,借方,贷方\n1002,50000,0\n3001,0,50000\n",
    vouchers: "期间,日期,字号,凭证号,摘要,科目编码,借方,贷方\n"
      + "2026-01,2026-01-15,记,1,报销办公费,5602,300,0\n"
      + "2026-01,2026-01-15,记,1,报销办公费,1002,0,300\n",
  };

  await test("导入：CSV 预检通过并解析出结构", async () => {
    const r = await api("POST", "/api/import/parse", { enterprise: identityFixture(), texts: csv });
    assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors));
    assert.equal(r.validation.summary.account_set, "导入测试公司");
    assert.equal(r.validation.summary.vouchers, 1);
    assert.equal(r.validation.summary.entries, 2);
    assert.equal(r.payload.accounts[0].code, "5602");
  });

  await test("导入：期初借贷不平应预检失败", async () => {
    const bad = { ...csv, openings: "科目编码,借方,贷方\n1002,50000,0\n3001,0,40000\n" };
    const r = await api("POST", "/api/import/parse", { enterprise: identityFixture(), texts: bad });
    assert.equal(r.validation.ok, false);
    assert.ok(r.validation.errors.some((e) => e.includes("期初余额借贷不平")));
  });

  await test("导入：科目不存在应预检失败", async () => {
    const bad = { ...csv, vouchers: csv.vouchers.replace("5602,300,0", "9999,300,0") };
    const r = await api("POST", "/api/import/parse", { enterprise: identityFixture(), texts: bad });
    assert.equal(r.validation.ok, false);
    assert.ok(r.validation.errors.some((e) => e.includes("科目不存在")));
  });

  let importedSetId;
  await test("导入：正式导入并落库（含新增科目/期初/凭证）", async () => {
    const parsed = await api("POST", "/api/import/parse", { enterprise: identityFixture(), texts: csv });
    const r = await api("POST", "/api/import/account-set", { enterprise: identityFixture(), payload: parsed.payload, dryRun: false });
    importedSetId = r.created.id;
    assert.equal(r.created.name, "导入测试公司");
    assert.equal(r.created.vouchers, 1);
    assert.equal(r.created.opening_balances, 2);
    const accs = await api("GET", `/api/account-sets/${importedSetId}/accounts`);
    assert.ok(accs.find((a) => a.code === "5602"), "小企费用科目 5602 应存在");
  });

  await test("导入：导入后报表正确（平衡 / 净利 -300）", async () => {
    const bs = await api("GET", `/api/account-sets/${importedSetId}/reports/balance-sheet?period=2026-01`);
    assert.equal(bs.balanced, true);
    assert.equal(bs.totals.assets, 49700);
    const is = await api("GET", `/api/account-sets/${importedSetId}/reports/income-statement?period=2026-01`);
    assert.equal(is.current["净利润"], -300);
  });

  await test("导入：Agent 工具 legacy_book_import 默认仅预检", async () => {
    const r = await api("POST", "/agent/tools/legacy_book_import", { enterprise: identityFixture(), texts: csv });
    assert.equal(r.dryRun, true);
    assert.equal(r.validation.ok, true);
    assert.equal(r.created, null);
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  // 等子进程真正退出后再删临时目录，避免端口/文件残留或连到旧进程。
  await childExit;
  if (!process.exitCode) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  } else console.log(`Failed fixture retained: ${dataDir}`);
}
