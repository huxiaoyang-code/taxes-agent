#!/usr/bin/env node
/**
 * local-backup.test.mjs — LOCAL-06 独立子包回归：运行中 SQLite 一致性快照 / 备份清单验证 / 恢复到全新目标。
 *
 * 覆盖（全部合成数据，不连接任何真实账套 / 税局 / 凭据）：
 *  - 模块导入无副作用：不打开默认库、不创建数据目录；
 *  - 遗留 WAL（子进程写完直接 exit，无活动连接）：只读快照仍然包含已提交业务，
 *    源主库与 `-wal` 字节不变、文件不被删除（备份不得 checkpoint 源库）；
 *  - 运行中快照：包含 WAL 中已提交（未 checkpoint）的数据、排除其它连接未提交的事务；
 *    源库内容不被修改、不被回滚，备份后仍可继续写业务；
 *  - 清单绑定：产品 / 格式 / 格式版本 / 应用版本（信息性）/ 结构版本与迁移记录 / 表清单 /
 *    每表行数与内容摘要 / 快照 sha256、页大小、journal mode；清单与回执不含本机绝对路径；
 *    清单字段类型 / 规范范围逐项校验，可重算字段与真实快照比对；
 *  - 真实结构（schema v3）：列 / 类型 / NOT NULL / 主键 / UNIQUE / 外键 / 迁移记录一致性；
 *    外键按外键分组比对 `ON DELETE` / `ON UPDATE` / `MATCH` 动作（不只比目标列），
 *    只改动作的伪结构在源库与快照两侧都被拒绝，且正常结构恢复后真实删除账套可级联成功；
 *    缺导入表、缺关键列、缺约束、迁移记录矛盾 / 空备份记录一律拒绝（源库与快照双向）；
 *  - 恢复只写全新目标：已有目标（含空目录 / 文件 / 未完成残留）默认拒绝且内容完全不动；
 *    先验证再发布，发布后用当前实际会计 / 导入接口读到相同的期初、两个月金额、来源与批次；
 *  - 拒绝：损坏 / 截断 / 篡改（清单与快照）/ 半成品 / 未知未来版本 / 非本产品库 / 非 SQLite 源库；
 *  - 路径与别名边界：源库硬链接 / junction 目录 / sidecar、目标在备份目录内（含父目录 junction
 *    别名绕过）、目标或备份目录为符号链接、目标指向正在使用的库文件、CLI 用法错误；
 *  - 中途中断与重试：真实子进程 kill 的原子边界（绝不留半套 workbench.db）+ 未完成残留的明确拒绝 + 重试成功；
 *  - 并发：同备份目录 / 同恢复目标的真实并发结果（恰好一个成功，另一个稳定拒绝，无半成品）；
 *  - 备份时点之后的业务不回滚，旧备份仍停留在原时点。
 *
 * 运行：node test/local-backup.test.mjs（在 06-workbench 目录）
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const WORKBENCH = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(WORKBENCH, "scripts", "local-backup.mjs");
const ROOT = fs.mkdtempSync(join(tmpdir(), "wb-l06-"));
const LIVE_DIR = join(ROOT, "live");
process.env.WORKBENCH_DATA_DIR = LIVE_DIR;

const { db } = await import("../server/db.mjs");
const A = await import("../server/accounting.mjs");
const IM = await import("../server/import-incremental.mjs");
const S = await import("../server/import-storage.mjs");
const LB = await import("../server/local-backup.mjs");

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n    ${error && error.message}`);
  }
};

// ------------------------------------------------------------------ 合成业务
const ENTERPRISE_KEY = "91350000LOCAL06X";
const SOURCE = { system: "local-book", enterpriseKey: ENTERPRISE_KEY, enterpriseName: "合成账套公司" };
const META = {
  name: "合成账套公司",
  taxpayer_type: "小规模纳税人",
  accounting_standard: "小企业会计准则",
  start_period: "2026-01",
};
const OPENINGS = [
  { code: "1002", debit: 100000, credit: 0 },
  { code: "1405", debit: 6000, credit: 0 },
  { code: "3001", debit: 0, credit: 106000 },
];
const JAN_VOUCHERS = [
  {
    period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "销售商品",
    entries: [
      { code: "1122", debit: 11300, credit: 0 },
      { code: "5001", debit: 0, credit: 10000 },
      { code: "2221", debit: 0, credit: 1300 },
    ],
    sourceVoucherId: "SRC-L06-0001",
  },
  {
    period: "2026-01", date: "2026-01-20", word: "记", number: 2, summary: "支付管理费用",
    entries: [
      { code: "5602", debit: 2000, credit: 0 },
      { code: "1002", debit: 0, credit: 2000 },
    ],
    sourceVoucherId: "SRC-L06-0002",
  },
];
const FEB_VOUCHERS = [
  {
    period: "2026-02", date: "2026-02-10", word: "记", number: 1, summary: "收到货款",
    entries: [
      { code: "1002", debit: 11300, credit: 0 },
      { code: "1122", debit: 0, credit: 11300 },
    ],
    sourceVoucherId: "SRC-L06-0003",
  },
  {
    period: "2026-02", date: "2026-02-15", word: "记", number: 2, summary: "采购商品",
    entries: [
      { code: "1405", debit: 3000, credit: 0 },
      { code: "1002", debit: 0, credit: 3000 },
    ],
    sourceVoucherId: "SRC-L06-0004",
  },
];

// 独立手算预期（不调用被测代码计算）：
//  期初 1002 100000 / 1405 6000 / 3001 106000
//  1 月：1122 +11300、5001 -10000、2221 -1300、5602 +2000、1002 -2000
//  2 月：1002 +11300 -3000、1122 -11300、1405 +3000
const CODES = ["1002", "1122", "1405", "5001", "5602", "2221", "3001"];
const EXPECTED_JAN_BALANCE = { "1002": 98000, "1122": 11300, "1405": 6000, "5001": -10000, "5602": 2000, "2221": -1300, "3001": -106000 };
const EXPECTED_FEB_BALANCE = { "1002": 106300, "1122": 0, "1405": 9000, "5001": -10000, "5602": 2000, "2221": -1300, "3001": -106000 };
const EXPECTED_TRIAL_JAN = { opening_debit: 106000, opening_credit: 106000, period_debit: 13300, period_credit: 13300, closing_debit: 117300, closing_credit: 117300 };
// accountBalances 的发生额是从账套启用期间累计到目标期间，因此 2 月是 1+2 月合计 27600。
const EXPECTED_TRIAL_FEB = { opening_debit: 106000, opening_credit: 106000, period_debit: 27600, period_credit: 27600, closing_debit: 117300, closing_credit: 117300 };
// listVouchers 的排序固定为 period DESC, number DESC。
const EXPECTED_VOUCHERS = [
  ["2026-02", "记", 2, "posted", 3000, 3000],
  ["2026-02", "记", 1, "posted", 11300, 11300],
  ["2026-01", "记", 2, "posted", 2000, 2000],
  ["2026-01", "记", 1, "posted", 11300, 11300],
];
const EXPECTED_SOURCE_TRACE = [
  ["SRC-L06-0001", "created", "ok"],
  ["SRC-L06-0002", "created", "ok"],
];

// ------------------------------------------------------------------ 工具
const LIVE_DB = join(LIVE_DIR, "workbench.db");
const BACKUP_DIR = join(ROOT, "backup-main");

const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha256OrAbsent = (file) => (fs.existsSync(file) ? sha256File(file) : "absent");

const runCli = (args, options = {}) => {
  const sync = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 180000, ...options });
  let json = null;
  try { json = JSON.parse(sync.stdout); } catch { json = null; }
  return { code: sync.status, stdout: sync.stdout, stderr: sync.stderr, json };
};

const runCliAsync = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("error", (error) => resolve({ code: -1, stdout, stderr: String(error?.message || error), json: null }));
  child.once("close", (code) => {
    let json = null;
    try { json = JSON.parse(stdout); } catch { json = null; }
    resolve({ code, stdout, stderr, json });
  });
});

const openSnapshot = (file) => new DatabaseSync(file, { readOnly: true });

/** 现有业务 / 导入相关表的全部行，用于证明「源库没有被备份动作修改」。 */
const liveRows = () => {
  const tables = ["account_sets", "accounts", "opening_balances", "periods", "vouchers", "voucher_entries",
    "import_enterprise_account_sets", "import_source_bindings", "import_batches",
    "import_voucher_sources", "import_batch_vouchers"];
  const out = {};
  for (const table of tables) out[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  return out;
};

const dirSignature = (directory) => {
  const out = [];
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { out.push(`d:${rel}`); walk(file, rel); }
      else out.push(`f:${rel}:${stat.size}:${sha256File(file)}`);
    }
  };
  walk(directory, "");
  return out;
};

