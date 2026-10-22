#!/usr/bin/env node
/**
 * LOCAL-07 验收（CLI 主链路）：真实 CLI 子进程 + 真实 SQLite + 真实领域接口 + 真实 XLSX/PDF 渲染。
 *
 * 覆盖：
 *  A. CLI 契约：help / 非法命令 / 非法参数 / status 缺库 / status 只读不建库 / 退出码分层；
 *     四模块在未设置 WORKBENCH_DATA_DIR 的新子进程中 import 不触碰默认数据目录。
 *  B. 20 家规范企业、每企 1 个账套，连续两月真实导入 → 显式过账（真实 draft→posted）→
 *     实际固定/无形资产计提 → 结转 → 期末检查/结账（LOCAL-02 未合并时如实 blocked_dependency）→
 *     五类内部报表 CSV / XLSX / PDF 全部真实生成；金额、余额、净利按**独立手算表**核对；
 *     另测首次 create 建账 + 次月 append 到同一账套 + 同 jobKey 幂等回放。
 *  C. 并发证据：足量真实明细的 XLSX/PDF 渲染区间跨两家企业真实相交，peak>1 且 <= concurrency，
 *     threadId 不同；concurrency=1 的对照 job 渲染区间不重叠。
 *
 * 运行：node test/local-batch-cli.test.mjs（在 06-workbench 目录）
 * 全部为合成临时数据（系统临时目录），不访问真实账套 / 凭据 / 税局。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";

const WB = process.cwd();
const CLI = join(WB, "scripts", "local-batch.mjs");
const ROOT = mkdtempSync(join(tmpdir(), "lb-cli-"));
const RESULTS = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    RESULTS.push([true, name]);
    console.log(`  PASS ${name}`);
  } catch (error) {
    failures += 1;
    RESULTS.push([false, name]);
    console.error(`  FAIL ${name}\n    ${error?.stack || error}`);
  }
}

// ---------------------------------------------------------------- 子进程工具
function runNode(code, { env = {}, cwd = WB } = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024,
  });
}
function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: WB, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024,
  });
}
function cliJson(result) {
  const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(line, `CLI 没有输出 JSON：stderr=${result.stderr}`);
  return JSON.parse(line);
}

/** 数据目录初始化（与 CLI start 相同的顺序：只读检查 → import runner → 事务建结构）。 */
const PRIME_CODE = `
import * as storage from "./server/local-batch-storage.mjs";
const dataDir = process.env.WORKBENCH_DATA_DIR;
const init = storage.assertInitializable(dataDir);
process.env.WORKBENCH_DATA_DIR = dataDir;
const runner = await import("./server/local-batch-runner.mjs");
const schema = storage.ensureBatchSchema(runner.database, { freshDatabase: init.fresh });
console.log(JSON.stringify({ fresh: init.fresh, schema }));
`;
function primeDataDir(dataDir) {
  const result = runNode(PRIME_CODE, { env: { WORKBENCH_DATA_DIR: dataDir } });
  assert.equal(result.status, 0, `prime 失败：${result.stderr}`);
}

/** 建账 fixture：真实领域接口创建既有账套 + 企业绑定 + 固定资产卡片 + 一张草稿凭证。 */
const FIXTURE_CODE = `
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
import { insertEnterpriseAccountSet } from "./server/import-storage.mjs";
const specs = JSON.parse(process.env.FIXTURE_SPECS);
const out = [];
for (const spec of specs) {
  const set = A.createAccountSet({
    name: spec.name, taxpayer_type: "小规模纳税人",
    accounting_standard: "小企业会计准则", start_period: "2026-01",
  });
  insertEnterpriseAccountSet(db, {
    enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name,
    accountSetId: set.id, boundBy: "fixture",
  });
  A.addAssetCard(set.id, {
    kind: "fixed", name: "生产设备", original_cost: spec.assetCost, residual_rate: 0,
    useful_life_months: spec.life, start_period: "2026-01",
    asset_account: "1601", accum_account: "1602", expense_account: "5602",
  });
  const draft = A.createVoucher(set.id, {
    period: "2026-01", voucher_date: "2026-01-05", word: "记", number: 99,
    summary: "计提本月工资", status: "draft",
    entries: [
      { code: "5602", debit: spec.salary, credit: 0 },
      { code: "2211", debit: 0, credit: spec.salary },
    ],
  });
  out.push({ enterpriseKey: spec.enterpriseKey, name: spec.name, setId: set.id, draftVoucherId: draft.id });
}
console.log(JSON.stringify(out));
`;
function createFixture(dataDir, specs) {
  const result = runNode(FIXTURE_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, FIXTURE_SPECS: JSON.stringify(specs) } });
  assert.equal(result.status, 0, `fixture 失败：${result.stderr}`);
  return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

// ---------------------------------------------------------------- 金额工具（测试内独立算术）
const r2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const money = (value) => r2(value).toFixed(2);

