#!/usr/bin/env node
// 固定的合成测试身份，不依赖显示名及生产默认值。
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-report-export-http-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
// 仅使用合成账套。全新数据库及子进程分配端口隔离每次运行。
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "wb-report-http-"));
process.env.WORKBENCH_DATA_DIR = directory;
const { db } = await import("../server/db.mjs");
const A = await import("../server/accounting.mjs");
const set = identityFixtureCreate(A, { name: '合成中文公司";\r\nX-Fake: yes/\\', start_period: "2026-01" });
const empty = identityFixtureCreate(A, { name: "合成空账套", start_period: "2026-01" });
A.setOpeningBalances(set.id, [{ code: "1002", debit: 1000 }, { code: "3001", credit: 1000 }]);
A.createVoucher(set.id, { period: "2026-01", status: "posted", summary: "合成收入", entries: [
  { code: "1002", debit: 200 }, { code: "5001", credit: 200 },
] });
// LOCAL-02 封账前置：本期有损益发生，封账前必须先结转本期损益。
A.carryForwardProfit(set.id, "2026-01");
A.setPeriodStatus(set.id, "2026-01", "closed");
A.createVoucher(set.id, { period: "2026-02", status: "posted", summary: "二月合成收入", entries: [
  { code: "1002", debit: 50 }, { code: "5001", credit: 50 },
] });
const metadataSets = [
  ["小企业会计准则", "small-2011-basic-v1", "3001", "5001", "5602"],
  ["企业会计准则", "enterprise-2019-general-basic-v1", "4001", "6001", "6602"],
].map(([standard, profile, capital, revenue, expense]) => {
  const fixture = identityFixtureCreate(A, { name: `合成HTTP元数据-${standard}`, accounting_standard: standard, start_period: "2026-01" });
  A.setOpeningBalances(fixture.id, [{ code: "1002", debit: 1000 }, { code: capital, credit: 1000 }]);
  for (const [summary, entries] of [
    ["合成收入", [{ code: "1002", debit: 123.45 }, { code: revenue, credit: 123.45 }]],
    ["合成费用", [{ code: expense, debit: 23.45 }, { code: "1002", credit: 23.45 }]],
  ]) A.createVoucher(fixture.id, { period: "2026-01", status: "posted", summary, entries });
  return { id: fixture.id, profile };
});
const snapshot = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
  assert.match(name, /^[a-z_]+$/i);
  return [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()];
}));
const beforeReads = snapshot();
let child, exited, closed, exitObserved, closeObserved, spawnError, base;
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

before(async () => {
  child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "../server/server.mjs")], {
    env: { ...process.env, PORT: "0", WORKBENCH_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    exitObserved = { code, signal }; resolve(exitObserved);
  }));
  closed = new Promise((resolve) => child.once("close", (code, signal) => {
    closeObserved = { code, signal }; resolve(closeObserved);
  }));
  child.once("error", (error) => { spawnError = error; });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => finish(new Error(`Server startup timed out: ${stderr}`)), 10000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, +match[1]);
    });
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) {
      try {
        // spawn 失败会发出 error/close，而没有 exit；必须仍判断为失败。
        await bounded(spawnError ? closed : Promise.all([exited, closed]), 10000, "HTTP server exit/close");
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await bounded(closed, 5000, "HTTP server forced close");
        throw error;
      }
      if (spawnError) throw spawnError;
      assert.ok(exitObserved && closeObserved, "Server must emit both real exit and close");
      assert.deepEqual(closeObserved, exitObserved);
    }
    assert.deepEqual(snapshot(), beforeReads, "All successful/failed downloads must leave every database row unchanged");
  } finally {
    db.close();
    console.log(`Synthetic HTTP lifecycle: ${JSON.stringify({ exit: exitObserved ?? null, close: closeObserved ?? null, dbClosed: true })}`);
    console.log(`Synthetic HTTP fixture retained: ${directory}`);
  }
});

