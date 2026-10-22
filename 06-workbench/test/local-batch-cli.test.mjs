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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";

const WB = process.cwd();
const CLI = join(WB, "scripts", "local-batch.mjs");
const ROOT = mkdtempSync(join(tmpdir(), "lb-cli-"));
const RESULTS = [];
let failures = 0;
/** 只清理本次 mkdtemp 创建、位于系统临时根下且不是符号链接 / junction 的明确目录。 */
function cleanupRoot() {
  const root = resolve(ROOT);
  const base = resolve(tmpdir());
  if (root === base || !root.startsWith(base + sep)) throw new Error(`拒绝清理范围外目录：${root}`);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`拒绝清理非真实目录：${root}`);
  rmSync(root, { recursive: true, force: true });
}

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
const receipt = init.fresh ? storage.claimFreshDataDir(dataDir) : null;
process.env.WORKBENCH_DATA_DIR = dataDir;
try {
  const runner = await import("./server/local-batch-runner.mjs");
  const schema = storage.ensureBatchSchema(runner.database, { receipt });
  console.log(JSON.stringify({ fresh: init.fresh, schema }));
} finally {
  if (receipt) storage.releaseFreshClaim(receipt);
}
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
    useful_life_months: spec.life, start_period: "2026-01", acquired_period: "2026-01",
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