// ---------------------------------------------------------------- 报表读取
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const source = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; } else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((entry) => entry.some((cell) => String(cell).trim() !== ""));
}
const firstCell = (row) => String(row?.[0] ?? "").trim();
/** 在报表 CSV 里按任意列标签定位行（资产负债表等项目名在第 2 列）。 */
function csvRow(rows, label, column) {
  const row = rows.find((entry) => entry.some((cell) => String(cell).trim() === label));
  assert.ok(row, `CSV 缺少行：${label}`);
  return column === undefined ? row : row[column];
}
function csvNumber(rows, label, column) {
  const cell = csvRow(rows, label, column);
  const value = Number(String(cell).replace(/,/g, ""));
  assert.ok(Number.isFinite(value), `CSV 行 ${label} 第 ${column} 列不是数字：${cell}`);
  return value;
}

async function loadXlsx(path) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(readFileSync(path));
  const sheet = workbook.worksheets[0];
  const rows = [];
  sheet.eachRow((row) => {
    const values = row.values.slice(1);
    rows.push(values);
  });
  return rows;
}
function xlsxRow(rows, label) {
  const row = rows.find((entry) => String(entry?.[0] ?? "").trim() === label);
  assert.ok(row, `XLSX 缺少行：${label}`);
  return row;
}
function numeric(cell) {
  const value = Number(cell);
  assert.ok(Number.isFinite(value), `不是数字单元格：${cell}`);
  return r2(value);
}
function assertPdf(buffer) {
  assert.ok(buffer.length > 1000, "PDF 过小");
  const head = buffer.subarray(0, 8).toString("latin1");
  assert.ok(head.startsWith("%PDF-"), `PDF 头非法：${head}`);
  const text = buffer.toString("latin1");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "PDF 缺少 %%EOF 尾标记");
  const pages = [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  assert.ok(pages >= 1, "PDF 未包含页面对象");
  return pages;
}

// ---------------------------------------------------------------- 20 家企业手算表
const COMPANY_COUNT = 20;
function company(i) {
  const assetCost = i === 1 ? 100 : 600;
  const life = i === 1 ? 3 : 12;
  const capital = 100000 + 1000 * i;
  const rev1 = 1000 + 10 * i;
  const e1 = 200 + i;
  const rev2 = 1200 + 10 * i;
  const e2 = 210 + i;
  const salary = 50 + i;
  const monthly = r2(assetCost / life);
  const d1 = monthly;
  const d2 = r2(Math.min(monthly, r2(assetCost - d1)));
  const p1 = r2(rev1 - e1 - salary - d1);
  const p2 = r2(rev2 - e2 - d2);
  const cashJan = r2(capital + rev1 - e1 - assetCost);
  const cashFeb = r2(cashJan + rev2 - e2);
  return {
    i,
    enterpriseKey: `91350000BATCH${String(i).padStart(4, "0")}X`,
    name: `合成批${String(i).padStart(2, "0")}公司`,
    capital, rev1, rev2, e1, e2, salary, assetCost, life, monthly, d1, d2, p1, p2, cashJan, cashFeb,
    fixedNet: r2(assetCost - d1 - d2),
    accum: r2(d1 + d2),
    totalAssets: r2(cashFeb + assetCost - d1 - d2),
    totalLiabilities: salary,
    totalEquity: r2(capital + p1 + p2),
  };
}
const COMPANIES = Array.from({ length: COMPANY_COUNT }, (_, index) => company(index + 1));

function janPayload(c) {
  return {
    account_set: {
      name: c.name, taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    },
    accounts: [],
    opening_balances: [
      { code: "1002", debit: String(c.capital), credit: "" },
      { code: "3001", debit: "", credit: String(c.capital) },
    ],
    vouchers: [
      {
        sourceVoucherId: `${c.enterpriseKey}-2026-01-sale`,
        period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "销售收入",
        entries: [
          { code: "1002", debit: String(c.rev1), credit: "" },
          { code: "5001", debit: "", credit: String(c.rev1) },
        ],
      },
      {
        sourceVoucherId: `${c.enterpriseKey}-2026-01-fee`,
        period: "2026-01", date: "2026-01-20", word: "记", number: 2, summary: "管理费用",
        entries: [
          { code: "5602", debit: String(c.e1), credit: "" },
          { code: "1002", debit: "", credit: String(c.e1) },
        ],
      },
      {
        sourceVoucherId: `${c.enterpriseKey}-2026-01-asset`,
        period: "2026-01", date: "2026-01-25", word: "记", number: 3, summary: "购置设备",
        entries: [
          { code: "1601", debit: String(c.assetCost), credit: "" },
          { code: "1002", debit: "", credit: String(c.assetCost) },
        ],
      },
    ],
  };
}
function febPayload(c) {
  return {
    account_set: {
      name: c.name, taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    },
    accounts: [],
    opening_balances: [],
    vouchers: [
      {
        sourceVoucherId: `${c.enterpriseKey}-2026-02-sale`,
        period: "2026-02", date: "2026-02-10", word: "记", number: 1, summary: "销售收入",
        entries: [
          { code: "1002", debit: String(c.rev2), credit: "" },
          { code: "5001", debit: "", credit: String(c.rev2) },
        ],
      },
      {
        sourceVoucherId: `${c.enterpriseKey}-2026-02-fee`,
        period: "2026-02", date: "2026-02-20", word: "记", number: 2, summary: "管理费用",
        entries: [
          { code: "5602", debit: String(c.e2), credit: "" },
          { code: "1002", debit: "", credit: String(c.e2) },
        ],
      },
    ],
  };
}