const path = (kind, query = "period=2026-01", id = set.id) => `/api/account-sets/${id}/reports/${kind}/export?${query}`;
const request = (url, options) => fetch(base + url, { signal: AbortSignal.timeout(10000), ...options });
async function expectError(url, code, status = 400, method = "GET") {
  const response = await request(url, { method });
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(response.headers.get("content-disposition"), null, "Errors must not start a file download");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.error, code);
  assert.equal(typeof body.message, "string");
  assert.ok(Object.hasOwn(body, "details"));
  return response;
}

// 用独立 RFC4180 读取器读取实际下载字节，不用生产 CSV/DTO 解析器。
function csvRows(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ",") { row.push(field); field = ""; }
    else if (!quoted && ch === "\r" && text[i + 1] === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; i++;
    } else field += ch;
  }
  assert.equal(quoted, false, "CSV quotes must close");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

for (const { id, profile } of metadataSets) {
  for (const [kind, title] of [
    ["balance-sheet", "资产负债表"], ["income-statement", "利润表"], ["cash-flow-statement", "现金流量表"],
    ["trial-balance", "科目余额表"], ["ledger", "明细账"],
  ]) test(`${profile}/${kind}: real CSV attachment has one CNY/yuan pair and independent amounts`, async () => {
    const response = await request(path(kind, `period=2026-01${kind === "ledger" ? "&code=1002" : ""}`, id));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv;\s*charset=utf-8$/i);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const disposition = response.headers.get("content-disposition");
    assert.match(disposition, /^attachment; filename="[^"\r\n]+\.csv"; filename\*=UTF-8''/);
    assert.match(decodeURIComponent(disposition.split("UTF-8''")[1]), /\.csv$/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
    assert.equal(+response.headers.get("content-length"), bytes.length);
    const csv = bytes.toString("utf8");
    assert.ok(csv.endsWith("\r\n"));
    assert.doesNotMatch(csv.replaceAll("\r\n", ""), /[\r\n]/);
    const rows = csvRows(csv);
    for (const expected of [["币种", "人民币(CNY)"], ["金额单位", "元"], ["报表", title], ["期间", "2026-01"], ["持久profile", profile]])
      assert.deepEqual(rows.filter(row => row[0] === expected[0]), [expected]);
    const row = (label, column = 0, length) => rows.find(item => item[column] === label && (length === undefined || item.length === length));
    // 两种配置均使用手算：期初 1000、收款 123.45、费用 23.45。
    if (kind === "balance-sheet") {
      assert.deepEqual(row("货币资金", 1), ["资产", "货币资金", "1000.00", "1100.00"]);
      assert.deepEqual(row("资产总计", 1), ["资产", "资产总计", "1000.00", "1100.00"]);
    } else if (kind === "income-statement") {
      for (const [label, amount] of [["营业收入", "123.45"], ["管理费用", "23.45"], ["净利润", "100.00"]])
        assert.deepEqual(row(label), [label, amount, amount]);
    } else if (kind === "cash-flow-statement") {
      for (const [label, amount] of [["经营活动净额", "100.00"], ["现金净增加额", "100.00"], ["现金期初余额", "1000.00"], ["现金期末余额", "1100.00"]])
        assert.deepEqual(row(label), [label, "", "", amount, amount]);
    } else if (kind === "trial-balance") {
      assert.deepEqual(row("1002"), ["1002", "银行存款", "debit", "1000.00", "0.00", "123.45", "23.45", "123.45", "23.45", "1100.00", "0.00"]);
    } else {
      for (const [label, debit, credit] of [["期间期初", "1000.00", "0.00"], ["本期发生", "123.45", "23.45"], ["本年累计", "123.45", "23.45"], ["期末", "1100.00", "0.00"]])
        assert.deepEqual(row(label, 0, 3), [label, debit, credit]);
      assert.deepEqual(rows.filter(item => item[5] === "1002").map(item => item.slice(7)), [
        ["合成收入", "123.45", "0.00", "1123.45"], ["合成费用", "0.00", "23.45", "1100.00"],
      ]);
    }
  });
}