/** 通过真实领域入口在已由 CLI 建好的账套上补资产卡片（取得期间 / 起提期间 / 入账状态齐全）。 */
const CARD_CODE = `
import { db } from "./server/db.mjs";
import * as A from "./server/accounting.mjs";
const specs = JSON.parse(process.env.CARD_SPECS);
const out = [];
for (const spec of specs) {
  const binding = db.prepare("SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?").get(spec.enterpriseKey);
  if (!binding) throw new Error("binding_missing");
  const card = A.addAssetCard(binding.account_set_id, {
    kind: "fixed", name: "生产设备", original_cost: spec.assetCost, residual_rate: 0,
    useful_life_months: spec.life, start_period: "2026-01", acquired_period: "2026-01",
    ledger_status: "booked",
    asset_account: "1601", accum_account: "1602", expense_account: "5602",
  });
  out.push({ enterpriseKey: spec.enterpriseKey, setId: binding.account_set_id, cardId: card.id });
}
console.log(JSON.stringify(out));
`;
function addAssetCards(dataDir, specs) {
  const result = runNode(CARD_CODE, { env: { WORKBENCH_DATA_DIR: dataDir, CARD_SPECS: JSON.stringify(specs) } });
  assert.equal(result.status, 0, `资产卡片准备失败：${result.stderr}`);
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
/**
 * 独立手算预期（元）：至少公司 1 完全采用任务单给定样例：
 * 期初银行 10000 + 设备 1200 = 资本 11200；设备零残值 12 期、每期 100；
 * 月 1 收入 2000 / 费用 300 / 折旧 100；月 2 收入 1500 / 费用 250 / 折旧 100。
 * 其余公司使用不同金额 / 寿命，逐家独立核对，不串读同一账套。
 */
function company(i) {
  let bank0, assetCost, life, rev1, e1, rev2, e2;
  if (i === 1) {
    bank0 = 10000; assetCost = 1200; life = 12; rev1 = 2000; e1 = 300; rev2 = 1500; e2 = 250;
  } else {
    const variants = [[600, 6], [900, 12], [1200, 24], [1800, 6], [2400, 12]];
    [assetCost, life] = variants[(i - 2) % variants.length];
    bank0 = 7000 + i * 211;
    rev1 = 800 + i * 17;
    e1 = 150 + i * 3;
    rev2 = 600 + i * 11;
    e2 = 120 + i * 2;
  }
  const capital = r2(bank0 + assetCost);
  const monthly = r2(assetCost / life);
  const d1 = monthly;
  const d2 = monthly;
  const p1 = r2(rev1 - e1 - d1);
  const p2 = r2(rev2 - e2 - d2);
  const bank1 = r2(bank0 + rev1 - e1);
  const bank2 = r2(bank1 + rev2 - e2);
  const accum1 = d1;
  const accum2 = r2(d1 + d2);
  const fixedNet1 = r2(assetCost - accum1);
  const fixedNet2 = r2(assetCost - accum2);
  return {
    i,
    enterpriseKey: `91350000BATCH${String(i).padStart(4, "0")}X`,
    name: `合成批${String(i).padStart(2, "0")}公司`,
    bank0, capital, rev1, rev2, e1, e2, assetCost, life, monthly, d1, d2, p1, p2,
    bank1, bank2, accum1, accum2, fixedNet1, fixedNet2,
    totalAssets1: r2(bank1 + fixedNet1),
    totalAssets2: r2(bank2 + fixedNet2),
    totalEquity1: r2(capital + p1),
    totalEquity2: r2(capital + p1 + p2),
  };
}
const COMPANIES = Array.from({ length: COMPANY_COUNT }, (_, index) => company(index + 1));

function janPayload(c, { includeOpenings = true } = {}) {
  return {
    account_set: {
      name: c.name, taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    },
    accounts: [],
    opening_balances: includeOpenings ? [
      { code: "1002", debit: String(c.bank0), credit: "" },
      { code: "1601", debit: String(c.assetCost), credit: "" },
      { code: "3001", debit: "", credit: String(c.capital) },
    ] : [],
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

function provisionManifest(jobKey) {
  return {
    schemaVersion: 1, jobKey, concurrency: 1,
    items: COMPANIES.map((c) => ({
      itemKey: `ent-${String(c.i).padStart(2, "0")}`,
      source: { system: "local-export", enterpriseKey: c.enterpriseKey, enterpriseName: c.name },
      periods: [{
        period: "2026-01",
        imports: [{ batchId: `${c.enterpriseKey}-2026-01`, mode: "create", payload: janPayload(c) }],
      }],
    })),
  };
}

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
            batchId: `${c.enterpriseKey}-2026-01-run`,
            mode: "append",
            confirmNewBinding: true,
            payload: janPayload(c, { includeOpenings: false }),
          }],
          post: { vouchers: [
            { sourceVoucherId: `${c.enterpriseKey}-2026-01-sale` },
            { sourceVoucherId: `${c.enterpriseKey}-2026-01-fee` },
          ] },
          depreciation: true,
          carryforward: { yearEnd: false },
          periodCheck: true,
          close: true,
          reports: ALL_REPORTS.flatMap((group) => group.kinds.map((kind) => ({
            kind, formats: group.formats, ...(group.code ? { code: group.code } : {}),
          }))),
        },
        {
          period: "2026-02",
          imports: [{ batchId: `${c.enterpriseKey}-2026-02`, mode: "append", payload: febPayload(c) }],
          post: { vouchers: [
            { sourceVoucherId: `${c.enterpriseKey}-2026-02-sale` },
            { sourceVoucherId: `${c.enterpriseKey}-2026-02-fee` },
          ] },
          depreciation: true,
          carryforward: { yearEnd: false },
          periodCheck: true,
          close: true,
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

  // 1) 正式 CLI 在全新目标上建立批量结构（独占新建回执；不用预建 core 库 + fresh 布尔豁免）。
  const provisionPath = writeManifest(join(ROOT, "b1-provision.json"), provisionManifest("chain-20-provision"));
  const provision = runCli(["start", "--data-dir", dataDir, "--manifest", provisionPath, "--output-dir", outDir]);
  assert.equal(provision.status, 0, `新建目标 provision 失败：${provision.stderr} ${provision.stdout}`);
  const provisionJson = cliJson(provision);
  assert.equal(provisionJson.created, true);
  assert.equal(provisionJson.status, "succeeded");
  assert.equal(existsSync(join(dataDir, "workbench.db")), true);
  assert.equal(existsSync(join(dataDir, ".local-batch-create")), false, "结构建立后不得遗留所有权标记");

  // 2) 真实领域入口补资产卡片（取得期间 / 起提期间 / 入账状态与期初 1601 同步）。
  const cards = addAssetCards(dataDir, COMPANIES.map((c) => ({
    enterpriseKey: c.enterpriseKey, assetCost: c.assetCost, life: c.life,
  })));
  assert.equal(cards.length, COMPANY_COUNT);
  const byKey = new Map(cards.map((entry) => [entry.enterpriseKey, entry]));
  const manifest = chainManifest("chain-20", byKey);
  const manifestPath = writeManifest(join(ROOT, "b1-manifest.json"), manifest);

  // 3) 两月完整七阶段（每企每月 import→post→depreciation→carryforward→period-check→close→reports）。
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `20 企业两月链路应成功：${started.stderr} ${started.stdout}`);
  const startedJson = cliJson(started);
  assert.equal(startedJson.status, "succeeded");
  const expectedReportsPerCompany = 30;
  assert.equal(startedJson.renders, COMPANY_COUNT * expectedReportsPerCompany, "每企业每月 15 个报表产物");

  const db = openDb(dataDir);
  try {
    // 一企一账套：20 个账套、20 条规范企业绑定，互不串号。
    assert.equal(scalar(db, `SELECT COUNT(*) FROM account_sets`), COMPANY_COUNT);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM import_enterprise_account_sets`), COMPANY_COUNT);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_items WHERE job_id=(SELECT id FROM local_batch_jobs WHERE job_key='chain-20')`), COMPANY_COUNT);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_jobs WHERE job_key='chain-20'`), 1);
    assert.equal(scalar(db, `SELECT COUNT(*) FROM local_batch_jobs WHERE job_key='chain-20-provision'`), 1);

    for (const c of COMPANIES) {
      const fixtureSet = byKey.get(c.enterpriseKey).setId;
      const binding = db.prepare(`SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?`)
        .get(c.enterpriseKey);
      assert.equal(binding.account_set_id, fixtureSet, `企业 ${c.i} 绑定到同一账套`);
      // 批次：provision 首次 create、月 1 追加回放（跨批来源去重）、月 2 追加，均 completed。
      const batches = db.prepare(`SELECT batch_id, status, enterprise_key, account_set_id FROM import_batches
          WHERE enterprise_key=? ORDER BY batch_id`).all(c.enterpriseKey);
      assert.equal(batches.length, 3);
      assert.ok(batches.every((row) => row.status === "completed" && row.account_set_id === fixtureSet));
      // 凭证：每月导入 2 + 计提 1 + 结转 1 = 4；两月 8 张，全部 posted。
      const vouchers = db.prepare(`SELECT id, period, status, kind FROM vouchers WHERE account_set_id=?`).all(fixtureSet);
      assert.equal(vouchers.length, 8, `企业 ${c.i} 凭证数`);
      assert.ok(vouchers.every((row) => row.status === "posted"), "所有凭证最终应为 posted");
      assert.equal(vouchers.filter((row) => row.period === "2026-01").length, 4);
      assert.equal(vouchers.filter((row) => row.period === "2026-02").length, 4);
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
      assert.equal(balance("1002").net, c.bank2, `企业 ${c.i} 1002 期末余额`);
      assert.equal(balance("1601").net, c.assetCost);
      assert.equal(balance("1602").net, -c.accum2);
      assert.equal(balance("3001").net, -c.capital);
      assert.equal(balance("3103").net, -r2(c.p1 + c.p2), `企业 ${c.i} 本年利润`);
      // 期初余额未被追加月份覆盖。
      assert.equal(r2(db.prepare(`SELECT debit FROM opening_balances WHERE account_set_id=? AND code='1002'`).get(fixtureSet).debit), c.bank0);
      assert.equal(r2(db.prepare(`SELECT debit FROM opening_balances WHERE account_set_id=? AND code='1601'`).get(fixtureSet).debit), c.assetCost);
      // 期末检查 / 结账真实成功，期间确实 closed（不是 mock / 手工 SQL）。
      const checkStages = db.prepare(`SELECT s.period, s.stage_key, s.status, s.error_code, s.evidence_json FROM local_batch_stages s
          JOIN local_batch_items i ON i.id=s.item_id
          WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='chain-20')
            AND i.enterprise_key=? AND s.stage_key IN ('period-check','close') ORDER BY s.period, s.stage_key`)
        .all(c.enterpriseKey);
      assert.equal(checkStages.length, 4);
      assert.ok(checkStages.every((row) => row.status === "succeeded" && row.error_code === null), JSON.stringify(checkStages));
      assert.deepEqual(checkStages.map((row) => `${row.period}:${row.stage_key}`), [
        "2026-01:close", "2026-01:period-check", "2026-02:close", "2026-02:period-check",
      ]);
      const closedPeriods = db.prepare(`SELECT period, status FROM periods WHERE account_set_id=? ORDER BY period`).all(fixtureSet);
      assert.deepEqual(closedPeriods.map((row) => row.status), ["closed", "closed"], `企业 ${c.i} 两月均封账`);
    }

    // 阶段计划真实条数（不是固定七条）：每企每月 6 个动作阶段 + 15 个报表阶段。
    const stages = db.prepare(`SELECT s.status, s.stage_key FROM local_batch_stages s
        JOIN local_batch_items i ON i.id=s.item_id
       WHERE i.job_id=(SELECT id FROM local_batch_jobs WHERE job_key='chain-20')`).all();
    assert.equal(stages.length, COMPANY_COUNT * (2 * 6 + 2 * 15), "20 企业 × 两月 × (6 动作 + 15 报表)");
    assert.equal(stages.filter((row) => row.status === "succeeded").length, stages.length);
    assert.equal(stages.filter((row) => row.stage_key === "period-check").length, COMPANY_COUNT * 2);
    assert.equal(stages.filter((row) => row.stage_key === "close").length, COMPANY_COUNT * 2);
    assert.equal(stages.filter((row) => row.stage_key === "depreciation").length, COMPANY_COUNT * 2);
    assert.equal(stages.filter((row) => row.stage_key.startsWith("report:")).length, COMPANY_COUNT * 2 * 15);

    // 4) 独立手算表贯穿两月：CSV 金额 + XLSX 值 / 结构 + PDF 内容 / 页。
    let files = 0;
    for (const c of COMPANIES) {
      const itemKey = `ent-${String(c.i).padStart(2, "0")}`;
      for (const period of ["2026-01", "2026-02"]) {
        const jan = period === "2026-01";
        const expected = {
          bank: jan ? c.bank1 : c.bank2,
          accum: jan ? c.accum1 : c.accum2,
          fixedNet: jan ? c.fixedNet1 : c.fixedNet2,
          totalAssets: jan ? c.totalAssets1 : c.totalAssets2,
          totalEquity: jan ? c.totalEquity1 : c.totalEquity2,
          profit: jan ? c.p1 : c.p2,
          cumulative: jan ? c.p1 : r2(c.p1 + c.p2),
        };
        const folder = join(outDir, "chain-20", itemKey, period);
        const names = readdirSync(folder).sort();
        assert.equal(names.length, 15, `${itemKey} ${period} 应有 15 个产物`);
        files += names.length;
        const balanceCsv = parseCsv(readFileSync(join(folder, `balance-sheet-${period}.csv`), "utf8"));
        assert.equal(r2(csvNumber(balanceCsv, "资产总计", 3)), expected.totalAssets, `${itemKey} ${period} 资产总计`);
        assert.equal(r2(csvNumber(balanceCsv, "负债合计", 3)), 0, `${itemKey} ${period} 负债合计`);
        assert.equal(r2(csvNumber(balanceCsv, "所有者权益合计", 3)), expected.totalEquity, `${itemKey} ${period} 所有者权益`);
        assert.equal(r2(csvNumber(balanceCsv, "固定资产账面价值", 3)), expected.fixedNet, `${itemKey} ${period} 固定资产净值`);
        assert.equal(r2(csvNumber(balanceCsv, "减：累计折旧", 3)), expected.accum, `${itemKey} ${period} 累计折旧`);
        assert.equal(String(csvRow(balanceCsv, "资产负债表平衡", 1)).trim(), "是");
        const incomeCsv = parseCsv(readFileSync(join(folder, `income-statement-${period}.csv`), "utf8"));
        const netRow = incomeCsv.find((row) => firstCell(row) === "净利润");
        assert.ok(netRow, "利润表缺少净利润行");
        assert.equal(r2(Number(netRow[1])), expected.profit, `${itemKey} ${period} 本期净利润`);
        assert.equal(r2(Number(netRow[2])), expected.cumulative, `${itemKey} ${period} 本年累计净利润`);
        const trialCsv = parseCsv(readFileSync(join(folder, `trial-balance-${period}.csv`), "utf8"));
        const totalRow = trialCsv.find((row) => firstCell(row) === "合计");
        assert.ok(totalRow);
        assert.equal(r2(Number(totalRow[9])), r2(Number(totalRow[10])), `${itemKey} ${period} 余额表借贷合计平衡`);
        const ledgerCsv = parseCsv(readFileSync(join(folder, `ledger-1002-${period}.csv`), "utf8"));
        const closingRow = ledgerCsv.find((row) => firstCell(row) === "期末" && row.length === 3);
        assert.ok(closingRow, "明细账缺少期末余额行");
        assert.equal(r2(Number(closingRow[1]) - Number(closingRow[2])), expected.bank, `${itemKey} ${period} 明细账期末余额`);
        const cashCsv = parseCsv(readFileSync(join(folder, `cash-flow-statement-${period}.csv`), "utf8"));
        assert.equal(String(csvRow(cashCsv, "现金流勾稽（本期）", 1)).trim(), "是");
        for (const kind of ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance"]) {
          const pages = assertPdf(readFileSync(join(folder, `${kind}-${period}.pdf`)));
          assert.ok(pages >= 1, `${itemKey} ${period} ${kind} PDF 页数`);
        }
        assertPdf(readFileSync(join(folder, `ledger-1002-${period}.pdf`)));
      }
      // XLSX 真实加载并核对同一金额（两月都读工作簿值）。
      for (const period of ["2026-01", "2026-02"]) {
        const jan = period === "2026-01";
        const folder = join(outDir, "chain-20", itemKey, period);
        const incomeXlsx = await loadXlsx(join(folder, `income-statement-${period}.xlsx`));
        assert.equal(numeric(xlsxRow(incomeXlsx, "净利润")[1]), jan ? c.p1 : c.p2, `${itemKey} ${period} XLSX 净利润`);
        const balanceXlsx = await loadXlsx(join(folder, `balance-sheet-${period}.xlsx`));
        assert.equal(numeric(xlsxRow(balanceXlsx, "资产总计")[2]), jan ? c.totalAssets1 : c.totalAssets2, `${itemKey} ${period} XLSX 资产总计`);
        const trialXlsx = await loadXlsx(join(folder, `trial-balance-${period}.xlsx`));
        const xlsxTotal = xlsxRow(trialXlsx, "合计");
        assert.equal(r2(Number(xlsxTotal[9])), r2(Number(xlsxTotal[10])), `${itemKey} ${period} XLSX 余额表合计平衡`);
        const ledgerXlsx = await loadXlsx(join(folder, `ledger-1002-${period}.xlsx`));
        const xlsxClosing = xlsxRow(ledgerXlsx, "期末余额");
        assert.equal(r2(Number(xlsxClosing[1]) - Number(xlsxClosing[2])), jan ? c.bank1 : c.bank2, `${itemKey} ${period} XLSX 明细账期末`);
        const cashXlsx = await loadXlsx(join(folder, `cash-flow-statement-${period}.xlsx`));
        assert.ok(xlsxRow(cashXlsx, "经营活动现金流量"), "XLSX 现金流应有经营活动区块");
      }
    }
    assert.equal(files, COMPANY_COUNT * expectedReportsPerCompany);

    // 产物记录：hash / 大小 / MIME / 相对位置 / 真实 worker threadId 与渲染时间齐全。
    const artifacts = db.prepare(`SELECT * FROM local_batch_artifacts ORDER BY id`).all();
    assert.equal(artifacts.length, COMPANY_COUNT * expectedReportsPerCompany);
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
    const byStatus = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM local_batch_stages GROUP BY status`).all()
      .map((row) => [row.status, row.n]));
    assert.equal(byStatus.failed ?? 0, 0);
    assert.equal(byStatus.needs_review ?? 0, 0);
    assert.equal(byStatus.blocked_dependency ?? 0, 0);
  } finally {
    db.close();
  }

  // 5) 同 jobKey 同内容幂等：不新增账套 / 凭证 / runs / 产物，attempt 不增加；
  //    新进程 resume 也必须重新核验已成功证据（含 close 之后的早前 period-check）而不误判失效。
  const readAttempts = () => {
    const handle = openDb(dataDir);
    try { return handle.prepare(`SELECT stage_key, period, attempt FROM local_batch_stages ORDER BY id`).all(); }
    finally { handle.close(); }
  };
  const attemptsBefore = readAttempts();
  const replay = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(replay.status, 0, `${replay.stderr} ${replay.stdout}`);
  assert.equal(cliJson(replay).created, false, "同 jobKey 同内容不得创建第二个 job");
  assert.equal(cliJson(replay).jobId, startedJson.jobId);
  assert.deepEqual(readAttempts(), attemptsBefore, "幂等回放不得重跑任何阶段");

  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "chain-20"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  assert.equal(cliJson(resumed).status, "succeeded");
  assert.deepEqual(readAttempts(), attemptsBefore, "新进程 resume 不得重跑已成功阶段");
  const dbAfter = openDb(dataDir);
  try {
    assert.equal(scalar(dbAfter, `SELECT COUNT(*) FROM account_sets`), COMPANY_COUNT);
    assert.equal(scalar(dbAfter, `SELECT COUNT(*) FROM vouchers`), COMPANY_COUNT * 8);
    assert.equal(scalar(dbAfter, `SELECT COUNT(*) FROM asset_depreciation_runs`), COMPANY_COUNT * 2);
    assert.equal(scalar(dbAfter, `SELECT COUNT(*) FROM local_batch_artifacts`), COMPANY_COUNT * expectedReportsPerCompany);
    assert.equal(scalar(dbAfter, `SELECT COUNT(*) FROM periods WHERE status='closed'`), COMPANY_COUNT * 2);
  } finally {
    dbAfter.close();
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

await test("B3 年末结转跨年样例：本年利润→未分配利润、下一年期初 / 累计独立核对", async () => {
  const dataDir = join(ROOT, "b3-data");
  const outDir = join(ROOT, "b3-out");
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  const enterpriseKey = "91350000YEAR0001A";
  const name = "跨年样例公司";
  const decPayload = {
    account_set: { name, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-12" },
    accounts: [],
    opening_balances: [
      { code: "1002", debit: "50000", credit: "" },
      { code: "3001", debit: "", credit: "50000" },
    ],
    vouchers: [
      { sourceVoucherId: `${enterpriseKey}-dec-sale`, period: "2026-12", date: "2026-12-10", word: "记", number: 1, summary: "十二月收入", entries: [{ code: "1002", debit: "12000", credit: "" }, { code: "5001", debit: "", credit: "12000" }] },
      { sourceVoucherId: `${enterpriseKey}-dec-fee`, period: "2026-12", date: "2026-12-20", word: "记", number: 2, summary: "十二月费用", entries: [{ code: "5602", debit: "2000", credit: "" }, { code: "1002", debit: "", credit: "2000" }] },
    ],
  };
  const janPayload = {
    account_set: { name, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-12" },
    accounts: [], opening_balances: [],
    vouchers: [
      { sourceVoucherId: `${enterpriseKey}-jan27-sale`, period: "2027-01", date: "2027-01-10", word: "记", number: 1, summary: "一月收入", entries: [{ code: "1002", debit: "3000", credit: "" }, { code: "5001", debit: "", credit: "3000" }] },
      { sourceVoucherId: `${enterpriseKey}-jan27-fee`, period: "2027-01", date: "2027-01-20", word: "记", number: 2, summary: "一月费用", entries: [{ code: "5602", debit: "1000", credit: "" }, { code: "1002", debit: "", credit: "1000" }] },
    ],
  };
  const reports = [
    { kind: "balance-sheet", formats: ["csv"] },
    { kind: "income-statement", formats: ["csv"] },
  ];
  const manifestPath = writeManifest(join(ROOT, "b3-manifest.json"), {
    schemaVersion: 1, jobKey: "year-end-cross", concurrency: 1,
    items: [{
      itemKey: "year-end",
      source: { system: "local-export", enterpriseKey, enterpriseName: name },
      periods: [
        {
          period: "2026-12",
          imports: [{ batchId: `${enterpriseKey}-dec`, mode: "create", payload: decPayload }],
          post: { vouchers: [{ sourceVoucherId: `${enterpriseKey}-dec-sale` }, { sourceVoucherId: `${enterpriseKey}-dec-fee` }] },
          depreciation: true,
          carryforward: { yearEnd: true },
          periodCheck: true,
          close: true,
          reports,
        },
        {
          period: "2027-01",
          imports: [{ batchId: `${enterpriseKey}-jan27`, mode: "append", payload: janPayload }],
          post: { vouchers: [{ sourceVoucherId: `${enterpriseKey}-jan27-sale` }, { sourceVoucherId: `${enterpriseKey}-jan27-fee` }] },
          depreciation: true,
          carryforward: { yearEnd: false },
          periodCheck: true,
          close: true,
          reports,
        },
      ],
    }],
  });
  const started = runCli(["start", "--data-dir", dataDir, "--manifest", manifestPath, "--output-dir", outDir]);
  assert.equal(started.status, 0, `${started.stderr} ${started.stdout}`);
  assert.equal(cliJson(started).status, "succeeded");
  const db = openDb(dataDir);
  let setId;
  try {
    const binding = db.prepare(`SELECT account_set_id FROM import_enterprise_account_sets WHERE enterprise_key=?`).get(enterpriseKey);
    setId = binding.account_set_id;
    const balance = (code, throughPeriod = "2027-01") => {
      const per = db.prepare(`SELECT COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
          FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
         WHERE v.account_set_id=? AND v.status='posted' AND e.code=? AND v.period<=?`).get(setId, code, throughPeriod);
      const opening = db.prepare(`SELECT debit, credit FROM opening_balances WHERE account_set_id=? AND code=?`)
        .get(setId, code) || { debit: 0, credit: 0 };
      return r2(Number(opening.debit) - Number(opening.credit) + per.d - per.c);
    };
    assert.equal(balance("3103", "2026-12"), 0, "年末结转后本年利润应为 0");
    assert.equal(balance("3104", "2026-12"), -10000, "年末未分配利润 = 2026 年利润 10000");
    assert.equal(balance("1002"), r2(50000 + 12000 - 2000 + 3000 - 1000));
    // 2027-01 普通结转把当月利润转到 3103，未影响上年 3104。
    assert.equal(balance("3103"), -2000);
    assert.equal(balance("3104"), -10000);
    assert.equal(balance("1602"), 0);
    const rows = db.prepare(`SELECT period, stage_key, status FROM local_batch_stages WHERE stage_key IN ('period-check','close') ORDER BY period, stage_key`).all();
    assert.deepEqual(rows.map((row) => `${row.period}:${row.stage_key}:${row.status}`), [
      "2026-12:close:succeeded", "2026-12:period-check:succeeded",
      "2027-01:close:succeeded", "2027-01:period-check:succeeded",
    ]);
  } finally { db.close(); }

  const decBalance = parseCsv(readFileSync(join(outDir, "year-end-cross", "year-end", "2026-12", "balance-sheet-2026-12.csv"), "utf8"));
  assert.equal(r2(csvNumber(decBalance, "未分配利润", 3)), 10000, "2026 年末未分配利润");
  const decIncome = parseCsv(readFileSync(join(outDir, "year-end-cross", "year-end", "2026-12", "income-statement-2026-12.csv"), "utf8"));
  const decNet = decIncome.find((row) => firstCell(row) === "净利润");
  assert.equal(r2(Number(decNet[1])), 10000);
  assert.equal(r2(Number(decNet[2])), 10000);
  const janBalance = parseCsv(readFileSync(join(outDir, "year-end-cross", "year-end", "2027-01", "balance-sheet-2027-01.csv"), "utf8"));
  assert.equal(r2(csvNumber(janBalance, "未分配利润", 2)), 10000, "2027 年期初未分配利润 = 上年结转");
  assert.equal(r2(csvNumber(janBalance, "未分配利润", 3)), 12000, "2027-01 期末未分配利润 = 10000 + 2000");
  const janIncome = parseCsv(readFileSync(join(outDir, "year-end-cross", "year-end", "2027-01", "income-statement-2027-01.csv"), "utf8"));
  const janNet = janIncome.find((row) => firstCell(row) === "净利润");
  assert.equal(r2(Number(janNet[1])), 2000, "2027-01 本期净利润");
  assert.equal(r2(Number(janNet[2])), 2000, "2027 年累计净利润（按年重置）");

  // 新进程 resume：年末 / 跨年期间检查与后续封账不误报失效，不重跑。
  const attemptsBefore = (() => {
    const handle = openDb(dataDir);
    try { return handle.prepare(`SELECT stage_key, period, attempt FROM local_batch_stages ORDER BY id`).all(); }
    finally { handle.close(); }
  })();
  const resumed = runCli(["resume", "--data-dir", dataDir, "--job-key", "year-end-cross"]);
  assert.equal(resumed.status, 0, `${resumed.stderr} ${resumed.stdout}`);
  const db2 = openDb(dataDir);
  try {
    const after = db2.prepare(`SELECT stage_key, period, attempt FROM local_batch_stages ORDER BY id`).all();
    assert.deepEqual(after, attemptsBefore);
  } finally { db2.close(); }
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
  console.log(`    并发峰值=${peak}，跨企业重叠线程=${crossCompany.left.threadId}/${crossCompany.right.threadId}，区间重叠=${crossCompany.left.started < crossCompany.right.finished && crossCompany.right.started < crossCompany.left.finished}`);
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
  console.log(`    concurrency=1 峰值=${peakOverlap(intervals)}`);
  for (let index = 1; index < intervals.length; index += 1) {
    assert.ok(intervals[index].started >= intervals[index - 1].finished, "串行渲染区间不得重叠");
  }
});

// ---------------------------------------------------------------- 收尾
console.log("");
const passed = RESULTS.filter(([ok]) => ok).length;
console.log(`结果：${passed} / ${RESULTS.length} 通过`);
if (failures === 0) {
  cleanupRoot();
  process.exit(0);
}
console.log(`未清理临时目录（便于排查）：${ROOT}`);
process.exit(1);