/** 用当前实际会计 / 导入接口读取一个数据目录（真实子进程 + 真实 db.mjs 打开）。 */
const inspectRestored = (dataDir) => {
  const script = `
const A = await import(${JSON.stringify(pathToFileURL(join(WORKBENCH, "server", "accounting.mjs")).href)});
const IM = await import(${JSON.stringify(pathToFileURL(join(WORKBENCH, "server", "import-incremental.mjs")).href)});
const sets = A.listAccountSets();
const setId = sets[0].id;
const CODES = ${JSON.stringify(CODES)};
const balance = (period) => {
  const map = A.accountBalances(setId, period);
  return Object.fromEntries(CODES.map((code) => [code, map.get(code) ? map.get(code).net : null]));
};
process.stdout.write(JSON.stringify({
  sets,
  openings: A.getOpeningBalances(setId).map((o) => [o.code, o.debit, o.credit]),
  jan: balance("2026-01"),
  feb: balance("2026-02"),
  trialJan: A.trialBalance(setId, "2026-01").totals,
  trialFeb: A.trialBalance(setId, "2026-02").totals,
  incomeJan: A.incomeStatement(setId, "2026-01"),
  incomeFebYtd: A.incomeStatement(setId, "2026-02").ytd,
  vouchers: A.listVouchers(setId).map((v) => [v.period, v.word, v.number, v.status, v.total_debit, v.total_credit]),
  batchJan: IM.getImportBatch("L06-2026-01"),
  batchFeb: IM.getImportBatch("L06-2026-02"),
  batchState: IM.importBatchState(),
}) + "\\n");
`;
  const scriptFile = join(ROOT, `inspect-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(scriptFile, script, "utf8");
  const child = spawnSync(process.execPath, [scriptFile], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir },
  });
  fs.rmSync(scriptFile, { force: true });
  assert.equal(child.status, 0, `读取恢复库失败：${child.stderr}`);
  return JSON.parse(child.stdout.trim().split("\n").pop());
};

/** 复制一份备份目录用于篡改用例（原备份保持不动）。 */
let copySeq = 0;
const copyBackup = () => {
  copySeq += 1;
  const dir = join(ROOT, `backup-copy-${copySeq}`);
  fs.cpSync(BACKUP_DIR, dir, { recursive: true });
  return dir;
};

const mutateManifest = (dir, mutate) => {
  const file = join(dir, LB.MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(manifest);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};

const cliCode = (result) => (result.json ? result.json.code : `no-json:${result.stderr}`);
const assertRejected = (result, code) => {
  assert.equal(result.code, 2, `期望退出码 2（明确拒绝），实际 ${result.code}：${result.stdout}${result.stderr}`);
  assert.equal(result.json?.ok, false, "拒绝必须显式 ok=false");
  assert.equal(cliCode(result), code, `期望稳定 code=${code}，实际 ${cliCode(result)}`);
};

/**
 * 造一个结构被改过的合成本产品库（用于结构负例）。
 * 全部复制自合法快照 => 内容 / 摘要本身不是判定依据，只有真实结构校验能拦住。
 */
let tamperSeq = 0;
const tamperedDatabase = (label, statements) => {
  tamperSeq += 1;
  const file = join(ROOT, `tampered-${tamperSeq}-${label}.db`);
  fs.copyFileSync(join(BACKUP_DIR, LB.SNAPSHOT_FILE), file);
  const conn = new DatabaseSync(file);
  try {
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec(statements);
  } finally { conn.close(); }
  return file;
};

/** 把某个备份目录里的快照替换成给定文件，并同步清单里的字节数与 sha256（模拟「清单与快照一起伪造」）。 */
const replaceSnapshot = (dir, sourceFile) => {
  const target = join(dir, LB.SNAPSHOT_FILE);
  fs.copyFileSync(sourceFile, target);
  const bytes = fs.readFileSync(target);
  mutateManifest(dir, (manifest) => {
    manifest.snapshot.bytes = bytes.length;
    manifest.snapshot.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
};

/** Windows junction；在禁止创建链接的沙箱里返回 false（该子用例跳过并如实提示，不伪装通过）。 */
const tryJunction = (target, link) => {
  try { fs.symlinkSync(target, link, "junction"); return true; } catch { return false; }
};

try {
  console.log("\nLOCAL-06 备份 / 验证 / 恢复全新目标 回归测试\n");

  // ================================================================ 合成业务准备
  const created = IM.importIncremental({
    payload: { account_set: META, opening_balances: OPENINGS, vouchers: JAN_VOUCHERS },
    batchId: "L06-2026-01",
    source: SOURCE,
    dryRun: false,
  });
  assert.equal(created.status, IM.STATUS.APPLIED, JSON.stringify(created.conflicts));
  const APPENDED = IM.importIncremental({
    payload: { account_set: META, vouchers: FEB_VOUCHERS },
    batchId: "L06-2026-02",
    source: SOURCE,
    mode: "append",
    accountSetId: created.created.accountSetId,
    dryRun: false,
  });
  assert.equal(APPENDED.status, IM.STATUS.APPLIED, JSON.stringify(APPENDED.conflicts));
  const SET_ID = created.created.accountSetId;
  assert.equal(S.IMPORT_SCHEMA_VERSION, 3, "当前真实 schema 契约为 v3；若已升到 v4，本包必须重验");
  assert.equal(LB.SUPPORTED_SCHEMA_VERSION, S.IMPORT_SCHEMA_VERSION,
    "本模块的结构规范必须与当前产品 schema 版本对齐（v4 合并后需先扩展结构规范再重验）");

  const BAL_JAN = A.accountBalances(SET_ID, "2026-01");
  assert.equal(BAL_JAN.get("1002").net, EXPECTED_JAN_BALANCE["1002"], "手算基准：1 月 1002");
  assert.equal(A.accountBalances(SET_ID, "2026-02").get("1002").net, EXPECTED_FEB_BALANCE["1002"], "手算基准：2 月 1002");

  // ================================================================ 1. 模块导入无副作用
  await test("模块导入无副作用：不打开默认库、不创建工作目录", () => {
    const never = join(ROOT, "never-created-dir");
    const repoDataDb = join(WORKBENCH, "data", "workbench.db");
    const beforeRepoData = fs.existsSync(repoDataDb) ? sha256File(repoDataDb) : null;
    const child = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(join(WORKBENCH, "server", "local-backup.mjs")).href)}).then((m) => process.stdout.write(JSON.stringify(Object.keys(m).sort())))`], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, WORKBENCH_DATA_DIR: never },
    });
    assert.equal(child.status, 0, child.stderr);
    const exported = JSON.parse(child.stdout);
    for (const name of ["createBackup", "verifyBackup", "restoreNew", "backupContract"]) {
      assert.ok(exported.includes(name), `缺少导出 ${name}`);
    }
    assert.equal(fs.existsSync(never), false, "导入模块不得创建 / 打开数据目录");
    assert.equal(fs.existsSync(repoDataDb) ? sha256File(repoDataDb) : null, beforeRepoData, "导入模块不得改动默认数据目录里的库");
  });

  // ================================================================ 2. 遗留 WAL（无活动连接）
  await test("遗留 WAL（子进程不关闭连接直接退出）：只读快照含已提交业务，源主库与 -wal 不变且不被删除", () => {
    const legacyDir = join(ROOT, "legacy-wal");
    fs.mkdirSync(legacyDir);
    const legacyDb = join(legacyDir, "workbench.db");
    const childScript = join(ROOT, "legacy-wal-child.mjs");
    fs.writeFileSync(childScript, `
process.env.WORKBENCH_DATA_DIR = ${JSON.stringify(legacyDir)};
const IM = await import(${JSON.stringify(pathToFileURL(join(WORKBENCH, "server", "import-incremental.mjs")).href)});
const created = IM.importIncremental({
  payload: {
    account_set: ${JSON.stringify(META)},
    opening_balances: ${JSON.stringify(OPENINGS)},
    vouchers: ${JSON.stringify(JAN_VOUCHERS)},
  },
  batchId: "L06-LEGACY-01",
  source: ${JSON.stringify(SOURCE)},
  dryRun: false,
});
if (created.status !== IM.STATUS.APPLIED) { process.exitCode = 9; process.stdout.write(JSON.stringify(created.conflicts)); }
// 故意不 close 连接：模拟断电 / 崩溃 / 被强杀后遗留已提交但未 checkpoint 的 WAL。
process.exit(0);
`, "utf8");
    const child = spawnSync(process.execPath, [childScript], { encoding: "utf8", timeout: 120000 });
    fs.rmSync(childScript, { force: true });
    assert.equal(child.status, 0, `子进程应正常写入并退出：${child.stdout}${child.stderr}`);

    assert.ok(fs.existsSync(`${legacyDb}-wal`) && fs.statSync(`${legacyDb}-wal`).size > 0,
      "前置条件：源库应留下未 checkpoint 的 -wal");
    assert.equal(fs.existsSync(`${legacyDb}-journal`), false, "前置条件：不应存在 -journal");

    const before = {
      main: sha256File(legacyDb),
      wal: sha256File(`${legacyDb}-wal`),
      mainBytes: fs.statSync(legacyDb).size,
      walBytes: fs.statSync(`${legacyDb}-wal`).size,
    };

    const out = join(ROOT, "backup-legacy-wal");
    const backup = runCli(["backup", "--db", legacyDb, "--out", out]);
    assert.equal(backup.code, 0, `备份应成功：${backup.stdout}${backup.stderr}`);

    // 源主库与 -wal 的字节、大小都必须完全不变；并且两个文件都还在（不能被 checkpoint 后删除）。
    assert.equal(fs.existsSync(`${legacyDb}-wal`), true, "备份不得删除源库 -wal");
    assert.equal(fs.statSync(`${legacyDb}-wal`).size, before.walBytes, "备份不得改写 / 截断源库 -wal");
    assert.equal(sha256File(`${legacyDb}-wal`), before.wal, "备份不得 checkpoint 源库 WAL（-wal 字节必须不变）");
    assert.equal(fs.statSync(legacyDb).size, before.mainBytes, "备份不得改写源主库字节数");
    assert.equal(sha256File(legacyDb), before.main, "备份不得写入 / checkpoint 源主库");
    assert.equal(fs.existsSync(`${legacyDb}-journal`), false, "备份不得给源库留下 -journal");

    // 快照必须含 WAL 里已提交的业务（4 张凭证 + 来源 / 批次 / 关联），且是独立单文件库。
    const snapshot = join(out, LB.SNAPSHOT_FILE);
    assert.equal(fs.existsSync(`${snapshot}-wal`), false, "快照不得依赖 -wal 附属文件");
    const conn = openSnapshot(snapshot);
    try {
      assert.equal(conn.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM vouchers").get().n, 2, "快照必须包含 WAL 中已提交的凭证");
      assert.equal(conn.prepare("SELECT COALESCE(SUM(debit),0) d FROM voucher_entries").get().d, 13300);
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_batches").get().n, 1);
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_voucher_sources").get().n, 2);
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_batch_vouchers").get().n, 2);
    } finally { conn.close(); }
    assert.equal(runCli(["verify", "--backup", out]).code, 0, "遗留 WAL 的备份必须通过验证");

    // 备份之后源库仍可被产品正常打开（WAL 未被破坏），业务数据仍可读。
    const readScript = join(ROOT, "legacy-wal-read.mjs");
    fs.writeFileSync(readScript, `
process.env.WORKBENCH_DATA_DIR = ${JSON.stringify(legacyDir)};
const A = await import(${JSON.stringify(pathToFileURL(join(WORKBENCH, "server", "accounting.mjs")).href)});
const sets = A.listAccountSets();
process.stdout.write(JSON.stringify({
  sets: sets.length,
  vouchers: A.listVouchers(sets[0].id).length,
  balance1002: A.accountBalances(sets[0].id, "2026-01").get("1002").net,
}) + "\\n");
`, "utf8");
    const read = spawnSync(process.execPath, [readScript], { encoding: "utf8", timeout: 120000 });
    fs.rmSync(readScript, { force: true });
    assert.equal(read.status, 0, `备份后源库仍应可用：${read.stderr}`);
    assert.deepEqual(JSON.parse(read.stdout.trim().split("\n").pop()), {
      sets: 1, vouchers: 2, balance1002: EXPECTED_JAN_BALANCE["1002"],
    });
  });

  // ================================================================ 3. 运行中快照
  await test("运行中快照：含 WAL 已提交数据、排除未提交事务，源主库 / WAL 不变且继续可写", () => {
    assert.ok(fs.existsSync(`${LIVE_DB}-wal`) && fs.statSync(`${LIVE_DB}-wal`).size > 0,
      "前置条件：源库应在 WAL 中有已提交但未 checkpoint 的业务数据");
    const before = liveRows();
    const committedVouchers = before.vouchers.length;
    assert.equal(committedVouchers, 4, "合成业务应有 2 个月共 4 张凭证");
    const walBytes = fs.statSync(`${LIVE_DB}-wal`).size;
    const mainDigest = sha256File(LIVE_DB);
    const walDigest = sha256File(`${LIVE_DB}-wal`);

    // 模拟「另一个正在运行的本机进程」：开一个写事务但尚未提交。
    db.exec("BEGIN IMMEDIATE");
    try {
      const info = db.prepare(
        `INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, kind, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(SET_ID, "2026-03", "2026-03-31", "记", 99, "未提交事务-合成", "posted", "normal", "2026-03-31T00:00:00.000Z");
      const vid = Number(info.lastInsertRowid);
      db.prepare(`INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit) VALUES (?,?,?,?,?,?)`)
        .run(vid, 1, "1002", "未提交事务-合成", 777, 0);
      db.prepare(`INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit) VALUES (?,?,?,?,?,?)`)
        .run(vid, 2, "3001", "未提交事务-合成", 0, 777);

      const backup = runCli(["backup", "--db", LIVE_DB, "--out", BACKUP_DIR]);
      assert.equal(backup.code, 0, `备份应成功：${backup.stdout}${backup.stderr}`);
      assert.equal(backup.json?.ok, true);
      const snapshot = join(BACKUP_DIR, LB.SNAPSHOT_FILE);
      assert.ok(fs.existsSync(snapshot), "必须生成单文件快照");
      assert.equal(fs.existsSync(`${snapshot}-wal`), false, "快照不得依赖 -wal 附属文件");

      // 源主库 / WAL 在备份后必须字节不变（这是「源库不被改写、不被 checkpoint」的硬证据）。
      assert.equal(fs.existsSync(`${LIVE_DB}-wal`), true, "备份不得删除源库 -wal");
      assert.equal(fs.statSync(`${LIVE_DB}-wal`).size, walBytes, "备份不得改写 / 截断源库 -wal");
      assert.equal(sha256File(LIVE_DB), mainDigest, "备份不得写入 / checkpoint 源主库");
      assert.equal(sha256File(`${LIVE_DB}-wal`), walDigest, "备份不得 checkpoint 源库 WAL");

      const conn = openSnapshot(snapshot);
      try {
        assert.equal(conn.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.equal(conn.prepare("PRAGMA journal_mode").get().journal_mode, "delete",
          "快照必须是独立单文件库（不处于 WAL）");
        // WAL 中已提交的 4 张凭证都在。
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM vouchers").get().n, committedVouchers);
        // 未提交事务的凭证不在。
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM vouchers WHERE summary=?").get("未提交事务-合成").n, 0);
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM voucher_entries WHERE summary=?").get("未提交事务-合成").n, 0);
        // 来源 / 批次 / 关联与金额在同一事务时点被保留。
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_batches").get().n, 2);
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_enterprise_account_sets").get().n, 1);
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_source_bindings").get().n, 1);
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_voucher_sources").get().n, 4);
        assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_batch_vouchers").get().n, 4);
        const joined = conn.prepare(
          `SELECT s.source_voucher_id AS sid, v.period AS period, v.number AS number,
                  ROUND((SELECT SUM(debit) FROM voucher_entries e WHERE e.voucher_id = v.id), 2) AS debit,
                  ROUND((SELECT SUM(credit) FROM voucher_entries e WHERE e.voucher_id = v.id), 2) AS credit
             FROM import_voucher_sources s JOIN vouchers v ON v.id = s.voucher_id
            ORDER BY s.source_voucher_id`,
        ).all();
        assert.deepEqual(joined.map((row) => [row.sid, row.period, row.number, row.debit, row.credit]), [
          ["SRC-L06-0001", "2026-01", 1, 11300, 11300],
          ["SRC-L06-0002", "2026-01", 2, 2000, 2000],
          ["SRC-L06-0003", "2026-02", 1, 11300, 11300],
          ["SRC-L06-0004", "2026-02", 2, 3000, 3000],
        ]);
      } finally { conn.close(); }

      // 源库继续持有未提交事务：备份没有阻塞 / 回滚它。
      assert.equal(db.prepare("SELECT COUNT(*) n FROM vouchers").get().n, committedVouchers + 1,
        "备份不得回滚源库正在进行的写入");
    } finally {
      db.exec("ROLLBACK");
    }

    assert.deepEqual(liveRows(), before, "备份动作不得修改源库任何业务 / 来源数据");

    // 备份之后继续写业务：源库仍可用，且新数据不进入既有快照。
    A.createVoucher(SET_ID, {
      period: "2026-03", voucher_date: "2026-03-05", word: "记", number: 1, summary: "备份后新业务", status: "posted",
      entries: [{ code: "1002", debit: 500, credit: 0 }, { code: "5001", debit: 0, credit: 500 }],
    });
    assert.equal(A.accountBalances(SET_ID, "2026-03").get("1002").net, EXPECTED_FEB_BALANCE["1002"] + 500);
    const conn = openSnapshot(join(BACKUP_DIR, LB.SNAPSHOT_FILE));
    try {
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM vouchers").get().n, committedVouchers,
        "备份时点之后新增的业务不得出现在既有快照里");
    } finally { conn.close(); }
  });

  // ================================================================ 4. 清单绑定与验证
  await test("备份清单：格式 / 版本 / 结构 / 迁移记录 / 内容摘要绑定，且不含本机绝对路径", () => {
    const verify = runCli(["verify", "--backup", BACKUP_DIR]);
    assert.equal(verify.code, 0, `verify 应通过：${verify.stdout}${verify.stderr}`);
    assert.equal(verify.json?.ok, true);

    const manifestText = fs.readFileSync(join(BACKUP_DIR, LB.MANIFEST_FILE), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.product, "youshu-workbench");
    assert.equal(manifest.format, "youshu-workbench-local-backup");
    assert.equal(manifest.formatVersion, 1);
    assert.equal(typeof manifest.appVersion, "string");
    assert.ok(manifest.appVersion.length > 0, "appVersion 必须存在（信息性字段）");
    assert.equal(manifest.structure.schemaVersion, S.IMPORT_SCHEMA_VERSION);
    assert.equal(manifest.source.schemaVersion, S.IMPORT_SCHEMA_VERSION);
    assert.deepEqual(manifest.structure.migrations, [1, 2, 3], "清单必须绑定真实迁移记录");
    assert.equal(manifest.snapshot.file, LB.SNAPSHOT_FILE);
    assert.equal(manifest.source.file, "workbench.db", "源库字段只记文件名");
    const snapshot = join(BACKUP_DIR, LB.SNAPSHOT_FILE);
    assert.equal(manifest.snapshot.bytes, fs.statSync(snapshot).size);
    assert.equal(manifest.snapshot.sha256, sha256File(snapshot));
    assert.ok(Number.isInteger(manifest.snapshot.pageSize) && manifest.snapshot.pageSize >= 512);
    assert.equal(manifest.snapshot.journalMode, "delete", "快照必须是独立单文件库");
    assert.equal(manifest.source.journalMode, "wal");
    // 表清单与内容绑定覆盖核心业务表与导入来源表（动态计算，未来新增表自动纳入）。
    for (const table of ["account_sets", "vouchers", "voucher_entries", "opening_balances", "import_batches",
      "import_voucher_sources", "import_batch_vouchers", "import_enterprise_account_sets",
      "import_source_bindings", "schema_migrations", "schema_backups"]) {
      assert.ok(manifest.structure.tables.includes(table), `清单表清单缺少 ${table}`);
      assert.ok(manifest.content.tables[table], `清单内容摘要缺少 ${table}`);
      assert.equal(typeof manifest.content.tables[table].digest, "string");
    }
    assert.match(manifest.content.digest, /^[a-f0-9]{64}$/);
    // 不提交 / 不记录本机绝对路径。
    const lowered = manifestText.toLowerCase();
    assert.equal(lowered.includes(ROOT.toLowerCase().replace(/\\/g, "\\\\")), false, "清单不得包含本机绝对路径（JSON 转义形式）");
    assert.equal(lowered.includes(ROOT.toLowerCase()), false, "清单不得包含本机绝对路径");
    assert.equal(/[a-z]:\\\\/i.test(manifestText), false, "清单不得包含盘符路径");
    // 耐久性按事实汇报（文件内容 fsync 一定执行；目录项 fsync 在 Windows 上不支持，不伪装）。
    const backupResult = runCli(["backup", "--db", LIVE_DB, "--out", join(ROOT, "backup-durability")]);
    assert.equal(backupResult.code, 0, backupResult.stdout + backupResult.stderr);
    assert.equal(backupResult.json?.backupMeta?.durability?.fileContentsSynced, true,
      "快照 / 清单必须先 fsync 再 rename");
    assert.equal(typeof backupResult.json.backupMeta.durability.directoryEntrySyncSupported, "boolean");
  });

  // ================================================================ 5. 清单字段类型与可重算事实
  await test("清单字段类型 / 规范范围逐项校验，可重算字段与真实快照比对（应用版本仅信息性）", () => {
    const expectInvalid = (mutate) => {
      const dir = copyBackup();
      mutateManifest(dir, mutate);
      const result = runCli(["verify", "--backup", dir]);
      assertRejected(result, "manifest_invalid");
      return result;
    };

    expectInvalid((manifest) => { delete manifest.appVersion; });
    expectInvalid((manifest) => { manifest.appVersion = { version: "0.4.0" }; });
    expectInvalid((manifest) => { manifest.appVersion = null; });
    expectInvalid((manifest) => { manifest.formatVersion = 0; });
    expectInvalid((manifest) => { manifest.createdAt = 1700000000000; });
    expectInvalid((manifest) => { manifest.snapshot.bytes = 0; });
    expectInvalid((manifest) => { manifest.snapshot.sha256 = "not-a-digest"; });
    expectInvalid((manifest) => { manifest.snapshot.pageSize = 3000; });
    expectInvalid((manifest) => { manifest.snapshot.journalMode = "wal-ftw"; });
    expectInvalid((manifest) => { manifest.structure.sqliteVersion = 3.51; });
    expectInvalid((manifest) => { manifest.structure.userVersion = -1; });
    expectInvalid((manifest) => { manifest.structure.tables.push("ghost_table"); });
    expectInvalid((manifest) => { manifest.structure.tables.push(manifest.structure.tables[0]); });
    expectInvalid((manifest) => { manifest.structure.migrations = [1, 2]; });
    expectInvalid((manifest) => { manifest.content.tables.vouchers.digest = "0".repeat(63); });
    expectInvalid((manifest) => { manifest.content.tables.vouchers.rows = -1; });
    expectInvalid((manifest) => { delete manifest.content.tables.vouchers; });
    expectInvalid((manifest) => { manifest.source.bytes = 0; });
    expectInvalid((manifest) => { manifest.source.file = "../workbench.db"; });
    expectInvalid((manifest) => { manifest.source.journalMode = "nightly"; });
    expectInvalid((manifest) => { manifest.source.schemaVersion = 3.5; });

    // 应用版本只记录、不参与兼容判定：改成别的版本号仍应通过（与文档口径一致，不伪装严格未来版本拒绝）。
    const appVersionOnly = copyBackup();
    mutateManifest(appVersionOnly, (manifest) => { manifest.appVersion = "9999.0.0"; });
    assert.equal(runCli(["verify", "--backup", appVersionOnly]).code, 0,
      "appVersion 是信息性字段，不参与兼容判定（文档已明确）");

    // 可重算字段与真实快照不符：即使清单内部自洽也必须拒绝。
    const pageSize = copyBackup();
    mutateManifest(pageSize, (manifest) => { manifest.snapshot.pageSize = 8192; });
    const pageResult = runCli(["verify", "--backup", pageSize]);
    assertRejected(pageResult, "snapshot_metadata_mismatch");
    assert.equal(pageResult.json?.details?.field, "pageSize");

    const journalMode = copyBackup();
    mutateManifest(journalMode, (manifest) => { manifest.snapshot.journalMode = "wal"; });
    const journalResult = runCli(["verify", "--backup", journalMode]);
    assertRejected(journalResult, "snapshot_metadata_mismatch");
    assert.equal(journalResult.json?.details?.field, "journalMode");

    const userVersion = copyBackup();
    mutateManifest(userVersion, (manifest) => { manifest.structure.userVersion = 7; });
    const userVersionResult = runCli(["verify", "--backup", userVersion]);
    assertRejected(userVersionResult, "structure_mismatch");
    assert.equal(userVersionResult.json?.details?.field, "userVersion");
  });

  // ================================================================ 6. 恢复到全新目标并读取
  await test("恢复到全新目标：先验证再发布，当前会计 / 导入接口读到相同期初、两个月金额与来源", () => {
    const target = join(ROOT, "restored-main");
    const restore = runCli(["restore-new", "--backup", BACKUP_DIR, "--target", target]);
    assert.equal(restore.code, 0, `恢复应成功：${restore.stdout}${restore.stderr}`);
    assert.equal(restore.json?.ok, true);
    assert.equal(restore.json?.database, "workbench.db");
    assert.equal(restore.json?.durability?.fileContentsSynced, true, "发布前必须 fsync 复制结果");
    assert.equal(typeof restore.json?.durability?.directoryEntrySyncSupported, "boolean");

    assert.ok(fs.existsSync(join(target, "workbench.db")), "目标内应有 workbench.db");
    assert.equal(fs.existsSync(join(target, LB.RESTORE_INCOMPLETE_MARKER)), false, "完成后不得残留未完成标记");
    assert.equal(fs.existsSync(join(target, `${LB.PARTIAL_PREFIX}`)), false);
    const names = fs.readdirSync(target).sort();
    assert.deepEqual(names, ["manifest.json", "restore.json", "workbench.db"], "目标目录只应包含说明书与恢复后的库");
    const receipt = JSON.parse(fs.readFileSync(join(target, LB.RESTORE_RECEIPT_FILE), "utf8"));
    assert.equal(receipt.verified, true);
    assert.equal(receipt.database, "workbench.db");
    assert.deepEqual(receipt.structure.migrations, [1, 2, 3]);
    assert.equal(receipt.snapshot.sha256, sha256File(join(target, "workbench.db")));

    const facts = inspectRestored(target);
    assert.equal(facts.sets.length, 1);
    assert.equal(facts.sets[0].name, META.name);
    assert.equal(facts.sets[0].start_period, META.start_period);
    assert.deepEqual(facts.openings, [["1002", 100000, 0], ["1405", 6000, 0], ["3001", 0, 106000]]);
    assert.deepEqual(facts.jan, EXPECTED_JAN_BALANCE);
    assert.deepEqual(facts.feb, EXPECTED_FEB_BALANCE);
    assert.deepEqual(facts.trialJan, EXPECTED_TRIAL_JAN);
    assert.deepEqual(facts.trialFeb, EXPECTED_TRIAL_FEB);
    assert.equal(facts.incomeJan.current["净利润"], 8000);
    assert.equal(facts.incomeJan.current["营业收入"], 10000);
    assert.equal(facts.incomeJan.current["管理费用"], 2000);
    assert.equal(facts.incomeFebYtd["净利润"], 8000);
    assert.deepEqual(facts.vouchers, EXPECTED_VOUCHERS);
    // 来源 / 批次 / 企业绑定关联一致
    assert.equal(facts.batchJan.batch.status, "completed");
    assert.equal(facts.batchJan.batch.accountSetId, facts.sets[0].id);
    assert.equal(facts.batchJan.source.enterpriseKey, ENTERPRISE_KEY);
    assert.deepEqual(facts.batchJan.sourceTrace.map((item) => [item.sourceVoucherId, item.action, item.state]),
      EXPECTED_SOURCE_TRACE);
    assert.deepEqual(facts.batchFeb.sourceTrace.map((item) => [item.sourceVoucherId, item.action, item.state]), [
      ["SRC-L06-0003", "created", "ok"],
      ["SRC-L06-0004", "created", "ok"],
    ]);
    assert.equal(facts.batchState.enterpriseAccountSets.length, 1);
    assert.equal(facts.batchState.enterpriseAccountSets[0].account_set_id, facts.sets[0].id);
    assert.equal(facts.batchState.sourceBindings.length, 1);

    // 恢复目标是独立库：子进程用完关闭后不依赖任何 sidecar 即可再次打开（已由真实入口证明）。
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      assert.equal(fs.existsSync(join(target, `workbench.db${suffix}`)), false, "恢复后的库不应遗留 sidecar 依赖");
    }
    const reopened = new DatabaseSync(join(target, "workbench.db"));
    try {
      assert.equal(reopened.prepare("SELECT COUNT(*) n FROM vouchers").get().n, 4);
    } finally { reopened.close(); }
  });

  // ================================================================ 7. 已有目标拒绝
  await test("已有目标默认拒绝覆盖，且内容完全不动", () => {
    const target = join(ROOT, "existing-target");
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, "keep.txt"), "operator data\n", "utf8");
    fs.mkdirSync(join(target, "sub"));
    fs.writeFileSync(join(target, "sub", "inner.txt"), "nested\n", "utf8");
    const before = dirSignature(target);

    const restore = runCli(["restore-new", "--backup", BACKUP_DIR, "--target", target]);
    assertRejected(restore, "target_exists");
    assert.deepEqual(dirSignature(target), before, "被拒绝的目标目录内容必须完全不动");

    const { restoreNew } = LB;
    const direct = restoreNew({ backupDir: BACKUP_DIR, targetDir: target });
    assert.equal(direct.ok, false);
    assert.equal(direct.code, "target_exists");
    assert.deepEqual(dirSignature(target), before);
  });

  // ================================================================ 8. 拒绝坏备份
  await test("拒绝损坏 / 截断 / 篡改清单 / 半成品 / 未来版本 / 非本产品备份", () => {
    // 8.1 快照字节被改（大小不变）
    const corrupt = copyBackup();
    const corruptSnapshot = join(corrupt, LB.SNAPSHOT_FILE);
    const bytes = fs.readFileSync(corruptSnapshot);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(corruptSnapshot, bytes);
    assertRejected(runCli(["verify", "--backup", corrupt]), "snapshot_digest_mismatch");
    assertRejected(runCli(["restore-new", "--backup", corrupt, "--target", join(ROOT, "t-corrupt")]), "snapshot_digest_mismatch");
    assert.equal(fs.existsSync(join(ROOT, "t-corrupt")), false, "验证失败不得创建恢复目标");

    // 8.2 快照被截断
    const truncated = copyBackup();
    const truncatedSnapshot = join(truncated, LB.SNAPSHOT_FILE);
    fs.truncateSync(truncatedSnapshot, fs.statSync(truncatedSnapshot).size - 200);
    assertRejected(runCli(["verify", "--backup", truncated]), "snapshot_size_mismatch");

    // 8.3 清单缺失
    const noManifest = copyBackup();
    fs.rmSync(join(noManifest, LB.MANIFEST_FILE));
    assertRejected(runCli(["verify", "--backup", noManifest]), "manifest_missing");

    // 8.4 清单不是合法 JSON
    const badJson = copyBackup();
    fs.writeFileSync(join(badJson, LB.MANIFEST_FILE), "{ not json", "utf8");
    assertRejected(runCli(["verify", "--backup", badJson]), "manifest_invalid");

    // 8.5 未知未来格式版本
    const futureFormat = copyBackup();
    mutateManifest(futureFormat, (manifest) => { manifest.formatVersion = 99; });
    assertRejected(runCli(["verify", "--backup", futureFormat]), "backup_format_unsupported");

    // 8.6 别的产品
    const otherProduct = copyBackup();
    mutateManifest(otherProduct, (manifest) => { manifest.product = "other-product"; });
    assertRejected(runCli(["verify", "--backup", otherProduct]), "backup_app_unsupported");

    // 8.7 未知未来 schema 版本（清单自报）
    const futureSchema = copyBackup();
    mutateManifest(futureSchema, (manifest) => {
      manifest.structure.schemaVersion = 99;
      manifest.source.schemaVersion = 99;
    });
    assertRejected(runCli(["verify", "--backup", futureSchema]), "schema_unsupported");

    // 8.8 旧 schema 版本（清单自报）：本包只支持当前真实结构，不盲放旧结构
    const oldSchema = copyBackup();
    mutateManifest(oldSchema, (manifest) => {
      manifest.structure.schemaVersion = 2;
      manifest.source.schemaVersion = 2;
    });
    assertRejected(runCli(["verify", "--backup", oldSchema]), "schema_outdated");

    // 8.9 清单结构版本与快照实际不符
    const structureMismatch = copyBackup();
    mutateManifest(structureMismatch, (manifest) => { manifest.structure.migrations = [1, 2, 3, 4]; });
    assertRejected(runCli(["verify", "--backup", structureMismatch]), "manifest_invalid");

    // 8.10 内容摘要被改
    const contentMismatch = copyBackup();
    mutateManifest(contentMismatch, (manifest) => { manifest.content.digest = "0".repeat(64); });
    assertRejected(runCli(["verify", "--backup", contentMismatch]), "content_mismatch");

    const tableMismatch = copyBackup();
    mutateManifest(tableMismatch, (manifest) => { manifest.content.tables.vouchers.rows += 1; });
    assertRejected(runCli(["verify", "--backup", tableMismatch]), "content_mismatch");

    // 8.11 半成品：未完成标记 / 临时文件 / 快照 sidecar
    const marked = copyBackup();
    fs.writeFileSync(join(marked, LB.BACKUP_INCOMPLETE_MARKER), "{}\n", "utf8");
    assertRejected(runCli(["verify", "--backup", marked]), "backup_incomplete");

    const partial = copyBackup();
    fs.writeFileSync(join(partial, `${LB.PARTIAL_PREFIX}123-abc.db`), "partial", "utf8");
    assertRejected(runCli(["verify", "--backup", partial]), "backup_incomplete");

    const sidecar = copyBackup();
    fs.writeFileSync(join(sidecar, `${LB.SNAPSHOT_FILE}-wal`), "stale", "utf8");
    assertRejected(runCli(["verify", "--backup", sidecar]), "backup_incomplete");

    // 8.12 快照被换成「非本产品库」（清单摘要同步改对，仍必须按结构拒绝）
    const foreign = copyBackup();
    const foreignPath = join(foreign, LB.SNAPSHOT_FILE);
    fs.rmSync(foreignPath);
    const foreignDb = new DatabaseSync(foreignPath);
    foreignDb.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO foo (note) VALUES ('x')`);
    foreignDb.close();
    const foreignBytes = fs.readFileSync(foreignPath);
    mutateManifest(foreign, (manifest) => {
      manifest.snapshot.bytes = foreignBytes.length;
      manifest.snapshot.sha256 = createHash("sha256").update(foreignBytes).digest("hex");
    });
    assertRejected(runCli(["verify", "--backup", foreign]), "snapshot_not_product_database");

    // 8.13 清单声明的快照文件名不被信任（不按清单路径找文件 / 不接受越界路径）
    const pathInManifest = copyBackup();
    mutateManifest(pathInManifest, (manifest) => { manifest.snapshot.file = "../outside.db"; });
    assertRejected(runCli(["verify", "--backup", pathInManifest]), "manifest_invalid");

    // 8.14 校验和自洽但库页已损坏：固定校验仍必须拦住（integrity_check 不通过）
    const brokenPages = copyBackup();
    const brokenPath = join(brokenPages, LB.SNAPSHOT_FILE);
    const brokenBytes = fs.readFileSync(brokenPath);
    for (let offset = 4096; offset < 8192 && offset < brokenBytes.length; offset += 1) brokenBytes[offset] = 0x5a;
    fs.writeFileSync(brokenPath, brokenBytes);
    mutateManifest(brokenPages, (manifest) => {
      manifest.snapshot.bytes = brokenBytes.length;
      manifest.snapshot.sha256 = createHash("sha256").update(brokenBytes).digest("hex");
    });
    const brokenResult = runCli(["verify", "--backup", brokenPages]);
    assertRejected(brokenResult, cliCode(brokenResult));
    assert.ok(["integrity_failed", "snapshot_unreadable", "content_mismatch", "structure_mismatch",
      "snapshot_not_product_database"].includes(cliCode(brokenResult)),
    `损坏库必须以稳定 code 拒绝，实际 ${cliCode(brokenResult)}`);

    // 8.15 备份目录不存在
    assertRejected(runCli(["verify", "--backup", join(ROOT, "no-such-backup")]), "backup_dir_missing");
  });

  await test("拒绝非本产品 / 非 SQLite / 未知未来 schema 的源库（备份入口）", () => {
    const foreignSource = join(ROOT, "foreign-source.db");
    const conn = new DatabaseSync(foreignSource);
    conn.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY, note TEXT)`);
    conn.close();
    assertRejected(runCli(["backup", "--db", foreignSource, "--out", join(ROOT, "out-foreign")]), "source_not_product_database");
    assert.equal(fs.existsSync(join(ROOT, "out-foreign")), false, "源库不合格时不得创建备份目录");

    const garbage = join(ROOT, "garbage.db");
    fs.writeFileSync(garbage, Buffer.alloc(4096, 0x7a));
    assertRejected(runCli(["backup", "--db", garbage, "--out", join(ROOT, "out-garbage")]), "source_not_database");

    // 未来 schema：把当前快照改成 schema_migrations 记录 99
    const futureSource = join(ROOT, "future-source.db");
    fs.copyFileSync(join(BACKUP_DIR, LB.SNAPSHOT_FILE), futureSource);
    const writer = new DatabaseSync(futureSource);
    writer.prepare("INSERT INTO schema_migrations (version, applied_at, note) VALUES (?,?,?)")
      .run(99, "2027-01-01T00:00:00.000Z", "future");
    writer.close();
    assertRejected(runCli(["backup", "--db", futureSource, "--out", join(ROOT, "out-future")]), "schema_unsupported");

    // 0 字节文件
    const empty = join(ROOT, "empty.db");
    fs.writeFileSync(empty, "");
    assertRejected(runCli(["backup", "--db", empty, "--out", join(ROOT, "out-empty")]), "source_empty");

    // 外键被破坏的产品库（本机实际 FK 约束不成立）必须拒绝，不把坏库做成备份
    const brokenFk = join(ROOT, "broken-fk.db");
    fs.copyFileSync(join(BACKUP_DIR, LB.SNAPSHOT_FILE), brokenFk);
    const fkWriter = new DatabaseSync(brokenFk);
    fkWriter.exec("PRAGMA foreign_keys = OFF");
    fkWriter.exec("DELETE FROM account_sets");
    fkWriter.close();
    assertRejected(runCli(["backup", "--db", brokenFk, "--out", join(ROOT, "out-broken-fk")]), "foreign_key_violation");
    assert.equal(fs.existsSync(join(ROOT, "out-broken-fk")), false, "外键不合格时不得创建备份目录");
  });

  // ================================================================ 9. 真实结构负例
  await test("真实结构校验：缺导入表 / 缺关键列 / 缺唯一或外键约束 / 迁移记录矛盾一律拒绝", () => {
    const assertSourceRejected = (dbFile, code, problemKind = null) => {
      const out = join(ROOT, `out-structure-${Math.random().toString(16).slice(2)}`);
      const result = runCli(["backup", "--db", dbFile, "--out", out]);
      assertRejected(result, code);
      assert.equal(fs.existsSync(out), false, "结构不合格的源库不得创建备份目录");
      if (problemKind) {
        assert.ok(JSON.stringify(result.json?.details ?? {}).includes(problemKind),
          `拒绝明细应指出问题类型 ${problemKind}，实际 ${JSON.stringify(result.json?.details)}`);
      }
      return result;
    };

    // 9.1 缺导入表（管理者复现的「假 v3」场景：只建核心表 + 一条 version=3 迁移记录）
    const fakeV3 = join(ROOT, "fake-v3.db");
    fs.copyFileSync(join(BACKUP_DIR, LB.SNAPSHOT_FILE), fakeV3);
    const fakeWriter = new DatabaseSync(fakeV3);
    fakeWriter.exec("PRAGMA foreign_keys = OFF");
    for (const table of ["import_batch_vouchers", "import_voucher_sources", "import_batches",
      "import_source_bindings", "import_enterprise_account_sets", "schema_backups", "schema_migrations"]) {
      fakeWriter.exec(`DROP TABLE ${table}`);
    }
    for (const table of ["asset_depreciation_runs", "asset_cards", "opening_balances", "periods", "voucher_entries", "vouchers", "accounts"]) {
      fakeWriter.exec(`DROP TABLE ${table}`);
    }
    fakeWriter.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)`);
    fakeWriter.exec(`DELETE FROM schema_migrations`);
    fakeWriter.exec(`INSERT INTO schema_migrations (version) VALUES (3)`);
    fakeWriter.close();
    const fakeResult = assertSourceRejected(fakeV3, "source_not_product_database");
    assert.ok(JSON.stringify(fakeResult.json?.details ?? {}).includes("import_batches"),
      `拒绝明细应列出缺失的导入表，实际 ${JSON.stringify(fakeResult.json?.details)}`);

    // 9.2 缺关键列（导入批次表少了 result_json）
    const missingColumn = tamperedDatabase("missing-column", "ALTER TABLE import_batches DROP COLUMN result_json");
    assertSourceRejected(missingColumn, "source_structure_invalid", "missing_columns");

    // 9.3 缺关键定义列（凭证表少了 kind）
    const missingVoucherColumn = tamperedDatabase("missing-kind", `
      CREATE TABLE vouchers_x (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        period TEXT NOT NULL, voucher_date TEXT NOT NULL, word TEXT NOT NULL DEFAULT '记',
        number INTEGER NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL
      );
      INSERT INTO vouchers_x (id, account_set_id, period, voucher_date, word, number, summary, status, created_at)
        SELECT id, account_set_id, period, voucher_date, word, number, summary, status, created_at FROM vouchers;
      DROP TABLE vouchers;
      ALTER TABLE vouchers_x RENAME TO vouchers;
    `);
    assertSourceRejected(missingVoucherColumn, "source_structure_invalid", "missing_columns");

    // 9.4 缺 UNIQUE 约束（accounts 的 (account_set_id, code) 唯一性没了）
    const missingUnique = tamperedDatabase("missing-unique", `
      CREATE TABLE accounts_x (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,
        contra INTEGER NOT NULL DEFAULT 0, is_leaf INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO accounts_x (id, account_set_id, code, name, category, direction, contra, is_leaf)
        SELECT id, account_set_id, code, name, category, direction, contra, is_leaf FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_x RENAME TO accounts;
    `);
    assertSourceRejected(missingUnique, "source_structure_invalid", "unique");

    // 9.5 缺外键（periods 不再声明 REFERENCES account_sets）
    const missingForeignKey = tamperedDatabase("missing-fk", `
      CREATE TABLE periods_x (
        account_set_id INTEGER NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY (account_set_id, period)
      );
      INSERT INTO periods_x (account_set_id, period, status) SELECT account_set_id, period, status FROM periods;
      DROP TABLE periods;
      ALTER TABLE periods_x RENAME TO periods;
    `);
    assertSourceRejected(missingForeignKey, "source_structure_invalid", "foreign_key");

    // 9.6 迁移记录矛盾（缺 v2，却只剩 1 / 3）
    const migrationGap = tamperedDatabase("migration-gap", "DELETE FROM schema_migrations WHERE version = 2");
    assertSourceRejected(migrationGap, "source_structure_invalid", "migrations_gap");

    // 9.7 备份记录被清空（真实库每次升级都会登记）
    const noBackupRecord = tamperedDatabase("no-backup-record", "DELETE FROM schema_backups");
    assertSourceRejected(noBackupRecord, "source_structure_invalid", "backup_records_empty");

    // 9.8 同一套真实结构校验也作用于验证 / 恢复：把快照换成结构被改过的库并同步清单摘要
    for (const [label, file, code] of [
      ["missing-import-table", fakeV3, "snapshot_not_product_database"],
      ["missing-unique", missingUnique, "structure_invalid"],
      ["migration-gap", migrationGap, "structure_invalid"],
    ]) {
      const dir = copyBackup();
      replaceSnapshot(dir, file);
      assertRejected(runCli(["verify", "--backup", dir]), code);
      const target = join(ROOT, `t-structure-${label}`);
      assertRejected(runCli(["restore-new", "--backup", dir, "--target", target]), code);
      assert.equal(fs.existsSync(target), false, "结构不合格的备份不得被恢复");
    }
  });

  // ================================================================ 10. 外键动作契约（ON DELETE / ON UPDATE）
  await test("外键动作契约：只改 ON DELETE / ON UPDATE 或重复声明同列外键的伪结构在源库与快照都被拒绝，正常结构恢复后可真实删除账套", () => {
    // 独立复现：新临时库初始化产品 v3 → 事务内只重建 periods，把 account_set_id 外键的
    // ON DELETE CASCADE 改成 NO ACTION，其余列 / 主键 / 数据 / 迁移记录完全不变（内容摘要拦不住）。
    const relaxedDelete = tamperedDatabase("fk-delete-no-action", `
      CREATE TABLE periods_x (
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE NO ACTION,
        period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY (account_set_id, period)
      );
      INSERT INTO periods_x (account_set_id, period, status) SELECT account_set_id, period, status FROM periods;
      DROP TABLE periods;
      ALTER TABLE periods_x RENAME TO periods;
    `);
    // 另一变体：ON UPDATE 由默认 NO ACTION 改成 CASCADE（删除动作仍是 CASCADE）。
    const relaxedUpdate = tamperedDatabase("fk-update-cascade", `
      CREATE TABLE periods_x (
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE ON UPDATE CASCADE,
        period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY (account_set_id, period)
      );
      INSERT INTO periods_x (account_set_id, period, status) SELECT account_set_id, period, status FROM periods;
      DROP TABLE periods;
      ALTER TABLE periods_x RENAME TO periods;
    `);

    // 保留原有 `ON DELETE CASCADE`，再额外声明同列同目标的一条 `ON DELETE RESTRICT`：
    // PRAGMA 会给出两个外键分组，按目标键建 Map 时后一条 RESTRICT / CASCADE 会静默覆盖前一条，
    // 于是「两个分组」被误当成兼容结构。实际删除账套仍然失败，必须逐组比对并拒绝重复。
    const duplicateForeignKey = tamperedDatabase("fk-duplicate", `
      CREATE TABLE periods_x (
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY (account_set_id, period),
        FOREIGN KEY (account_set_id) REFERENCES account_sets(id) ON DELETE RESTRICT
      );
      INSERT INTO periods_x (account_set_id, period, status) SELECT account_set_id, period, status FROM periods;
      DROP TABLE periods;
      ALTER TABLE periods_x RENAME TO periods;
    `);

    const periodsRows = (file) => {
      const conn = openSnapshot(file);
      try {
        return conn.prepare("SELECT account_set_id, period, status FROM periods ORDER BY account_set_id, period")
          .all().map((row) => [row.account_set_id, row.period, row.status]);
      } finally { conn.close(); }
    };
    const originalPeriods = periodsRows(join(BACKUP_DIR, LB.SNAPSHOT_FILE));
    assert.ok(originalPeriods.length >= 1, "前置条件：正常库应有期间行");

    // 这种伪结构不是「无害的结构差异」：真实级联删除账套会失败（这正是必须拒绝的原因）。
    const relaxedConn = new DatabaseSync(relaxedDelete);
    try {
      relaxedConn.exec("PRAGMA foreign_keys = ON");
      assert.throws(() => relaxedConn.exec("DELETE FROM account_sets"), /FOREIGN KEY constraint failed/,
        "前置条件：ON DELETE 被改成 NO ACTION 后，真实删除账套必须失败");
    } finally { relaxedConn.close(); }

    // 重复外键变体：两个分组（CASCADE + RESTRICT）都在实际结构里，真实删除账套同样必须失败。
    const duplicateConn = new DatabaseSync(duplicateForeignKey);
    try {
      duplicateConn.exec("PRAGMA foreign_keys = ON");
      const groups = duplicateConn.prepare("SELECT * FROM pragma_foreign_key_list('periods')").all()
        .map((row) => `${row.from}->${row.table}(${row.to}):${String(row.on_delete).toUpperCase()}`)
        .sort();
      assert.deepEqual(groups,
        ["account_set_id->account_sets(id):CASCADE", "account_set_id->account_sets(id):RESTRICT"],
        "前置条件：重复声明的 periods 外键必须产生两个实际分组");
      duplicateConn.exec("BEGIN");
      try {
        assert.throws(() => duplicateConn.exec("DELETE FROM account_sets"), /FOREIGN KEY constraint failed/,
          "前置条件：重复外键（RESTRICT）下真实删除账套必须失败");
      } finally { duplicateConn.exec("ROLLBACK"); }
    } finally { duplicateConn.close(); }

    const fkVariants = [
      ["delete", relaxedDelete, ["foreign_key_actions"]],
      ["update", relaxedUpdate, ["foreign_key_actions"]],
      ["duplicate", duplicateForeignKey, ["foreign_key_duplicate", "foreign_key_actions"]],
    ];
    for (const [label, file, expectedKinds] of fkVariants) {
      // 列 / 主键 / 数据都与原库相同：只有外键动作不同。
      assert.deepEqual(periodsRows(file), originalPeriods, "伪结构不得改动业务数据（否则内容摘要就能拦住）");

      // 10.1 源库入口：拒绝并且不创建备份目录。
      const out = join(ROOT, `out-fk-${label}`);
      const sourceResult = runCli(["backup", "--db", file, "--out", out]);
      assertRejected(sourceResult, "source_structure_invalid");
      const sourceDetails = JSON.stringify(sourceResult.json?.details ?? {});
      for (const kind of expectedKinds) {
        assert.ok(sourceDetails.includes(kind), `拒绝明细应指出 ${kind}，实际 ${sourceDetails}`);
      }
      assert.ok(sourceDetails.includes("periods"), `拒绝明细应指出表名，实际 ${sourceDetails}`);
      assert.equal(sourceDetails.includes(META.name), false, "拒绝明细不得回显账套业务文本");
      assert.equal(fs.existsSync(out), false, "外键契约不符的源库不得创建备份目录");

      // 10.2 快照入口：攻击者把快照与清单的字节数 / sha256 一起重算，仍必须被结构校验拦住。
      const dir = copyBackup();
      replaceSnapshot(dir, file);
      const manifest = JSON.parse(fs.readFileSync(join(dir, LB.MANIFEST_FILE), "utf8"));
      assert.equal(manifest.snapshot.sha256, sha256File(join(dir, LB.SNAPSHOT_FILE)),
        "前置条件：清单摘要已跟着伪快照重算（摘要本身自洽）");
      const verifyResult = runCli(["verify", "--backup", dir]);
      assertRejected(verifyResult, "structure_invalid");
      const verifyDetails = JSON.stringify(verifyResult.json?.details ?? {});
      for (const kind of expectedKinds) {
        assert.ok(verifyDetails.includes(kind), `快照拒绝明细应指出 ${kind}，实际 ${verifyDetails}`);
      }
      const target = join(ROOT, `t-fk-${label}`);
      assertRejected(runCli(["restore-new", "--backup", dir, "--target", target]), "structure_invalid");
      assert.equal(fs.existsSync(target), false, "外键契约不符的备份不得被恢复");
    }

    // 10.3 正常结构对照：合法备份恢复后，用真实会计接口删除账套必须级联成功。
    const controlTarget = join(ROOT, "restored-fk-control");
    const controlRestore = runCli(["restore-new", "--backup", BACKUP_DIR, "--target", controlTarget]);
    assert.equal(controlRestore.code, 0, controlRestore.stdout + controlRestore.stderr);
    const controlScript = join(ROOT, "fk-delete-control.mjs");
    fs.writeFileSync(controlScript, `
const A = await import(${JSON.stringify(pathToFileURL(join(WORKBENCH, "server", "accounting.mjs")).href)});
const { db } = await import(${JSON.stringify(pathToFileURL(join(WORKBENCH, "server", "db.mjs")).href)});
const setId = A.listAccountSets()[0].id;
const count = (table) => db.prepare('SELECT COUNT(*) n FROM "' + table + '"').get().n;
const periodsBefore = db.prepare("SELECT COUNT(*) n FROM periods WHERE account_set_id = ?").get(setId).n;
if (periodsBefore < 1) { process.exitCode = 9; }
A.deleteAccountSet(setId);
process.stdout.write(JSON.stringify({
  periodsBefore,
  sets: count("account_sets"),
  periods: count("periods"),
  vouchers: count("vouchers"),
  entries: count("voucher_entries"),
  sources: count("import_voucher_sources"),
}) + "\\n");
`, "utf8");
    const control = spawnSync(process.execPath, [controlScript], {
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, WORKBENCH_DATA_DIR: controlTarget },
    });
    fs.rmSync(controlScript, { force: true });
    assert.equal(control.status, 0, `正常结构对照的删除应成功：${control.stdout}${control.stderr}`);
    const controlFacts = JSON.parse(control.stdout.trim().split("\n").pop());
    assert.ok(controlFacts.periodsBefore >= 1, "对照库应有期间行，删除才有意义");
    assert.deepEqual(
      [controlFacts.sets, controlFacts.periods, controlFacts.vouchers, controlFacts.entries, controlFacts.sources],
      [0, 0, 0, 0, 0],
      "正常结构下删除账套必须级联成功，账套 / 期间 / 凭证 / 分录 / 来源都归 0",
    );
  });

  // ================================================================ 11. 路径 / 别名边界
  await test("路径与别名边界：硬链接 / junction / sidecar / 目标在备份目录内 / 指向正在使用的库", () => {
    // 10.1 源库经硬链接（另一路径别名同一文件）；用完立即删除，避免影响后续用例的源库计数。
    const hardlink = join(ROOT, "live-hardlink.db");
    fs.linkSync(LIVE_DB, hardlink);
    try {
      assertRejected(runCli(["backup", "--db", hardlink, "--out", join(ROOT, "out-hardlink")]), "source_alias");
    } finally {
      fs.rmSync(hardlink, { force: true });
    }
    assert.equal(fs.statSync(LIVE_DB).nlink, 1, "源库应恢复为单链接，供后续用例使用");

    // 10.2 源库路径经过 junction 目录（真实路径与传入路径不一致）
    const junctionParent = join(ROOT, "live-junction");
    const junctionSupported = tryJunction(LIVE_DIR, junctionParent);
    if (junctionSupported) {
      assertRejected(
        runCli(["backup", "--db", join(junctionParent, "workbench.db"), "--out", join(ROOT, "out-junction")]),
        "source_alias",
      );
    } else {
      console.log("    （跳过 junction 子用例：当前环境不允许创建目录链接）");
    }

    // 10.3 源库指向 WAL sidecar
    assertRejected(runCli(["backup", "--db", `${LIVE_DB}-wal`, "--out", join(ROOT, "out-sidecar")]), "source_sidecar");

    // 10.4 备份目录已存在（目录 / 文件都不覆盖）
    const existingOut = join(ROOT, "out-existing");
    fs.mkdirSync(existingOut);
    assertRejected(runCli(["backup", "--db", LIVE_DB, "--out", existingOut]), "out_exists");
    const existingOutFile = join(ROOT, "out-as-file");
    fs.writeFileSync(existingOutFile, "keep", "utf8");
    assertRejected(runCli(["backup", "--db", LIVE_DB, "--out", existingOutFile]), "out_exists");
    assert.equal(fs.readFileSync(existingOutFile, "utf8"), "keep");

    // 10.5 备份目录本身是 junction（符号链接目录）
    if (junctionSupported) {
      const junctionOut = join(ROOT, "out-junction-alias");
      fs.symlinkSync(existingOut, junctionOut, "junction");
      assertRejected(runCli(["backup", "--db", LIVE_DB, "--out", junctionOut]), "out_alias");
    }

    // 10.6 恢复目标落在备份目录内
    assertRejected(
      runCli(["restore-new", "--backup", BACKUP_DIR, "--target", join(BACKUP_DIR, "nested-target")]),
      "target_conflicts_backup",
    );
    assert.equal(fs.existsSync(join(BACKUP_DIR, "nested-target")), false);

    // 10.7 恢复目标是符号链接目录
    if (junctionSupported) {
      const junctionTarget = join(ROOT, "target-junction");
      fs.symlinkSync(existingOut, junctionTarget, "junction");
      assertRejected(
        runCli(["restore-new", "--backup", BACKUP_DIR, "--target", junctionTarget]),
        "target_alias",
      );
    }

    // 10.8 恢复目标指向正在使用的库文件
    assertRejected(
      runCli(["restore-new", "--backup", BACKUP_DIR, "--target", LIVE_DB]),
      "target_exists",
    );
    assert.ok(fs.statSync(LIVE_DB).isFile(), "正在使用的库文件不得被当成目标目录");

    // 10.9 父目录 junction 别名不能绕过 target_conflicts_backup（真实路径 target 落在备份内）
    if (junctionSupported) {
      const realParent = join(ROOT, "real-parent");
      const aliasParent = join(ROOT, "alias-parent");
      fs.mkdirSync(realParent);
      fs.mkdirSync(aliasParent);
      const realBackup = join(realParent, "backup-alias");
      fs.cpSync(BACKUP_DIR, realBackup, { recursive: true });
      const aliasLink = join(aliasParent, "link");
      fs.symlinkSync(realParent, aliasLink, "junction");
      const signatures = dirSignature(realBackup);

      // 备份经父 junction 访问，目标也经同一别名 => 真实路径在备份内，必须拒绝。
      const viaAliasBackup = join(aliasLink, "backup-alias");
      assertRejected(
        runCli(["restore-new", "--backup", viaAliasBackup, "--target", join(viaAliasBackup, "nested-alias")]),
        "target_conflicts_backup",
      );
      // 备份用真实路径、目标用别名，真实路径同样在备份内。
      assertRejected(
        runCli(["restore-new", "--backup", realBackup, "--target", join(aliasLink, "backup-alias", "nested-alias")]),
        "target_conflicts_backup",
      );
      assert.deepEqual(dirSignature(realBackup), signatures, "被拒绝的别名目标不得改动备份目录");
      assert.equal(fs.existsSync(join(realBackup, "nested-alias")), false);
      // 经别名读取的备份本身仍可用。
      assert.equal(runCli(["verify", "--backup", viaAliasBackup]).code, 0);
    }

    // 10.10 CLI 用法错误
    const usageCases = [
      { args: [], code: "usage_missing_command" },
      { args: ["nope"], code: "usage_unknown_command" },
      { args: ["backup", "--db", LIVE_DB], code: "usage_missing_option" },
      { args: ["backup", "--db", LIVE_DB, "--out"], code: "usage_missing_value" },
      { args: ["backup", "--db", LIVE_DB, "--out", "x", "--bogus", "y"], code: "usage_unknown_option" },
      { args: ["verify", "--backup", BACKUP_DIR, "--backup", BACKUP_DIR], code: "usage_duplicate_option" },
    ];
    for (const item of usageCases) {
      const result = runCli(item.args);
      assert.equal(result.code, 1, `用法错误应以 1 退出：${item.args.join(" ")}`);
      assert.equal(cliCode(result), item.code);
    }
  });

  // ================================================================ 12. 中断与重试
  await test("恢复中断残留：明确拒绝、不产生 workbench.db、清理后可重试成功", () => {
    const target = join(ROOT, "interrupted-target");
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, LB.RESTORE_INCOMPLETE_MARKER), `{"startedAt":"2026-01-01T00:00:00.000Z"}\n`, "utf8");
    fs.writeFileSync(join(target, `${LB.PARTIAL_PREFIX}999-dead.db`), "half", "utf8");
    const before = dirSignature(target);

    assertRejected(runCli(["restore-new", "--backup", BACKUP_DIR, "--target", target]), "target_incomplete");
    assert.deepEqual(dirSignature(target), before, "未完成残留目录不得被改动");
    assert.equal(fs.existsSync(join(target, "workbench.db")), false, "中断状态不得被当成已恢复");

    // 操作者按提示删除残留目录后重试：真实成功。
    fs.rmSync(target, { recursive: true, force: true });
    const retry = runCli(["restore-new", "--backup", BACKUP_DIR, "--target", target]);
    assert.equal(retry.code, 0, `清理后重试应成功：${retry.stdout}${retry.stderr}`);
    assert.equal(sha256File(join(target, "workbench.db")), sha256File(join(BACKUP_DIR, LB.SNAPSHOT_FILE)));
    assert.deepEqual(inspectRestored(target).feb, EXPECTED_FEB_BALANCE);
  });

  await test("真实进程中断的原子边界：备份 / 恢复都不会留下被当成成功的半套数据", async () => {
    // 造一个较大的合成产品库，让「生成快照 / 复制并复验」有可观测窗口（不是测试专用后门，只是数据量）。
    const bigDir = join(ROOT, "big");
    fs.mkdirSync(bigDir);
    const bigDb = join(bigDir, "workbench.db");
    fs.copyFileSync(join(BACKUP_DIR, LB.SNAPSHOT_FILE), bigDb);
    const writer = new DatabaseSync(bigDb);
    try {
      const pad = "x".repeat(6000);
      const insertVoucher = writer.prepare(
        `INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, kind, created_at)
         VALUES (1,'2026-01','2026-01-31','记',?,'填充','posted','normal','2026-01-31T00:00:00.000Z')`,
      );      const insertEntry = writer.prepare(
        `INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit) VALUES (?,?,?,?,?,?)`,
      );
      writer.exec("BEGIN");
      for (let index = 0; index < 1200; index += 1) {
        const info = insertVoucher.run(200000 + index);
        const voucherId = Number(info.lastInsertRowid);
        insertEntry.run(voucherId, 1, "1002", pad, 1, 0);
        insertEntry.run(voucherId, 2, "3001", pad, 0, 1);
      }
      writer.exec("COMMIT");
    } finally { writer.close(); }
    assert.ok(fs.statSync(bigDb).size > 8 * 1024 * 1024, "中断用例需要足量数据形成可观测窗口");

    const bigBackup = join(ROOT, "backup-big");
    const bigBackupResult = runCli(["backup", "--db", bigDb, "--out", bigBackup]);
    assert.equal(bigBackupResult.code, 0, bigBackupResult.stdout + bigBackupResult.stderr);
    const manifest = JSON.parse(fs.readFileSync(join(bigBackup, LB.MANIFEST_FILE), "utf8"));

    const killMidway = async (args, watchPath) => {
      const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      let killed = false;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (fs.existsSync(watchPath)) { killed = true; child.kill(); break; }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const exit = await closed;
      return { killed, exit, stdout };
    };

    // 11.1 备份进程中断：绝不留下「看起来可用」的半成品备份。
    const interruptedBackup = join(ROOT, "backup-interrupted");
    const killBackup = await killMidway(
      ["backup", "--db", bigDb, "--out", interruptedBackup],
      join(interruptedBackup, LB.BACKUP_INCOMPLETE_MARKER),
    );
    assert.ok(killBackup.killed, "应在生成快照期间中断备份进程（未观测到未完成标记）");
    const interruptedVerify = runCli(["verify", "--backup", interruptedBackup]);
    if (fs.existsSync(interruptedBackup)) {
      assert.notEqual(interruptedVerify.code, 0, "中断的备份目录不得通过验证");
      assert.equal(interruptedVerify.json?.ok, false);
      assert.ok(["backup_incomplete", "manifest_missing", "snapshot_missing"].includes(cliCode(interruptedVerify)),
        `中断备份的拒绝码应可操作，实际 ${cliCode(interruptedVerify)}`);
      assert.equal(fs.existsSync(join(interruptedBackup, LB.MANIFEST_FILE)), false,
        "未完成前不得写出可被当成成功的清单");
    }
    // 清理自己产生的残留后重试成功。
    fs.rmSync(interruptedBackup, { recursive: true, force: true });
    const backupRetry = runCli(["backup", "--db", bigDb, "--out", interruptedBackup]);
    assert.equal(backupRetry.code, 0, backupRetry.stdout + backupRetry.stderr);
    assert.equal(runCli(["verify", "--backup", interruptedBackup]).code, 0);

    // 11.2 恢复进程中断：workbench.db 要么不存在，要么就是完整（摘要一致）的库。
    const interruptedTarget = join(ROOT, "target-interrupted");
    const killRestore = await killMidway(
      ["restore-new", "--backup", bigBackup, "--target", interruptedTarget],
      join(interruptedTarget, LB.RESTORE_INCOMPLETE_MARKER),
    );
    assert.ok(killRestore.killed, "应在发布期间中断恢复进程（未观测到未完成标记）");
    const published = join(interruptedTarget, "workbench.db");
    if (fs.existsSync(published)) {
      assert.equal(sha256File(published), manifest.snapshot.sha256,
        "出现 workbench.db 时必须是完整副本（rename 前已校验摘要），不得是半套数据");
    }
    if (fs.existsSync(interruptedTarget)) {
      // 未完成的恢复目标不得被当成成功：重试必须被明确拒绝。
      const retryOnIncomplete = runCli(["restore-new", "--backup", bigBackup, "--target", interruptedTarget]);
      assert.notEqual(retryOnIncomplete.code, 0, "未完成的恢复目标不得被当成成功");
      assert.ok(["target_exists", "target_incomplete"].includes(cliCode(retryOnIncomplete)), cliCode(retryOnIncomplete));
      fs.rmSync(interruptedTarget, { recursive: true, force: true });
    }
    const restoreRetry = runCli(["restore-new", "--backup", bigBackup, "--target", interruptedTarget]);
    assert.equal(restoreRetry.code, 0, restoreRetry.stdout + restoreRetry.stderr);
    assert.equal(sha256File(join(interruptedTarget, "workbench.db")), manifest.snapshot.sha256);
  });

  // ================================================================ 13. 并发
  await test("并发同一备份目录 / 同一恢复目标：恰好一个成功，另一个稳定拒绝，无半成品", async () => {
    const sharedOut = join(ROOT, "backup-concurrent");
    const [first, second] = await Promise.all([
      runCliAsync(["backup", "--db", LIVE_DB, "--out", sharedOut]),
      runCliAsync(["backup", "--db", LIVE_DB, "--out", sharedOut]),
    ]);
    const codes = [first.code, second.code].sort((a, b) => a - b);
    assert.deepEqual(codes, [0, 2], `应恰好一个成功一个拒绝，实际 ${codes.join(",")}`);
    const rejectedRun = first.code === 0 ? second : first;
    // 失败方的观测时机不同：目录已建立但标记尚未清除时是 out_incomplete，否则是 out_exists；两者都是明确拒绝。
    assert.ok(["out_exists", "out_incomplete"].includes(cliCode(rejectedRun)), cliCode(rejectedRun));
    assert.equal(runCli(["verify", "--backup", sharedOut]).code, 0, "并发后备份仍必须是完整可用备份");
    const concurrentNames = fs.readdirSync(sharedOut).sort();
    assert.deepEqual(concurrentNames, [LB.MANIFEST_FILE, LB.SNAPSHOT_FILE], "并发不得残留临时文件 / 标记");

    const sharedTarget = join(ROOT, "target-concurrent");
    const [restoreA, restoreB] = await Promise.all([
      runCliAsync(["restore-new", "--backup", BACKUP_DIR, "--target", sharedTarget]),
      runCliAsync(["restore-new", "--backup", BACKUP_DIR, "--target", sharedTarget]),
    ]);
    const restoreCodes = [restoreA.code, restoreB.code].sort((a, b) => a - b);
    assert.deepEqual(restoreCodes, [0, 2], `恢复应恰好一个成功，实际 ${restoreCodes.join(",")}`);
    const rejectedRestore = restoreA.code === 0 ? restoreB : restoreA;
    assert.ok(["target_exists", "target_incomplete"].includes(cliCode(rejectedRestore)), cliCode(rejectedRestore));
    assert.equal(sha256File(join(sharedTarget, "workbench.db")), sha256File(join(BACKUP_DIR, LB.SNAPSHOT_FILE)));
    assert.equal(fs.existsSync(join(sharedTarget, LB.RESTORE_INCOMPLETE_MARKER)), false);
    const facts = inspectRestored(sharedTarget);
    assert.deepEqual(facts.jan, EXPECTED_JAN_BALANCE);
  });

  // ================================================================ 14. 时点隔离
  await test("备份时点之后的新业务不回滚，旧备份仍停留在原时点", () => {
    const liveBefore = db.prepare("SELECT COUNT(*) n FROM vouchers").get().n;
    A.createVoucher(SET_ID, {
      period: "2026-03", voucher_date: "2026-03-20", word: "记", number: 2, summary: "备份后又一笔", status: "posted",
      entries: [{ code: "5602", debit: 300, credit: 0 }, { code: "1002", debit: 0, credit: 300 }],
    });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM vouchers").get().n, liveBefore + 1, "源库业务必须继续可写");
    assert.equal(A.accountBalances(SET_ID, "2026-03").get("1002").net, EXPECTED_FEB_BALANCE["1002"] + 500 - 300);

    // 旧备份仍通过验证且仍是 4 张凭证（备份时点）。
    assert.equal(runCli(["verify", "--backup", BACKUP_DIR]).code, 0, "备份之后的业务不得让旧备份失效");
    const conn = openSnapshot(join(BACKUP_DIR, LB.SNAPSHOT_FILE));
    try {
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM vouchers").get().n, 4);
      assert.equal(conn.prepare("SELECT COALESCE(SUM(debit),0) AS d FROM voucher_entries").get().d, 27600);
    } finally { conn.close(); }
    const restoredCount = (() => {
      const restored = openSnapshot(join(ROOT, "restored-main", "workbench.db"));
      try { return restored.prepare("SELECT COUNT(*) n FROM vouchers").get().n; } finally { restored.close(); }
    })();
    assert.equal(restoredCount, 4, "已恢复的库不得被后来的源库业务改动");
  });
} catch (error) {
  console.error("测试初始化失败：", error);
  results.push([false, "初始化"]);
} finally {
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
  try { db?.close(); } catch { /* ignore */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}