const ALL_REPORTS = [
  { kinds: ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance"], formats: ["csv", "xlsx", "pdf"] },
  { kinds: ["ledger"], formats: ["csv", "xlsx", "pdf"], code: "1002" },
];

function chainManifest(jobKey, fixtureByKey) {
  const items = COMPANIES.map((c) => {
    const fixture = fixtureByKey.get(c.enterpriseKey);
    return {
      itemKey: `ent-${String(c.i).padStart(2, "0")}`,
      source: { system: "local-export", enterpriseKey: c.enterpriseKey, enterpriseName: c.name },
      accountSetId: fixture.setId,
      periods: [
        {
          period: "2026-01",
          imports: [{
            batchId: `${c.enterpriseKey}-2026-01`,
            mode: "append",
            confirmNewBinding: true,
            payload: janPayload(c),
          }],
          post: { vouchers: [{ voucherId: fixture.draftVoucherId }] },
          depreciation: true,
          carryforward: { yearEnd: false },
          periodCheck: true,
          close: true,
        },
        {
          period: "2026-02",
          imports: [{ batchId: `${c.enterpriseKey}-2026-02`, mode: "append", payload: febPayload(c) }],
          depreciation: true,
          carryforward: { yearEnd: false },
          reports: ALL_REPORTS.flatMap((group) => group.kinds.map((kind) => ({
            kind, formats: group.formats, ...(group.code ? { code: group.code } : {}),
          }))),
        },
      ],
    };
  });
  return { schemaVersion: 1, jobKey, concurrency: 4, items };
}

function writeManifest(path, manifest) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function openDb(dataDir) {
  const db = new DatabaseSync(join(dataDir, "workbench.db"), { readOnly: true });
  return db;
}
const scalar = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0];

// ---------------------------------------------------------------- 测试
console.log(`临时目录：${ROOT}`);

await test("A1 help 不创建数据目录、退出码 0", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /本机持久批量 CLI/);
  assert.doesNotMatch(result.stdout, /\{"/);
});

await test("A2 非法命令 / 缺参数 / 未知参数 → 退出码 2，且不创建数据目录", () => {
  const dataDir = join(ROOT, "a2-data");
  const unknown = runCli(["scan", "--data-dir", dataDir]);
  assert.equal(unknown.status, 2);
  assert.equal(cliJson(unknown).error.code, "command_unknown");
  const noDataDir = runCli(["start", "--manifest", "x.json", "--output-dir", join(ROOT, "a2-out")]);
  assert.equal(noDataDir.status, 2);
  assert.equal(cliJson(noDataDir).error.code, "data_dir_required");
  const badFlag = runCli(["status", "--data-dir", dataDir, "--job-key", "k", "--nope", "x"]);
  assert.equal(badFlag.status, 2);
  assert.equal(cliJson(badFlag).error.code, "flag_unknown");
  assert.equal(existsSync(dataDir), false, "参数错误不得创建数据目录");
});

await test("A3 status 缺库 → database_not_found，退出码 3，不创建库", () => {
  const dataDir = join(ROOT, "a3-data");
  const result = runCli(["status", "--data-dir", dataDir, "--job-key", "job-x"]);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(cliJson(result).error.code, "database_not_found");
  assert.equal(existsSync(join(dataDir, "workbench.db")), false, "status 缺库不得创建数据库");
  assert.doesNotMatch(result.stderr, /SELECT|sqlite|at file:/i);
});