for (const kind of ["trial-balance", "balance-sheet", "income-statement", "cash-flow-statement", "ledger"]) {
  test(`${kind}: closed-period CSV downloads with BOM, Chinese, safe headers`, async () => {
    const response = await request(path(kind, `period=2026-01${kind === "ledger" ? "&code=1002" : ""}`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv;\s*charset=utf-8$/i);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const disposition = response.headers.get("content-disposition");
    assert.match(disposition, /^attachment; filename="[^"\r\n]+"; filename\*=UTF-8''/);
    assert.ok([...disposition].every((char) => char.charCodeAt(0) < 128));
    assert.match(decodeURIComponent(disposition.split("UTF-8''")[1]), /\.csv$/);
    assert.equal(response.headers.get("x-fake"), null);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
    assert.equal(+response.headers.get("content-length"), bytes.length);
    assert.match(bytes.toString("utf8"), /合成中文公司/);
    assert.match(bytes.toString("utf8"), /2026-01/);
  });
}

test("empty account set exports an internal report without inventing activity", async () => {
  const response = await request(path("ledger", "period=2026-01&code=1002", empty.id));
  assert.equal(response.status, 200);
  const csv = Buffer.from(await response.arrayBuffer()).toString("utf8");
  assert.match(csv, /0\.00/);
  assert.doesNotMatch(csv, /合成收入/);
});

for (const [query, code] of [
  ["", "period_required"], ["period=2026-13", "period_invalid"], ["period=2026-1", "period_invalid"],
  ["period=2025-12", "period_before_start"], ["period=2026-03", "period_not_registered"],
  // 现在 xlsx 是受支持的附件格式，因此严格拒绝用例改用实际不支持的格式。
  ["period=2026-01&format=yaml", "report_format_unsupported"], ["period=2026-01&format=", "report_format_unsupported"],
]) test(`invalid request: ${code} (${query})`, () => expectError(path("trial-balance", query), code));

test("unknown report kind is a structured client error", () => expectError(path("unknown-kind"), "report_kind_unsupported"));
test("missing account set is 404", () => expectError(path("trial-balance", "period=2026-01", 999999), "account_set_not_found", 404));
test("ledger requires a selected account", () => expectError(path("ledger"), "account_code_required"));
test("unknown ledger account is 404", () => expectError(path("ledger", "period=2026-01&code=not-found"), "account_not_found", 404));
for (const method of ["POST", "PUT", "DELETE"]) {
  test(`${method} cannot export or mutate data`, async () => {
    const response = await expectError(path("trial-balance"), "method_not_allowed", 405, method);
    assert.equal(response.headers.get("allow"), "GET");
  });
}
test("HEAD is rejected with no download headers or body", async () => {
  const response = await request(path("trial-balance"), { method: "HEAD" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(response.headers.get("content-disposition"), null);
  assert.equal(await response.text(), "");
});

test("preview and CSV share monthly, YTD and closing balances without the old cumulative-period ambiguity", async () => {
  const query = "period=2026-02";
  const response = await request(path("trial-balance", query).replace("/export?", "/export-data?"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const report = await response.json();
  assert.equal(report.dataStatus.taxFilingReady, false);
  assert.equal(report.scope.status, "posted");
  const bank = report.data.lines.find((line) => line.code === "1002");
  // 独立数字：一月期初 1000 + 收款 200；二月收款 50。
  assert.equal(bank.opening_debit, 1200);
  assert.equal(bank.period_debit, 50);
  assert.equal(bank.ytd_debit, 250);
  assert.equal(bank.closing_debit, 1250);
  const csv = await (await request(path("trial-balance", query))).text();
  assert.match(csv, /"1002","银行存款","debit",1200\.00,0\.00,50\.00,0\.00,250\.00,0\.00,1250\.00,0\.00/);
});

test("ledger preview and CSV contain only selected-month entries and correct carry-in and totals", async () => {
  const query = "period=2026-02&code=1002";
  const response = await request(path("ledger", query).replace("/export?", "/export-data?"));
  const { data } = await response.json();
  assert.equal(data.opening.debit, 1200);
  assert.equal(data.current.debit, 50);
  assert.equal(data.ytd.debit, 250);
  assert.equal(data.closing.debit, 1250);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].summary, "二月合成收入");
  assert.equal(data.items[0].period, "2026-02");
  assert.equal(data.items[0].balance, 1250);
  const csv = await (await request(path("ledger", query))).text();
  assert.match(csv, /"期间期初",1200\.00,0\.00/);
  assert.match(csv, /"本期发生",50\.00,0\.00/);
  assert.match(csv, /"本年累计",250\.00,0\.00/);
  assert.match(csv, /"期末",1250\.00,0\.00/);
  assert.match(csv, /二月合成收入/);
});

test("preview endpoint validates period and HTTP method just like download", async () => {
  const preview = path("trial-balance", "period=2026-13").replace("/export?", "/export-data?");
  await expectError(preview, "period_invalid");
  await expectError(preview, "method_not_allowed", 405, "POST");
});

// 路由契约：/export-data 只返回 CSV 结构的 JSON DTO。Office 格式属于下载
// 路由，因此不支持的格式必须严格返回 400，不能静默改写为 CSV。
test("preview keeps the strict CSV DTO format contract and never becomes an attachment", async () => {
  const preview = (query) => path("trial-balance", query).replace("/export?", "/export-data?");
  for (const query of ["period=2026-01", "period=2026-01&format=csv"]) {
    const response = await request(preview(query));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).schemaVersion, 1);
  }
  for (const format of ["xlsx", "pdf", "yaml", ""])
    await expectError(preview(`period=2026-01&format=${format}`), "report_format_unsupported");
});

// 下载路由确实会生成实际格式的附件：XLSX 不应继续返回旧的 400。
test("download route serves the office format as a real XLSX attachment", async () => {
  const response = await request(path("trial-balance", "period=2026-01&format=xlsx"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/);
  const disposition = response.headers.get("content-disposition");
  assert.match(disposition, /^attachment; filename="[^"]+\.xlsx"; filename\*=UTF-8''/);
  assert.match(decodeURIComponent(disposition.split("UTF-8''")[1]), /\.xlsx$/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(+response.headers.get("content-length"), bytes.length);
  assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK");
  assert.deepEqual([...bytes.subarray(2, 4)], [3, 4]);
});

const taxQuery = "period=2026-01&region=CN-FJ&templateId=cn-small-enterprise-2011-balance-sheet&templateVersion=2011-17-original&format=csv";
const taxPath = (operation, id = set.id, extra = "") => `/api/account-sets/${id}/tax-reports/${operation}?${taxQuery}${extra}`;
test("tax template catalog publishes reference metadata without claiming an upload adapter", async () => {
  const response = await request("/api/tax-report-templates");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const templates = await response.json();
  assert.ok(Array.isArray(templates) && templates.length >= 3);
  assert.ok(templates.some((template) => template.id === "cn-small-enterprise-2011-balance-sheet"));
});
test("tax readiness rejects unverified templates and ignores caller verification flags", async () => {
  const response = await request(taxPath("readiness", set.id, "&verified=true&uploadCompatibility=verified&ready=true"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ready, false);
  assert.equal(data.uploadCompatibility, "unverified");
  assert.ok(data.blockers.some((blocker) => blocker.code === "tax_template_unverified"));
});
test("tax export fails with 422 JSON and no attachment even when verified is forged", async () => {
  await expectError(taxPath("export", set.id, "&verified=true&uploadCompatibility=verified&ready=true"), "tax_template_unverified", 422);
});
test("tax routes reject missing account sets before evaluating templates", async () => {
  for (const operation of ["readiness", "export"]) await expectError(taxPath(operation, 999999), "account_set_not_found", 404);
});
test("tax routes and metadata are read-only", async () => {
  for (const url of [taxPath("readiness"), taxPath("export"), "/api/tax-report-templates"]) {
    await expectError(url, "method_not_allowed", 405, "POST");
  }
});