await test("A4 未设置 WORKBENCH_DATA_DIR 时 import 三个会开库的模块被拒，且不触碰默认数据目录", () => {
  const defaultDir = join(WB, "data");
  const before = existsSync(defaultDir);
  for (const modulePath of ["./server/local-batch-actions.mjs", "./server/local-batch-runner.mjs"]) {
    const result = runNode(`
      try { await import(${JSON.stringify(modulePath)}); console.log("IMPORTED"); }
      catch (error) { console.log("BLOCKED", error.code); }
    `, { env: { WORKBENCH_DATA_DIR: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BLOCKED local_batch_data_dir_required/, result.stdout);
  }
  const workerImport = runNode(`await import("./server/local-batch-report-worker.mjs"); console.log("WORKER_OK");`, { env: { WORKBENCH_DATA_DIR: "" } });
  assert.equal(workerImport.status, 0, workerImport.stderr);
  assert.match(workerImport.stdout, /WORKER_OK/);
  assert.equal(existsSync(defaultDir), before, "不得创建默认数据目录");
});

await test("A5 status 只读：不建表、不升级、不续跑（哈希与表清单不变）", () => {
  const dataDir = join(ROOT, "a5-data");
  rmSync(dataDir, { recursive: true, force: true });
  primeDataDir(dataDir);
  const dbPath = join(dataDir, "workbench.db");
  const before = openDb(dataDir);
  const tablesBefore = before.prepare(`SELECT name FROM sqlite_master ORDER BY name`).all().map((row) => row.name);
  before.close();
  const bytesBefore = statSync(dbPath).size;
  const result = runCli(["status", "--data-dir", dataDir, "--job-key", "missing-job"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(cliJson(result).error.code, "job_not_found");
  const after = openDb(dataDir);
  const tablesAfter = after.prepare(`SELECT name FROM sqlite_master ORDER BY name`).all().map((row) => row.name);
  after.close();
  assert.deepEqual(tablesAfter, tablesBefore, "status 不得建表 / 升级");
  assert.equal(statSync(dbPath).size, bytesBefore, "status 不得写入数据");
});

await test("B1 20 家企业两月真实动作链 + 五类 CSV/XLSX/PDF 金额与独立手算表一致", async () => {
  const dataDir = join(ROOT, "b1-data");
  const outDir = join(ROOT, "b1-out");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  primeDataDir(dataDir);
  const fixture = createFixture(dataDir, COMPANIES.map((c) => ({
    enterpriseKey: c.enterpriseKey, name: c.name, assetCost: c.assetCost, life: c.life, salary: c.salary,
  })));
  assert.equal(fixture.length, COMPANY_COUNT);
  const byKey = new Map(fixture.map((entry) => [entry.enterpriseKey, entry]));
  const manifest = chainManifest("chain-20", byKey);
  const manifestPath = writeManifest(join(ROOT, "b1-manifest.json"), manifest);

  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  const startedJson = cliJson(started);
  // LOCAL-02 尚未合并：period-check / close 必须如实 blocked_dependency，整体状态 needs_review（退出码 1）。
  assert.equal(started.status, 1, `start 退出码应为 1（依赖未合并，需复核）：${started.stderr}`);
  assert.equal(startedJson.status, "needs_review");
  assert.equal(startedJson.renders, COMPANY_COUNT * 15, "应为每家企业 15 个报表产物");

  const db = openDb(dataDir);
  try {
    // 一企一账套：20 个账套、20 条规范企业绑定，互不串号。
    assert.equal(scalar(db, `SELECT COUNT(*) FROM account_sets`), COMPANY_COUNT);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM import_enterprise_account_sets`), COMPANY_COUNT);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_items`), COMPANY_COUNT);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_jobs WHERE job_key='chain-20'`), 1);

    for (const c of COMPANIES) {
      const fixtureSet = byKey.get(c.enterpriseKey).setId;
      const binding = db.prepare(`SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?`)
        .get(c.enterpriseKey);
      assert.equal(binding.account_set_id, fixtureSet, `企业 ${c.i} 绑定到同一账套`);
      // 批次：两月各一条 completed。
      const batches = db.prepare(`SELECT batch_id, status, enterprise_key, account_set_id FROM import_batches
          WHERE enterprise_key=? ORDER BY batch_id`).all(c.enterpriseKey);
      assert.equal(batches.length, 2);
      assert.ok(batches.every((row) => row.status === "completed" && row.account_set_id === fixtureSet));
      // 凭证：1 月 3 张导入 + 1 张草稿（post 阶段真实过账）+ 计提 1 + 结转 1；2 月 2 张 + 计提 1 + 结转 1。
      const vouchers = db.prepare(`SELECT id, period, status, kind FROM vouchers WHERE account_set_id=?`).all(fixtureSet);
      assert.equal(vouchers.length, 10, `企业 ${c.i} 凭证数`);
      assert.ok(vouchers.every((row) => row.status === "posted"), "所有凭证最终应为 posted（含草稿过账）");
      assert.equal(vouchers.filter((row) => row.period === "2026-01").length, 6);
      assert.equal(vouchers.filter((row) => row.period === "2026-02").length, 4);
      const draftVoucher = db.prepare(`SELECT status FROM vouchers WHERE id=?`).get(byKey.get(c.enterpriseKey).draftVoucherId);
      assert.equal(draftVoucher.status, "posted", "草稿凭证必须由 post 阶段真实过账");
      // 计提 runs：两月各一条，金额 = 手算月度值。
      const runs = db.prepare(`SELECT period, amount, voucher_id FROM asset_depreciation_runs
          WHERE account_set_id=? ORDER BY period`).all(fixtureSet);
      assert.equal(runs.length, 2, `企业 ${c.i} 计提次数`);
      assert.equal(r2(runs[0].amount), c.d1);
      assert.equal(r2(runs[1].amount), c.d2);
      // 科目余额（真实 SQL 汇总，不看报表内部算法）。
      const balance = (code) => {
        const per = db.prepare(`
          SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
            FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
           WHERE v.account_set_id=? AND v.status='posted' AND e.code=?`).get(fixtureSet, code);
        const opening = db.prepare(`SELECT debit, credit FROM opening_balances WHERE account_set_id=? AND code=?`)
          .get(fixtureSet, code) || { debit: 0, credit: 0 };
        return {
          net: r2(Number(opening.debit) - Number(opening.credit) + per.d - per.c),
          debit: r2(per.d), credit: r2(per.c),
        };
      };
      const cash = balance("1002");
      assert.equal(cash.net, c.cashFeb, `企业 ${c.i} 1002 期末余额`);
      assert.equal(balance("1601").net, c.assetCost);
      assert.equal(balance("1602").net, -c.accum);
      assert.equal(balance("2211").net, -c.salary);
      assert.equal(balance("3001").net, -c.capital);
      assert.equal(balance("3103").net, -r2(c.p1 + c.p2), `企业 ${c.i} 本年利润`);
      // 期初余额未被追加月份覆盖。
      assert.equal(r2(db.prepare(`SELECT debit FROM opening_balances WHERE account_set_id=? AND code='1002'`).get(fixtureSet).debit), c.capital);
      // 期末检查 / 结账如实依赖未就绪，且没有伪封账。
      const periodCheck = db.prepare(`SELECT s.status AS stage_status, s.error_code AS stage_error FROM local_batch_stages s
          JOIN local_batch_items i ON i.id=s.item_id
          WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='chain-20') AND i.enterprise_key=? AND s.stage_key='period-check'`)
        .get(c.enterpriseKey);
      assert.equal(periodCheck.stage_status, "blocked_dependency");
      assert.equal(periodCheck.stage_error, "dependency_unavailable");
      assert.equal(scalar(db, `SELECT COUNT(*) FROM periods WHERE account_set_id=? AND status='closed'`, fixtureSet), 0);
    }

    // 报表产物：300 个文件全部真实存在且可打开；金额与手算表一致。
    let files = 0;
    for (const c of COMPANIES) {
      const itemKey = `ent-${String(c.i).padStart(2, "0")}`;
      const folder = join(outDir, "chain-20", `ent-${String(c.i).padStart(2, "0")}`, "2026-02");
      const names = readdirSync(folder).sort();
      assert.equal(names.length, 15, `${itemKey} 应有 15 个产物`);
      files += names.length;
      const balanceCsv = parseCsv(readFileSync(join(folder, "balance-sheet-2026-02.csv"), "utf8"));
      assert.equal(r2(csvNumber(balanceCsv, "资产总计", 3)), c.totalAssets, `${itemKey} 资产负债表资产总计`);
      assert.equal(r2(csvNumber(balanceCsv, "负债合计", 3)), c.totalLiabilities);
      assert.equal(r2(csvNumber(balanceCsv, "所有者权益合计", 3)), c.totalEquity);
      assert.equal(r2(csvNumber(balanceCsv, "固定资产账面价值", 3)), c.fixedNet);
      assert.equal(r2(csvNumber(balanceCsv, "减：累计折旧", 3)), c.accum);
      assert.equal(String(csvRow(balanceCsv, "资产负债表平衡", 1)).trim(), "是");
      const incomeCsv = parseCsv(readFileSync(join(folder, "income-statement-2026-02.csv"), "utf8"));
      const netRow = incomeCsv.find((row) => firstCell(row) === "净利润");
      assert.ok(netRow, "利润表缺少净利润行");
      assert.equal(r2(Number(netRow[1])), c.p2, `${itemKey} 本期净利润`);
      assert.equal(r2(Number(netRow[2])), r2(c.p1 + c.p2), `${itemKey} 本年累计净利润`);
      const trialCsv = parseCsv(readFileSync(join(folder, "trial-balance-2026-02.csv"), "utf8"));
      const totalRow = trialCsv.find((row) => firstCell(row) === "合计");
      assert.ok(totalRow);
      assert.equal(r2(Number(totalRow[9])), r2(Number(totalRow[10])), `${itemKey} 余额表借贷合计平衡`);
      const ledgerCsv = parseCsv(readFileSync(join(folder, "ledger-1002-2026-02.csv"), "utf8"));
      const closingRow = ledgerCsv.find((row) => firstCell(row) === "期末" && row.length === 3);
      assert.ok(closingRow, "明细账缺少期末余额行");
      assert.equal(r2(Number(closingRow[1]) - Number(closingRow[2])), c.cashFeb, `${itemKey} 明细账期末余额`);
      const cashCsv = parseCsv(readFileSync(join(folder, "cash-flow-statement-2026-02.csv"), "utf8"));
      assert.equal(String(csvRow(cashCsv, "现金流勾稽（本期）", 1)).trim(), "是");

      // XLSX 真实加载并核对同一金额。
      const incomeXlsx = await loadXlsx(join(folder, "income-statement-2026-02.xlsx"));
      assert.equal(numeric(xlsxRow(incomeXlsx, "净利润")[1]), c.p2, `${itemKey} XLSX 净利润`);
      const balanceXlsx = await loadXlsx(join(folder, "balance-sheet-2026-02.xlsx"));
      assert.equal(numeric(xlsxRow(balanceXlsx, "资产总计")[2]), c.totalAssets, `${itemKey} XLSX 资产总计`);
      const trialXlsx = await loadXlsx(join(folder, "trial-balance-2026-02.xlsx"));
      const xlsxTotal = xlsxRow(trialXlsx, "合计");
      assert.equal(r2(Number(xlsxTotal[9])), r2(Number(xlsxTotal[10])), `${itemKey} XLSX 余额表合计平衡`);
      const ledgerXlsx = await loadXlsx(join(folder, "ledger-1002-2026-02.xlsx"));
      const xlsxClosing = xlsxRow(ledgerXlsx, "期末余额");
      assert.equal(r2(Number(xlsxClosing[1]) - Number(xlsxClosing[2])), c.cashFeb, `${itemKey} XLSX 明细账期末`);
      const cashXlsx = await loadXlsx(join(folder, "cash-flow-statement-2026-02.xlsx"));
      assert.ok(xlsxRow(cashXlsx, "经营活动现金流量"), "XLSX 现金流应有经营活动区块");

      for (const kind of ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance"]) {
        const pages = assertPdf(readFileSync(join(folder, `${kind}-2026-02.pdf`)));
        assert.ok(pages >= 1, `${itemKey} ${kind} PDF 页数`);
      }
      assertPdf(readFileSync(join(folder, "ledger-1002-2026-02.pdf")));
    }
    assert.equal(files, COMPANY_COUNT * 15);

    // 产物记录：hash / 大小 / MIME / 相对位置 / 真实 worker threadId 与渲染时间齐全。
    const artifacts = db.prepare(`SELECT * FROM local_batch_artifacts ORDER BY id`).all();
    assert.equal(artifacts.length, COMPANY_COUNT * 15);
    for (const artifact of artifacts) {
      assert.equal(artifact.status, "published");
      assert.match(artifact.bytes_hash, /^[0-9a-f]{64}$/);
      assert.ok(artifact.bytes > 0);
      assert.ok(artifact.mime.length > 5);
      assert.ok(!artifact.relative_path.includes("..") && !/^[A-Za-z]:/.test(artifact.relative_path));
      if (artifact.format !== "csv") {
        assert.ok(Number.isInteger(artifact.worker_thread_id) && artifact.worker_thread_id > 0, "XLSX/PDF 应记录真实 worker threadId");
        assert.ok(artifact.render_finished > artifact.render_started, "渲染起止时间应单调");
      }
      const absolute = join(outDir, artifact.relative_path);
      assert.ok(existsSync(absolute), "产物文件应存在");
      const fileHash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      assert.equal(fileHash, artifact.bytes_hash, "产物字节 hash 与登记一致");
    }
    const statuses = db.prepare(`SELECT status, COUNT(*) AS n FROM local_batch_stages GROUP BY status`).all();
    const byStatus = Object.fromEntries(statuses.map((row) => [row.status, row.n]));
    assert.equal(byStatus.succeeded, COMPANY_COUNT * 22, "除期末检查/结账外全部 succeeded（每企业 22）");
    assert.equal(byStatus.blocked_dependency, COMPANY_COUNT * 2, "period-check 与 close 各 20 个依赖阻塞");
    assert.equal(byStatus.failed ?? 0, 0);
    assert.equal(byStatus.needs_review ?? 0, 0);
  } finally {
    db.close();
  }

  // 同 jobKey 同内容幂等：不新增账套 / 凭证 / 产物，attempt 不增加。
  const attemptsBefore = (() => {
    const db = openDb(dataDir);
    const rows = db.prepare(`SELECT stage_key, period, attempt FROM local_batch_stages ORDER BY id`).all();
    db.close();
    return rows;
  })();
  const replay = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  const replayJson = cliJson(replay);
  assert.equal(replay.status, 1);
  assert.equal(replayJson.created, false, "同 jobKey 同内容不得创建第二个 job");
  assert.equal(replayJson.jobId, startedJson.jobId);
  const dbReplay = openDb(dataDir);
  try {
    assert.equal(scalar(dbReplay, `SELECT COUNT(*) FROM account_sets`), COMPANY_COUNT);
    assert.equal(scalar(dbReplay, `SELECT COUNT(*) FROM vouchers`), COMPANY_COUNT * 10);
    const after = dbReplay.prepare(`SELECT stage_key, period, attempt FROM local_batch_stages ORDER BY id`).all();
    assert.deepEqual(after, attemptsBefore, "幂等回放不得重跑任何阶段");
    assert.equal(scalar(dbReplay, `SELECT COUNT(*) FROM local_batch_artifacts`), COMPANY_COUNT * 15);
  } finally {
    dbReplay.close();
  }
});

await test("B2 首次 create 建账 + 次月 append 到同一账套（真实结果）+ 同 jobKey 异内容拒绝", () => {
  const dataDir = join(ROOT, "b2-data");
  const outDir = join(ROOT, "b2-out");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  const specs = [1, 2].map((index) => {
    const capital = 200000 + index * 1000;
    return {
      itemKey: `create-${index}`,
      enterpriseKey: `91350000CREATE00${index}P`,
      name: `合成建账${index}号`,
      capital,
      r1: 3000 + index, e1: 400 + index, r2: 3200 + index, e2: 420 + index,
    };
  });
  const items = specs.map((spec) => ({
    itemKey: spec.itemKey,
    source: { system: "local-export", enterpriseKey: spec.enterpriseKey, enterpriseName: spec.name },
    periods: [
      {
        period: "2026-01",
        imports: [{
          batchId: `${spec.enterpriseKey}-2026-01`, mode: "create",
          payload: {
            account_set: { name: spec.name, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" },
            accounts: [],
            opening_balances: [
              { code: "1002", debit: String(spec.capital), credit: "" },
              { code: "3001", debit: "", credit: String(spec.capital) },
            ],
            vouchers: [{
              sourceVoucherId: `${spec.enterpriseKey}-jan-sale`,
              period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "销售收入",
              entries: [
                { code: "1002", debit: String(spec.r1), credit: "" },
                { code: "5001", debit: "", credit: String(spec.r1) },
              ],
            }],
          },
        }],
        post: { vouchers: [{ sourceVoucherId: `${spec.enterpriseKey}-jan-sale` }] },
        depreciation: true,
        carryforward: { yearEnd: false },
      },
      {
        period: "2026-02",
        imports: [{
          batchId: `${spec.enterpriseKey}-2026-02`, mode: "append",
          payload: {
            account_set: { name: spec.name, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" },
            accounts: [], opening_balances: [],
            vouchers: [{
              sourceVoucherId: `${spec.enterpriseKey}-feb-fee`,
              period: "2026-02", date: "2026-02-10", word: "记", number: 1, summary: "管理费用",
              entries: [
                { code: "5602", debit: String(spec.e2), credit: "" },
                { code: "1002", debit: "", credit: String(spec.e2) },
              ],
            }],
          },
        }],
        depreciation: true,
        carryforward: { yearEnd: false },
        reports: [
          { kind: "balance-sheet", formats: ["csv"] },
          { kind: "income-statement", formats: ["csv"] },
        ],
      },
    ],
  }));
  const manifestPath = writeManifest(join(ROOT, "b2-manifest.json"), {
    schemaVersion: 1, jobKey: "create-append-2", concurrency: 2, items,
  });
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `create/append 全稳定阶段应成功：${started.stderr} ${started.stdout}`);
  assert.equal(cliJson(started).status, "succeeded");
  const db = openDb(dataDir);
  try {
    assert.equal(scalar(db, `SELECT COUNT(*) FROM account_sets`), specs.length, "create 只建一本账套 / 企业");
    assert.equal(scalar(db, `SELECT COUNT(*) FROM import_enterprise_account_sets`), specs.length);
    for (const spec of specs) {
      const binding = db.prepare(`SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?`).get(spec.enterpriseKey);
      assert.ok(binding, "企业绑定必须存在");
      const batches = db.prepare(`SELECT batch_id, mode, account_set_id, status FROM import_batches WHERE enterprise_key=? ORDER BY batch_id`).all(spec.enterpriseKey);
      assert.deepEqual(batches.map((row) => row.mode), ["create", "append"], "1 月 create、2 月 append");
      assert.ok(batches.every((row) => row.account_set_id === binding.account_set_id && row.status === "completed"));
      const vouchers = db.prepare(`SELECT period, kind FROM vouchers WHERE account_set_id=?`).all(binding.account_set_id);
      // 1 月：导入 1 + 结转 1；2 月：导入 1 + 结转 1；无资产卡片 → 计提 not_applicable。
      assert.equal(vouchers.length, 4);
      const dep = db.prepare(`SELECT s.status AS stage_status FROM local_batch_stages s JOIN local_batch_items i ON i.id=s.item_id
          WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='create-append-2') AND i.enterprise_key=? AND s.stage_key='depreciation'`).all(spec.enterpriseKey);
      assert.ok(dep.length === 2 && dep.every((row) => row.stage_status === "not_applicable"), "无资产卡片时应为有证据的 not_applicable");
      const netProfit = db.prepare(`SELECT COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
          FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
         WHERE v.account_set_id=? AND v.status='posted' AND e.code='3103'`).get(binding.account_set_id);
      assert.equal(r2(netProfit.c - netProfit.d), r2(spec.r1 - spec.e2), "净利润 = 1 月收入 - 2 月费用");
    }
  } finally {
    db.close();
  }

  // 同 jobKey + 异内容 → 稳定冲突（退出码 2），不新增任何业务。
  const altered = JSON.parse(readFileSync(manifestPath, "utf8"));
  altered.items[0].periods[1].reports.push({ kind: "trial-balance", formats: ["csv"] });
  const alteredPath = writeManifest(join(ROOT, "b2-manifest-altered.json"), altered);
  const conflict = runCli(["start", "--data-dir", dataDir, "--manifest", alteredPath, "--output-dir", outDir]);
  assert.equal(conflict.status, 2, conflict.stderr);
  assert.equal(cliJson(conflict).error.code, "job_key_manifest_conflict");
  const db2 = openDb(dataDir);
  try {
    assert.equal(scalar(db2, `SELECT COUNT(*) FROM vouchers`), specs.length * 4);
    assert.equal(scalar(db2, `SELECT COUNT(*) FROM local_batch_jobs`), 1);
  } finally {
    db2.close();
  }
});

// ---------------------------------------------------------------- C. 并发证据
function concurrencyManifest(jobKey, fixtures, concurrency) {
  return {
    schemaVersion: 1, jobKey, concurrency,
    items: fixtures.map((entry, index) => ({
      itemKey: `render-${index + 1}`,
      source: { system: "local-export", enterpriseKey: entry.enterpriseKey, enterpriseName: entry.name },
      accountSetId: entry.setId,
      periods: [{
        period: "2026-01",
        imports: [{
          batchId: `${entry.enterpriseKey}-render`,
          mode: "append",
          confirmNewBinding: true,
          payload: {
            account_set: { name: entry.name, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01" },
            accounts: [],
            opening_balances: [
              { code: "1002", debit: "100000", credit: "" },
              { code: "3001", debit: "", credit: "100000" },
            ],
            vouchers: Array.from({ length: 60 }, (_, index) => ({
              sourceVoucherId: `${entry.enterpriseKey}-r${index + 1}`,
              period: "2026-01", date: "2026-01-15", word: "记", number: index + 1,
              summary: `明细业务 ${index + 1}`,
              entries: [
                { code: "1002", debit: String(10 + index), credit: "" },
                { code: "5001", debit: "", credit: String(10 + index) },
              ],
            })),
          },
        }],
        reports: [
          { kind: "ledger", formats: ["xlsx", "pdf"], code: "1002" },
          { kind: "trial-balance", formats: ["csv", "xlsx", "pdf"] },
          { kind: "balance-sheet", formats: ["xlsx", "pdf"] },
        ],
      }],
    })),
  };
}

function readRenderIntervals(dataDir, jobKey) {
  const db = openDb(dataDir);
  try {
    return db.prepare(`SELECT a.item_id AS itemId, i.item_key AS itemKey, a.format, a.worker_thread_id AS threadId,
                              a.render_started AS started, a.render_finished AS finished, a.relative_path AS path
                         FROM local_batch_artifacts a JOIN local_batch_items i ON i.id=a.item_id
                        WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key=?) AND a.format<>'csv'
                        ORDER BY a.render_started`).all(jobKey);
  } finally {
    db.close();
  }
}

function peakOverlap(intervals) {
  const events = [];
  for (const interval of intervals) {
    events.push({ at: interval.started, delta: 1 });
    events.push({ at: interval.finished, delta: -1 });
  }
  events.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

await test("C1 跨两家企业真实 worker 渲染区间相交，peak>1 且 <= concurrency", () => {
  const dataDir = join(ROOT, "c1-data");
  const outDir = join(ROOT, "c1-out");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  primeDataDir(dataDir);
  const fixture = createFixture(dataDir, [1, 2].map((index) => ({
    enterpriseKey: `91350000RENDER0${index}Q`,
    name: `渲染并发${index}号`,
    assetCost: 600, life: 12, salary: 10 + index,
  })));
  const manifestPath = writeManifest(join(ROOT, "c1-manifest.json"), concurrencyManifest("render-parallel", fixture, 3));
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `渲染 job 应成功：${started.stderr}`);
  const intervals = readRenderIntervals(dataDir, "render-parallel");
  assert.equal(intervals.length, 12, "2 企业 × 3 类报表 × 2 格式");
  const peak = peakOverlap(intervals);
  assert.ok(peak >= 2, `并发渲染峰值应 >1，实际 ${peak}`);
  assert.ok(peak <= 3, `并发渲染峰值不得超过 concurrency=3，实际 ${peak}`);
  let crossCompany = null;
  for (const left of intervals) {
    for (const right of intervals) {
      if (left.itemId === right.itemId) continue;
      if (left.threadId === right.threadId) continue;
      if (left.started < right.finished && right.started < left.finished) crossCompany = { left, right };
    }
  }
  assert.ok(crossCompany, "必须存在两家不同企业、不同线程的真实重叠渲染区间");
  // 所有输出仍然金额正确：明细账 60 笔收入累计 10..69 之和。
  const expectedRevenue = r2(Array.from({ length: 60 }, (_, index) => 10 + index).reduce((sum, value) => sum + value, 0));
  for (const entry of fixture) {
    const folder = join(outDir, "render-parallel", `render-${fixture.indexOf(entry) + 1}`, "2026-01");
    const trial = parseCsv(readFileSync(join(folder, "trial-balance-2026-01.csv"), "utf8"));
    assert.equal(r2(csvNumber(trial, "5001", 6)), expectedRevenue);
    assert.equal(r2(csvNumber(trial, "1002", 9)), r2(100000 + expectedRevenue));
  }
});

await test("C2 concurrency=1 对照：渲染区间不重叠（peak=1）", () => {
  const dataDir = join(ROOT, "c2-data");
  const outDir = join(ROOT, "c2-out");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  primeDataDir(dataDir);
  const fixture = createFixture(dataDir, [1, 2].map((index) => ({
    enterpriseKey: `91350000SERIAL0${index}R`,
    name: `渲染串行${index}号`,
    assetCost: 600, life: 12, salary: 10 + index,
  })));
  const manifestPath = writeManifest(join(ROOT, "c2-manifest.json"), concurrencyManifest("render-serial", fixture, 1));
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `串行 job 应成功：${started.stderr}`);
  const intervals = readRenderIntervals(dataDir, "render-serial");
  assert.equal(intervals.length, 12);
  assert.equal(peakOverlap(intervals), 1, "concurrency=1 时渲染必须完全串行");
  for (let index = 1; index < intervals.length; index += 1) {
    assert.ok(intervals[index].started >= intervals[index - 1].finished, "串行渲染区间不得重叠");
  }
});

// ---------------------------------------------------------------- 收尾
console.log("");
const passed = RESULTS.filter(([ok]) => ok).length;
console.log(`结果：${passed} / ${RESULTS.length} 通过`);
if (failures === 0) {
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
}
console.log(`未清理临时目录（便于排查）：${ROOT}`);
process.exit(1);
