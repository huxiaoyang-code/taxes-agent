#!/usr/bin/env node
import { randomUUID as restoreUUID } from 'node:crypto';
import { mkdirSync as restoreMkdir,copyFileSync as restoreCopy,existsSync as restoreExists } from 'node:fs';
import {DatabaseSync as RestoreDb} from 'node:sqlite';
import {assertRestoreOpenPath as pending4} from '../server/local-restore-control.mjs';
import { tmpdir as restoreTmpdir } from 'node:os';
import { join as restoreJoin } from 'node:path';
const restoreSeedMap=new Map(),restoreSeedCache=new Map();
function R4(input){const root=restoreJoin(restoreTmpdir(),restoreUUID());restoreMkdir(root);if(input.backupDir&&input.targetDir)restoreSeedMap.set(input.targetDir,input.backupDir);return {...input,ledgerPath:restoreJoin(root,'ledger.db'),operationId:restoreUUID()};}
function seed4(backupDir){const dir=restoreJoin(restoreTmpdir(),restoreUUID());restoreMkdir(dir);restoreCopy(restoreJoin(backupDir,'workbench.db.snapshot'),restoreJoin(dir,'workbench.db'));return dir;}
function businessSeed4(dataDir){if(!restoreSeedMap.has(dataDir)||!restoreExists(restoreJoin(dataDir,'restore.json')))return dataDir;if(restoreSeedCache.has(dataDir))return restoreSeedCache.get(dataDir);
 let code;try{pending4(restoreJoin(dataDir,'workbench.db'));}catch(e){code=e.code;}if(code!=='restore_target_pending')throw Error('expected real pending target');
 const source=new RestoreDb(restoreJoin(restoreSeedMap.get(dataDir),'workbench.db.snapshot'),{readOnly:true}),target=new RestoreDb(restoreJoin(dataDir,'workbench.db'),{readOnly:true});try{for(const {name} of source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){if(['audit_database_instances','local_batch_database_instances','local_batch_job_bindings','local_batch_input_bindings','local_batch_stages','local_batch_locks','local_batch_lock_epochs','restore_control_component','restore_control_state'].includes(name))continue;if(JSON.stringify(source.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all())!==JSON.stringify(target.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()))throw Error('restored historical row mismatch '+name);}}finally{source.close();target.close();}
 const seed=seed4(restoreSeedMap.get(dataDir));restoreSeedCache.set(dataDir,seed);return seed;
}
function cli4(input){if(input[0]!=='restore-new'||!input.includes('--backup')||!input.includes('--target')||input.includes('--ledger'))return input;const r=R4({backupDir:input[input.indexOf('--backup')+1],targetDir:input[input.indexOf('--target')+1]});return [...input,'--ledger',r.ledgerPath,'--operation',r.operationId];}
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
 *  - 真实结构（schema **v3 / v4 独立契约**）：列 / 类型 / NOT NULL / 默认值 / 主键 / UNIQUE / 外键 /
 *    迁移记录连续性；外键按外键分组比对 `ON DELETE` / `ON UPDATE` / `MATCH` 动作（不只比目标列），
 *    只改动作的伪结构在源库与快照两侧都被拒绝，且正常结构恢复后真实删除账套可级联成功；
 *    缺导入表、缺关键列、缺约束、缺默认值、迁移记录矛盾 / 空备份记录、未在本契约内的表
 *    （未来组件）一律拒绝（源库与快照双向）；
 *  - v3 旧备份：按 v3 契约只读验证并原样恢复到全新目录（**不**就地迁移备份 / 源库），
 *    之后由产品真实入口打开才走既有 v3→v4 迁移路径（实际差异写进断言）；
 *  - v4 真实产品合成库：资产卡片 5 个补项列 + 期初累计 / 连续期间计提与总账 / 导入批次与来源 /
 *    封账状态，实际 createBackup→verifyBackup→restoreNew，再用真实入口读取并在恢复库上继续操作；
 *  - 伪 v4（只抬高版本号、缺列 / 错默认值 / 错 null / 错类型）、未知组件、未来版本、
 *    重算清单摘要的伪兼容一律拒绝，且失败不改源库 / 不创建目标 / 不留半成品；
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

// ================================================================== v4 真实合成库（资产补项 / 连续期间 / 封账）
// 全部由**真实产品入口**建库（子进程 + 真实 db.mjs / import-incremental / accounting，
// 不直接写表、不手改迁移记录），并在下面用**独立手算**的金额 / 状态写预期。
const MODULE_URLS = {
  db: pathToFileURL(join(WORKBENCH, "server", "db.mjs")).href,
  accounting: pathToFileURL(join(WORKBENCH, "server", "accounting.mjs")).href,
  importIncremental: pathToFileURL(join(WORKBENCH, "server", "import-incremental.mjs")).href,
};
const V4_DIR = join(ROOT, "v4-live");
const V4_BACKUP = join(ROOT, "backup-v4");
const V4_RESTORED = join(ROOT, "restored-v4");
const V4_ENTERPRISE_KEY = "91350000LOCAL06V4";
const V4_SOURCE = { system: "local-book", enterpriseKey: V4_ENTERPRISE_KEY, enterpriseName: "合成v4公司" };
const V4_META = {
  name: "合成v4公司",
  taxpayer_type: "小规模纳税人",
  accounting_standard: "小企业会计准则",
  start_period: "2026-01",
};
// 期初：货币资金 400000 / 固定资产原值 120000 / 已入账累计折旧 24000 / 实收资本 496000。
const V4_OPENINGS = [
  { code: "1002", debit: 400000, credit: 0 },
  { code: "1601", debit: 120000, credit: 0 },
  { code: "1602", debit: 0, credit: 24000 },
  { code: "3001", debit: 0, credit: 496000 },
];
// 卡片：原值 120000 / 残值率 5% => 可计提 114000 / 60 期 => 每期 1900（恰好提足，无尾差）。
// 期初累计 24000（补项，与总账 1602 一致），取得期间 2026-01，账簿状态 booked，来源 supplement。
const V4_ASSET = {
  kind: "fixed", name: "合成生产设备", original_cost: 120000, residual_rate: 0.05,
  useful_life_months: 60, start_period: "2026-01", asset_account: "1601", accum_account: "1602",
  expense_account: "5602", acquired_period: "2026-01", opening_accumulated: 24000,
  ledger_status: "booked", origin: "supplement",
};
const V4_JAN_VOUCHERS = [
  {
    period: "2026-01", date: "2026-01-10", word: "记", number: 1, summary: "销售商品",
    entries: [
      { code: "1122", debit: 11300, credit: 0 },
      { code: "5001", debit: 0, credit: 10000 },
      { code: "2221", debit: 0, credit: 1300 },
    ],
    sourceVoucherId: "SRC-V4-0001",
  },
  {
    period: "2026-01", date: "2026-01-20", word: "记", number: 2, summary: "支付管理费用",
    entries: [
      { code: "5602", debit: 2000, credit: 0 },
      { code: "1002", debit: 0, credit: 2000 },
    ],
    sourceVoucherId: "SRC-V4-0002",
  },
];
const V4_FEB_VOUCHERS = [
  {
    period: "2026-02", date: "2026-02-10", word: "记", number: 1, summary: "收到货款",
    entries: [
      { code: "1002", debit: 11300, credit: 0 },
      { code: "1122", debit: 0, credit: 11300 },
    ],
    sourceVoucherId: "SRC-V4-0003",
  },
  {
    period: "2026-02", date: "2026-02-15", word: "记", number: 2, summary: "采购商品",
    entries: [
      { code: "1405", debit: 3000, credit: 0 },
      { code: "1002", debit: 0, credit: 3000 },
    ],
    sourceVoucherId: "SRC-V4-0004",
  },
];
const V4_CODES = ["1002", "1122", "1405", "1601", "1602", "2221", "3103", "3001", "5602"];
// 独立手算（不调用被测代码）：
//  1 月：1002 400000-2000=398000；1122 +11300；1601 120000；1602 -(24000+1900)=-25900；
//       2221 -1300；3103 = 10000-2000-1900 = -6100（结转后损益类归零）；3001 -496000。
const EXPECTED_V4_JAN_BALANCE = {
  "1002": 398000, "1122": 11300, "1405": 0, "1601": 120000, "1602": -25900,
  "2221": -1300, "3103": -6100, "3001": -496000, "5602": 0,
};
//  2 月：1002 398000+11300-3000=406300；1122 0；1405 +3000；1602 -(25900+1900)=-27800；
//       5602 +1900（2 月未结转）；3103 / 2221 / 1601 / 3001 不变。
const EXPECTED_V4_FEB_BALANCE = {
  "1002": 406300, "1122": 0, "1405": 3000, "1601": 120000, "1602": -27800,
  "2221": -1300, "3103": -6100, "3001": -496000, "5602": 1900,
};
// listVouchers 固定排序 period DESC, number DESC。
const EXPECTED_V4_VOUCHERS = [
  ["2026-02", "记", 3, "depreciation", "posted", 1900, 1900],
  ["2026-02", "记", 2, "normal", "posted", 3000, 3000],
  ["2026-02", "记", 1, "normal", "posted", 11300, 11300],
  ["2026-01", "记", 4, "carryforward", "posted", 10000, 10000],
  ["2026-01", "记", 3, "depreciation", "posted", 1900, 1900],
  ["2026-01", "记", 2, "normal", "posted", 2000, 2000],
  ["2026-01", "记", 1, "normal", "posted", 11300, 11300],
];
// v4 只加 5 列的真实期望：类型 / NOT NULL / 默认值（与 import-storage.mjs 的 ALTER TABLE 逐字一致）。
const V4_ADDED_COLUMNS = [
  { name: "acquired_period", type: "TEXT", notnull: 0, dflt: null },
  { name: "opening_accumulated", type: "REAL", notnull: 1, dflt: "0" },
  { name: "ledger_status", type: "TEXT", notnull: 1, dflt: "'booked'" },
  { name: "ledger_note", type: "TEXT", notnull: 1, dflt: "''" },
  { name: "origin", type: "TEXT", notnull: 1, dflt: "'purchase'" },
];
// v3 的 asset_cards 完整列契约（用于断言派生的 v3 夹具确实是 v3 结构）。
const V3_ASSET_COLUMNS = [
  ["id", "INTEGER", 0, null],
  ["account_set_id", "INTEGER", 1, null],
  ["kind", "TEXT", 1, "'fixed'"],
  ["name", "TEXT", 1, null],
  ["original_cost", "REAL", 1, null],
  ["residual_rate", "REAL", 1, "0.05"],
  ["useful_life_months", "INTEGER", 1, null],
  ["start_period", "TEXT", 1, null],
  ["asset_account", "TEXT", 1, null],
  ["accum_account", "TEXT", 1, null],
  ["expense_account", "TEXT", 1, "'5602'"],
  ["created_at", "TEXT", 1, null],
];

// ------------------------------------------------------------------ 工具
const LIVE_DB = join(LIVE_DIR, "workbench.db");
const BACKUP_DIR = join(ROOT, "backup-main");

const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha256OrAbsent = (file) => (fs.existsSync(file) ? sha256File(file) : "absent");

const runCli = (args, options = {}) => {
  args=cli4(args);
  const sync = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 180000, ...options });
  let json = null;
  try { json = JSON.parse(sync.stdout); } catch { json = null; }
  return { code: sync.status, stdout: sync.stdout, stderr: sync.stderr, json };
};

const runCliAsync = (args) => new Promise((resolve) => {
 args=cli4(args);
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let actualExit;child.once("exit",(code,signal)=>{actualExit={code,signal};});
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("error", (error) => resolve({ code: -1, stdout, stderr: String(error?.message || error), json: null }));
  child.once("close", (code,signal) => {
    assert.deepEqual(actualExit,{code,signal});console.log("owned CLI actual exit+close "+JSON.stringify(actualExit));
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
 dataDir=businessSeed4(dataDir);
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
 * `baseFile` 默认为 LIVE_DIR 的 v4 备份快照，也可传 v3 快照等其它合法基准。
 */
let tamperSeq = 0;
const tamperedDatabase = (label, statements, baseFile = join(BACKUP_DIR, LB.SNAPSHOT_FILE)) => {
  tamperSeq += 1;
  const file = join(ROOT, `tampered-${tamperSeq}-${label}.db`);
  fs.copyFileSync(baseFile, file);
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

// ------------------------------------------------------------------ v4 / v3 夹具工具
/** 在指定数据目录里跑一段真实产品代码（子进程），返回它最后一行 JSON。 */
const runInDataDir = (body, dataDir) => {
 dataDir=businessSeed4(dataDir);
  const scriptFile = join(ROOT, `child-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(scriptFile, body, "utf8");
  const child = spawnSync(process.execPath, [scriptFile], {
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir },
  });
  fs.rmSync(scriptFile, { force: true });
  assert.equal(child.status, 0, `子进程失败：${child.stdout}${child.stderr}`);
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
};

/**
 * 用当前真实产品入口生成业务，再以真实历史迁移构建 v4 结构并复制合成业务行：
 *  1) 真实增量导入建账套（期初 + 1 月两张来源凭证 + 企业绑定 / 批次）；
 *  2) 真实资产卡片入口新增卡片（5 个补项列全有值）；
 *  3) 1 月计提 → 结转本期损益 → 真实封账（2026-01 closed）；
 *  4) 追加 2 月两张来源凭证 → 2 月计提（2 月保持 open）。
 * 金额由上层独立手算，这里只负责走真实写入口并返回需要的 ID。
 */
const buildV4Database = () => { const built = runInDataDir(`
const { db } = await import(${JSON.stringify(MODULE_URLS.db)});
const A = await import(${JSON.stringify(MODULE_URLS.accounting)});
const IM = await import(${JSON.stringify(MODULE_URLS.importIncremental)});
const fail = (label, detail) => { console.error(label, JSON.stringify(detail ?? null)); process.exit(9); };
const first = IM.importIncremental({
  payload: { account_set: ${JSON.stringify(V4_META)}, opening_balances: ${JSON.stringify(V4_OPENINGS)},
    vouchers: ${JSON.stringify(V4_JAN_VOUCHERS)} },
  batchId: "L06V4-2026-01", source: ${JSON.stringify(V4_SOURCE)}, dryRun: false,
});
if (first.status !== IM.STATUS.APPLIED) fail("v4_import_jan", first);
const setId = first.created.accountSetId;
const card = A.addAssetCard(setId, ${JSON.stringify(V4_ASSET)});
const janDep = A.generateDepreciation(setId, "2026-01");
if (!janDep.voucher) fail("v4_jan_depreciation_missing", janDep);
const janCarry = A.carryForwardProfit(setId, "2026-01");
if (!janCarry.voucher) fail("v4_jan_carry_missing", janCarry);
const closedJan = A.setPeriodStatus(setId, "2026-01", "closed");
const appended = IM.importIncremental({
  payload: { account_set: ${JSON.stringify(V4_META)}, vouchers: ${JSON.stringify(V4_FEB_VOUCHERS)} },
  batchId: "L06V4-2026-02", source: ${JSON.stringify(V4_SOURCE)}, mode: "append", accountSetId: setId, dryRun: false,
});
if (appended.status !== IM.STATUS.APPLIED) fail("v4_append_feb", appended);
const febDep = A.generateDepreciation(setId, "2026-02");
if (!febDep.voucher) fail("v4_feb_depreciation_missing", febDep);
process.stdout.write(JSON.stringify({
  setId, cardId: card.id,
  janDepVoucherId: janDep.voucher.id, janCarryVoucherId: janCarry.voucher.id, febDepVoucherId: febDep.voucher.id,
  closedJan, periods: A.listPeriods(setId),
}) + "\\n");
// 故意不 close：留下已提交未 checkpoint 的 WAL，备份必须能从 WAL 取到已提交业务。
process.exit(0);
`, V4_DIR);
  // Preserve the genuine current-product database. Historical structure is built by
  // the actual migration entry from its real pre-v5 snapshot, never by inventing records.
  const current = join(V4_DIR, "workbench.db");
  const checkpoint = new DatabaseSync(current);
  try { checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { checkpoint.close(); }
  const product = join(V4_DIR, "current-product-v5.db"); fs.renameSync(current, product);
  deriveHistoricalDatabase(product, current, 4);
  return built;
};

// v3 / v4 are structure-equivalent synthetic historical fixtures, not real account books.
// Historical fixture schemas use the real public migration target. Only synthetic
// business rows are copied, preserving IDs and fingerprints; schema records and their
// consistent pre-migration snapshot are generated by ensureImportSchema itself.
const deriveHistoricalDatabase = (productSource, target, targetVersion) => {
  const source = new DatabaseSync(productSource, { readOnly: true });
  let conn;
  try {
    const initial = source.prepare("SELECT path FROM schema_backups ORDER BY id LIMIT 1").get().path;
    const pre = new DatabaseSync(initial, { readOnly: true });
    try { assert.equal(S.schemaVersion(pre), 0, "historical fixture starts from genuine pre-migration base"); }
    finally { pre.close(); }
    fs.copyFileSync(initial, target);
    conn = new DatabaseSync(target);
    const migrated = S.ensureImportSchema(conn, { dataDir: dirname(target), targetVersion });
    assert.equal(migrated.to, targetVersion);
    conn.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','schema_backups') ORDER BY name").all();
    for (const { name } of tables) {
      const columns = conn.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
      const projection = columns.map(c => '"' + c + '"').join(',');
      const rows = source.prepare(`SELECT ${projection} FROM "${name}" ORDER BY rowid`).all();
      const insert = conn.prepare(`INSERT INTO "${name}"(${projection}) VALUES(${columns.map(() => '?').join(',')})`);
      for (const row of rows) insert.run(...columns.map(c => row[c]));
    }
    conn.exec("COMMIT");
    assert.equal(conn.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { try { conn?.close(); } finally { source.close(); } }
  return target;
};
const deriveV3Database = (source, target) => deriveHistoricalDatabase(source, target, 3);

/** 读一个库里 asset_cards 的列事实（列名 / 类型 / NOT NULL / 默认值），按声明顺序。 */
const assetCardColumns = (file) => {
  const conn = openSnapshot(file);
  try {
    return conn.prepare(`PRAGMA table_info("asset_cards")`).all().map((column) => [
      String(column.name), String(column.type ?? ""), Number(column.notnull),
      column.dflt_value === null || column.dflt_value === undefined ? null : String(column.dflt_value),
    ]);
  } finally { conn.close(); }
};

/** 读迁移记录与迁移前备份登记。 */
const migrationFacts = (file) => {
  const conn = openSnapshot(file);
  try {
    return {
      migrations: conn.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r.version)),
      backupVersions: conn.prepare("SELECT version FROM schema_backups ORDER BY version").all().map((r) => Number(r.version)),
    };
  } finally { conn.close(); }
};

/** 用真实会计 / 导入接口读取恢复出来的 v4 库（含资产卡片 / 计提 / 批次 / 期间状态）。 */
const inspectRestoredV4 = (dataDir) => runInDataDir(`
const A = await import(${JSON.stringify(MODULE_URLS.accounting)});
const IM = await import(${JSON.stringify(MODULE_URLS.importIncremental)});
const sets = A.listAccountSets();
const setId = sets[0].id;
const CODES = ${JSON.stringify(V4_CODES)};
const balance = (period) => {
  const map = A.accountBalances(setId, period);
  return Object.fromEntries(CODES.map((code) => [code, map.get(code) ? map.get(code).net : null]));
};
process.stdout.write(JSON.stringify({
  sets: sets.map((s) => ({ id: s.id, name: s.name, start_period: s.start_period })),
  openings: A.getOpeningBalances(setId).map((o) => [o.code, o.debit, o.credit]),
  jan: balance("2026-01"),
  feb: balance("2026-02"),
  trialFeb: A.trialBalance(setId, "2026-02").totals,
  cards: A.listAssetCards(setId).map((c) => ({
    name: c.name, original_cost: c.original_cost, residual_rate: c.residual_rate,
    useful_life_months: c.useful_life_months, start_period: c.start_period,
    acquired_period: c.acquired_period, opening_accumulated: c.opening_accumulated,
    ledger_status: c.ledger_status, ledger_note: c.ledger_note, origin: c.origin,
    depreciable: c.depreciable, monthly: c.monthly, final_month: c.final_month,
    accumulated: c.accumulated, months_done: c.months_done, remaining: c.remaining,
  })),
  runs: A.listDepreciationRuns(setId).map((r) => [r.period, r.amount, r.voucher_id]),
  vouchers: A.listVouchers(setId).map((v) => [v.period, v.word, v.number, v.kind, v.status, v.total_debit, v.total_credit]),
  periods: A.listPeriods(setId).map((p) => [p.period, p.status]),
  batchJan: IM.getImportBatch("L06V4-2026-01"),
  batchFeb: IM.getImportBatch("L06V4-2026-02"),
  batchState: IM.importBatchState(),
  stepsJan: A.periodEndCheck(setId, "2026-01").steps.map((s) => [s.id, s.status]),
  stepsFeb: A.periodEndCheck(setId, "2026-02").steps.map((s) => [s.id, s.status]),
}) + "\\n");
`, dataDir);

/** 在恢复出来的 v4 库上做真实后续操作：能写的写成功，已封账的必须拒绝。 */
const followUpOnRestoredV4 = (dataDir) => runInDataDir(`
const A = await import(${JSON.stringify(MODULE_URLS.accounting)});
const setId = A.listAccountSets()[0].id;
const codeOf = (fn) => { try { fn(); return null; } catch (error) { return String(error && error.code ? error.code : (error && error.message) || error); } };
const created = A.createVoucher(setId, {
  period: "2026-02", voucher_date: "2026-02-20", word: "记", number: 9, summary: "恢复后新增", status: "posted",
  entries: [{ code: "1002", debit: 500, credit: 0 }, { code: "5001", debit: 0, credit: 500 }],
});
const closedPeriodWrite = codeOf(() => A.createVoucher(setId, {
  period: "2026-01", voucher_date: "2026-01-25", word: "记", number: 9, summary: "已封账期间写入", status: "posted",
  entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "5001", debit: 0, credit: 100 }],
}));
const unpostDepreciation = codeOf(() => A.unpostVoucher(setId,
  A.listVouchers(setId, { period: "2026-01" }).find((v) => v.kind === "depreciation").id));
const march = A.generateDepreciation(setId, "2026-03");
const feb = A.accountBalances(setId, "2026-02");
const mar = A.accountBalances(setId, "2026-03");
process.stdout.write(JSON.stringify({
  createdVoucherId: created.id,
  closedPeriodWrite, unpostDepreciation,
  marchVoucherId: march.voucher ? march.voucher.id : null,
  marchRuns: march.runs,
  feb1002: feb.get("1002").net,
  feb5001: feb.get("5001") ? feb.get("5001").net : null,
  mar1602: mar.get("1602").net,
  mar5602: mar.get("5602") ? mar.get("5602").net : null,
  periods: A.listPeriods(setId).map((p) => [p.period, p.status]),
  vouchers: A.listVouchers(setId).length,
  cards: A.listAssetCards(setId).map((c) => [c.accumulated, c.months_done, c.remaining]),
}) + "\\n");
`, dataDir);

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
  assert.equal(S.IMPORT_SCHEMA_VERSION, 5, "当前真实 schema 契约为 v4（LOCAL-02 资产卡片补项 5 列）");
  assert.deepEqual([...LB.SUPPORTED_SCHEMA_VERSIONS], [3, 4, 5],
    "本模块必须同时精确支持 v3（旧备份）与 v4（当前产品结构）");
  assert.ok(LB.SUPPORTED_SCHEMA_VERSIONS.includes(S.IMPORT_SCHEMA_VERSION),
    "产品 schema 版本必须在已独立验证的版本集合内（升级后必须先扩展结构契约）");
  assert.equal(LB.SUPPORTED_SCHEMA_VERSION, S.IMPORT_SCHEMA_VERSION,
    "最高支持版本必须与当前产品 schema 对齐（v5 必须先加契约再抬高版本）");

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
    assert.deepEqual(manifest.structure.migrations, [1, 2, 3, 4, 5], "清单必须绑定真实迁移记录");
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
    assert.equal(receipt.receiptVersion, 2);assert.equal(receipt.target.writeState,"pending");
    assert.equal(receipt.target.database.file, "workbench.db");
    assert.equal(receipt.target.coreVersion,5);
    assert.deepEqual(migrationFacts(join(target,"workbench.db")).migrations,[1,2,3,4,5]);
    assert.equal(receipt.target.database.sha256, sha256File(join(target, "workbench.db")));

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
    const direct = restoreNew(R4({ backupDir: BACKUP_DIR, targetDir: target }));
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

    // 8.9 迁移记录不连续（缺 v3 却写了 v4）：即使版本号写着 4 也不是合法 v4
    const structureMismatch = copyBackup();
    mutateManifest(structureMismatch, (manifest) => { manifest.structure.migrations = [1, 2, 4]; });
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
      env: { ...process.env, WORKBENCH_DATA_DIR: businessSeed4(controlTarget) },
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
    assert.equal(junctionSupported, true, "必须实际构造自有 junction 验证边界");
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
      "restore_target_binding_mismatch",
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
        "restore_target_binding_mismatch",
      );
      // 备份用真实路径、目标用别名，真实路径同样在备份内。
      assertRejected(
        runCli(["restore-new", "--backup", realBackup, "--target", join(aliasLink, "backup-alias", "nested-alias")]),
        "restore_target_binding_mismatch",
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
  await test("恢复中断残留：明确拒绝并保全原现场，独立新目标可重试成功", () => {
    const target = join(ROOT, "interrupted-target");
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, LB.RESTORE_INCOMPLETE_MARKER), `{"startedAt":"2026-01-01T00:00:00.000Z"}\n`, "utf8");
    fs.writeFileSync(join(target, `${LB.PARTIAL_PREFIX}999-dead.db`), "half", "utf8");
    const before = dirSignature(target);

    assertRejected(runCli(["restore-new", "--backup", BACKUP_DIR, "--target", target]), "target_incomplete");
    assert.deepEqual(dirSignature(target), before, "未完成残留目录不得被改动");
    assert.equal(fs.existsSync(join(target, "workbench.db")), false, "中断状态不得被当成已恢复");

    // 原失败现场保全；独立全新目录使用新的op/ledger验证恢复。
    const retryTarget=join(ROOT,"interrupted-new-target");
    const retry = runCli(["restore-new", "--backup", BACKUP_DIR, "--target", retryTarget]);
    assert.equal(retry.code, 0, `清理后重试应成功：${retry.stdout}${retry.stderr}`);
    assert.notEqual(sha256File(join(retryTarget, "workbench.db")), sha256File(join(BACKUP_DIR, LB.SNAPSHOT_FILE)));
    assert.deepEqual(inspectRestored(retryTarget).feb, EXPECTED_FEB_BALANCE);
    assert.deepEqual(dirSignature(target),before,"原中断现场保持");
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
 args=cli4(args);
      const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      let exited;child.once("exit",(code,signal)=>{exited={code,signal};});
      const closed = new Promise((resolve) => child.once("close", (code, signal) => {assert.deepEqual(exited,{code,signal});console.log("owned interrupted child actual exit+close "+JSON.stringify(exited));resolve({ code, signal,closed:true });}));
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
    // 保留实际中断现场，另用全新输出根重试。
    const retriedBackup=join(ROOT,"backup-interrupted-new");
    const backupRetry = runCli(["backup", "--db", bigDb, "--out", retriedBackup]);
    assert.equal(backupRetry.code, 0, backupRetry.stdout + backupRetry.stderr);
    assert.equal(runCli(["verify", "--backup", retriedBackup]).code, 0);

    // 11.2 恢复进程中断：workbench.db 要么不存在，要么就是完整（摘要一致）的库。
    const interruptedTarget = join(ROOT, "target-interrupted");
    const killRestore = await killMidway(
      ["restore-new", "--backup", bigBackup, "--target", interruptedTarget],
      join(interruptedTarget, LB.RESTORE_INCOMPLETE_MARKER),
    );
    assert.ok(killRestore.killed, "应在发布期间中断恢复进程（未观测到未完成标记）");
    const published = join(interruptedTarget, "workbench.db");
    if (fs.existsSync(published)) {
      assert.equal(sha256File(published), JSON.parse(fs.readFileSync(join(interruptedTarget,"restore.json"),"utf8")).target.database.sha256,
        "出现 workbench.db 时必须是完整副本（rename 前已校验摘要），不得是半套数据");
    }
    if (fs.existsSync(interruptedTarget)) {
      // 未完成的恢复目标不得被当成成功：重试必须被明确拒绝。
      const retryOnIncomplete = runCli(["restore-new", "--backup", bigBackup, "--target", interruptedTarget]);
      assert.notEqual(retryOnIncomplete.code, 0, "未完成的恢复目标不得被当成成功");
      assert.ok(["target_exists", "target_incomplete"].includes(cliCode(retryOnIncomplete)), cliCode(retryOnIncomplete));
      // 无论是否已发布，原目标/回执/partial保留给reconcile。
    }
    const newTarget=join(ROOT,"target-interrupted-new");
    const restoreRetry = runCli(["restore-new", "--backup", bigBackup, "--target", newTarget]);
    assert.equal(restoreRetry.code, 0, restoreRetry.stdout + restoreRetry.stderr);
    assert.notEqual(sha256File(join(newTarget, "workbench.db")), manifest.snapshot.sha256);
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
    assert.notEqual(sha256File(join(sharedTarget, "workbench.db")), sha256File(join(BACKUP_DIR, LB.SNAPSHOT_FILE)));
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

  // ================================================================ 15. v4 全链路（真实产品合成库）
  await test("v4 真实产品合成库：资产补项 5 列 / 期初累计 / 连续期间计提与总账 / 封账 / 导入批次来源 → backup→verify→restore→真实读取", () => {
    const built = buildV4Database();
    assert.ok(Number.isInteger(built.setId) && built.setId > 0, "v4 合成账套必须真实落库");
    assert.deepEqual(built.periods, [{ period: "2026-01", status: "closed" }, { period: "2026-02", status: "open" }],
      "前置：1 月必须真实封账，2 月保持 open");

    // ---- 15.1 真实 backup ----
    const backup = runCli(["backup", "--db", join(V4_DIR, "workbench.db"), "--out", V4_BACKUP]);
    assert.equal(backup.code, 0, `v4 备份应成功：${backup.stdout}${backup.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(join(V4_BACKUP, LB.MANIFEST_FILE), "utf8"));
    assert.equal(manifest.structure.schemaVersion, 4, "v4 库必须按 v4 契约备份");
    assert.equal(manifest.source.schemaVersion, 4);
    assert.deepEqual(manifest.structure.migrations, [1, 2, 3, 4]);

    // ---- 15.2 快照的真实结构：v3 列 + v4 只加的 5 列（类型 / NOT NULL / 默认值逐列一致） ----
    const snapshot = join(V4_BACKUP, LB.SNAPSHOT_FILE);
    assert.deepEqual(
      assetCardColumns(snapshot),
      [...V3_ASSET_COLUMNS, ...V4_ADDED_COLUMNS.map((c) => [c.name, c.type, c.notnull, c.dflt])],
      "v4 的 asset_cards 必须正好是 v3 列 + 5 个补项列，且默认值逐字一致",
    );

    // ---- 15.3 快照内的业务事实（金额 / 卡片补项 / 计提 / 批次来源 / 封账）与独立手算一致 ----
    const conn = openSnapshot(snapshot);
    try {
      const card = conn.prepare(
        `SELECT original_cost, residual_rate, useful_life_months, start_period, acquired_period,
                opening_accumulated, ledger_status, ledger_note, origin
           FROM asset_cards`,
      ).all();
      // node:sqlite 返回 null 原型对象：逐字段取成普通值再比较，避免原型差异进入断言。
      assert.deepEqual(card.map((row) => [
        row.original_cost, row.residual_rate, row.useful_life_months, row.start_period,
        row.acquired_period, row.opening_accumulated, row.ledger_status, row.ledger_note, row.origin,
      ]), [[120000, 0.05, 60, "2026-01", "2026-01", 24000, "booked", "", "supplement"]],
      "快照必须保留 5 个补项列的真实值（含期初累计）");
      assert.deepEqual(
        conn.prepare("SELECT period, amount, voucher_id IS NOT NULL AS has_voucher FROM asset_depreciation_runs ORDER BY period")
          .all().map((r) => [r.period, r.amount, Number(r.has_voucher)]),
        [["2026-01", 1900, 1], ["2026-02", 1900, 1]],
        "连续两个期间都必须有已过账计提",
      );
      assert.deepEqual(
        conn.prepare("SELECT period, status FROM periods ORDER BY period").all().map((r) => [r.period, r.status]),
        [["2026-01", "closed"], ["2026-02", "open"]],
        "快照必须保留封账状态",
      );
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_batches").get().n, 2);
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_voucher_sources").get().n, 4);
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_batch_vouchers").get().n, 4);
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM import_enterprise_account_sets").get().n, 1);
      assert.equal(conn.prepare("SELECT COALESCE(SUM(credit),0) c FROM voucher_entries WHERE code='1602'").get().c, 3800,
        "计提凭证贷记 1602 必须为 1900×2");
      assert.equal(conn.prepare("SELECT credit FROM opening_balances WHERE code='1602'").get().credit, 24000,
        "期初已入账累计折旧 24000 必须保留在期初表");
    } finally { conn.close(); }

    // ---- 15.4 真实 verify ----
    const verify = runCli(["verify", "--backup", V4_BACKUP]);
    assert.equal(verify.code, 0, `v4 verify 应通过：${verify.stdout}${verify.stderr}`);
    assert.equal(verify.json?.summary?.schemaVersion, 4);

    // ---- 15.5 真实 restore-new + 真实产品入口读取 ----
    const restore = runCli(["restore-new", "--backup", V4_BACKUP, "--target", V4_RESTORED]);
    assert.equal(restore.code, 0, `v4 恢复应成功：${restore.stdout}${restore.stderr}`);
    const receipt = JSON.parse(fs.readFileSync(join(V4_RESTORED, LB.RESTORE_RECEIPT_FILE), "utf8"));
    assert.equal(receipt.target.coreVersion, 4);
    assert.deepEqual(migrationFacts(join(V4_RESTORED,"workbench.db")).migrations,[1,2,3,4]);
    assert.equal(receipt.target.database.sha256, sha256File(join(V4_RESTORED, "workbench.db")));

    const facts = inspectRestoredV4(V4_RESTORED);
    assert.equal(facts.sets.length, 1);
    assert.equal(facts.sets[0].name, V4_META.name);
    assert.deepEqual(facts.openings, [
      ["1002", 400000, 0], ["1601", 120000, 0], ["1602", 0, 24000], ["3001", 0, 496000],
    ]);
    assert.deepEqual(facts.jan, EXPECTED_V4_JAN_BALANCE, "1 月余额必须与独立手算一致（含结转与计提）");
    assert.deepEqual(facts.feb, EXPECTED_V4_FEB_BALANCE, "2 月余额必须与独立手算一致");
    // 独立手算试算平衡（2 月）：期初只有 opening_balances 520000/520000；
    // 发生额从启用期间累计到 2 月：11300+2000+1900+10000+11300+3000+1900 = 41400；期末 531200。
    assert.deepEqual(facts.trialFeb, {
      opening_debit: 520000, opening_credit: 520000, period_debit: 41400, period_credit: 41400,
      closing_debit: 531200, closing_credit: 531200,
    }, "试算平衡必须自洽");
    assert.deepEqual(facts.vouchers, EXPECTED_V4_VOUCHERS, "凭证期间 / 号 / 种类 / 状态 / 金额必须一致");
    assert.deepEqual(facts.periods, [["2026-01", "closed"], ["2026-02", "open"]], "恢复后封账状态不变");
    assert.deepEqual(facts.cards, [{
      name: "合成生产设备", original_cost: 120000, residual_rate: 0.05, useful_life_months: 60,
      start_period: "2026-01", acquired_period: "2026-01", opening_accumulated: 24000,
      ledger_status: "booked", ledger_note: "", origin: "supplement",
      depreciable: 114000, monthly: 1900, final_month: 1900, accumulated: 27800, months_done: 2, remaining: 86200,
    }], "资产卡片 5 个补项列 + 累计 / 剩余 / 月额必须一致");
    assert.deepEqual(facts.runs.map((r) => [r[0], r[1]]), [["2026-02", 1900], ["2026-01", 1900]],
      "计提记录必须逐期保留");
    assert.equal(facts.batchJan.batch.status, "completed");
    assert.equal(facts.batchFeb.batch.status, "completed");
    assert.equal(facts.batchJan.source.enterpriseKey, V4_ENTERPRISE_KEY);
    assert.deepEqual(facts.batchJan.sourceTrace.map((i) => [i.sourceVoucherId, i.action, i.state]),
      [["SRC-V4-0001", "created", "ok"], ["SRC-V4-0002", "created", "ok"]]);
    assert.deepEqual(facts.batchFeb.sourceTrace.map((i) => [i.sourceVoucherId, i.action, i.state]),
      [["SRC-V4-0003", "created", "ok"], ["SRC-V4-0004", "created", "ok"]]);
    assert.equal(facts.batchState.enterpriseAccountSets.length, 1);
    assert.equal(facts.batchState.sourceBindings.length, 1);
    // 恢复后的库在期末检查下仍然自洽（计提完整 / 资产与总账对得上）；2 月未结转所以才 blocked。
    const stepsJan = Object.fromEntries(facts.stepsJan);
    assert.equal(stepsJan.depreciation, "ok", `1 月计提完整：${JSON.stringify(facts.stepsJan)}`);
    assert.equal(stepsJan.asset_reconciliation, "ok", `1 月资产与总账一致：${JSON.stringify(facts.stepsJan)}`);
    assert.equal(stepsJan.profit_carry_forward, "ok");
    const stepsFeb = Object.fromEntries(facts.stepsFeb);
    assert.equal(stepsFeb.depreciation, "ok");
    assert.equal(stepsFeb.asset_reconciliation, "ok");
    assert.equal(stepsFeb.profit_carry_forward, "blocked", "2 月损益未结转，恢复后仍必须如实报 blocking");

    // 恢复库不依赖任何 sidecar 也能被直接打开
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      assert.equal(fs.existsSync(join(V4_RESTORED, `workbench.db${suffix}`)), false);
    }
  });

  // ================================================================ 16. v4 恢复库上的真实后续操作
  await test("v4 恢复库可以继续真实记账与计提；已封账期间一律拒绝（不是只读快照）", () => {
    const facts = followUpOnRestoredV4(V4_RESTORED);
    assert.ok(Number.isInteger(facts.createdVoucherId), "恢复库必须能继续新增凭证");
    assert.equal(facts.closedPeriodWrite, "period_closed", "已封账期间写入必须被拒绝");
    assert.equal(facts.unpostDepreciation, "period_closed", "已封账期间的计提反过账必须被拒绝");
    assert.ok(Number.isInteger(facts.marchVoucherId), "后续期间必须能继续计提");
    assert.deepEqual(facts.marchRuns, [{ asset_id: 1, amount: 1900 }]);
    // 独立手算：2 月 1002 = 406300 + 500；5001 = -500；3 月 1602 = -(27800+1900)；5602 = 1900+1900。
    assert.equal(facts.feb1002, 406800);
    assert.equal(facts.feb5001, -500);
    assert.equal(facts.mar1602, -29700);
    assert.equal(facts.mar5602, 3800);
    assert.deepEqual(facts.periods, [["2026-01", "closed"], ["2026-02", "open"], ["2026-03", "open"]]);
    assert.equal(facts.vouchers, EXPECTED_V4_VOUCHERS.length + 2, "新增凭证 + 3 月计提凭证");
    assert.deepEqual(facts.cards, [[29700, 3, 84300]]);
  });

  // ================================================================ 17. v3 旧备份语义
  await test("v3 旧备份：只读验证不迁移备份 / 源库，恢复到全新目录仍为 v3，由产品入口显式升级到 v4 并记录实际差异", () => {
    const v3Source = join(ROOT, "v3-source.db");
    deriveV3Database(join(V4_BACKUP, LB.SNAPSHOT_FILE), v3Source);

    // 17.1 夹具自证：确实是 v3 结构（列 / 类型 / NOT NULL / 默认值 / 迁移记录），而不是「删了两行」
    assert.deepEqual(assetCardColumns(v3Source), V3_ASSET_COLUMNS,
      "派生的 v3 夹具必须正好是 v3 的 12 列且默认值一致");
    assert.deepEqual(migrationFacts(v3Source), { migrations: [1, 2, 3], backupVersions: [3] },
      "v3 夹具的迁移记录必须是从 1 连续到 3");
    const v3SchemaSql = (() => {
      const conn = openSnapshot(v3Source);
      try { return String(conn.prepare("SELECT sql FROM sqlite_master WHERE name='asset_cards'").get().sql); } finally { conn.close(); }
    })();
    for (const column of V4_ADDED_COLUMNS) {
      assert.equal(new RegExp(`\\b${column.name}\\b`).test(v3SchemaSql), false,
        `v3 的 asset_cards DDL 不得包含 v4 列 ${column.name}`);
    }

    // 17.2 当前工具仍能为 v3 库生成备份（v3 备份等价于旧工具产物：formatVersion 1 + schemaVersion 3）
    const v3Backup = join(ROOT, "backup-v3");
    const backup = runCli(["backup", "--db", v3Source, "--out", v3Backup]);
    assert.equal(backup.code, 0, `v3 备份应成功：${backup.stdout}${backup.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(join(v3Backup, LB.MANIFEST_FILE), "utf8"));
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.structure.schemaVersion, 3, "v3 库必须按 v3 契约备份，不得抬高为 4");
    assert.deepEqual(manifest.structure.migrations, [1, 2, 3]);
    assert.equal(manifest.source.schemaVersion, 3);
    assert.deepEqual(assetCardColumns(join(v3Backup, LB.SNAPSHOT_FILE)), V3_ASSET_COLUMNS);

    // 17.3 只读验证：源库与备份目录都不得被改动（不偷偷迁移原备份 / 源库）
    const sourceSha = sha256File(v3Source);
    const backupSignature = dirSignature(v3Backup);
    const verify = runCli(["verify", "--backup", v3Backup]);
    assert.equal(verify.code, 0, `v3 verify 应通过：${verify.stdout}${verify.stderr}`);
    assert.equal(verify.json?.summary?.schemaVersion, 3);
    assert.deepEqual(verify.json?.summary?.migrations, [1, 2, 3]);
    assert.equal(sha256File(v3Source), sourceSha, "验证不得修改源库");
    assert.deepEqual(dirSignature(v3Backup), backupSignature, "验证不得修改备份（不得就地迁移备份）");
    assert.deepEqual(migrationFacts(join(v3Backup, LB.SNAPSHOT_FILE)), { migrations: [1, 2, 3], backupVersions: [3] },
      "备份快照必须保持 v3 迁移记录");

    // 17.4 恢复到全新目录：仍是 v3（恢复不做迁移）
    const v3Target = join(ROOT, "restored-v3");
    const restore = runCli(["restore-new", "--backup", v3Backup, "--target", v3Target]);
    assert.equal(restore.code, 0, `v3 恢复应成功：${restore.stdout}${restore.stderr}`);
    assert.equal(restore.json?.receipt?.target?.coreVersion, 3);
    assert.deepEqual(migrationFacts(join(v3Target,"workbench.db")).migrations, [1,2,3]);
    assert.deepEqual(fs.readdirSync(v3Target).sort(), ["manifest.json", "restore.json", "workbench.db"]);
    assert.deepEqual(assetCardColumns(join(v3Target, "workbench.db")), V3_ASSET_COLUMNS,
      "恢复出来的 v3 库不得被偷偷加上 v4 列");
    assert.deepEqual(migrationFacts(join(v3Target, "workbench.db")).migrations, [1, 2, 3]);
    assert.deepEqual(migrationFacts(v3Source), { migrations: [1, 2, 3], backupVersions: [3] },
      "恢复不得改动源库");

    // 17.5 显式交给当前产品打开 → 走既有 v3→v4 迁移路径（这里才发生升级）
    const upgraded = runInDataDir(`
const { db } = await import(${JSON.stringify(MODULE_URLS.db)});
const A = await import(${JSON.stringify(MODULE_URLS.accounting)});
const IM = await import(${JSON.stringify(MODULE_URLS.importIncremental)});
const setId = A.listAccountSets()[0].id;
process.stdout.write(JSON.stringify({
  periods: A.listPeriods(setId).map((p) => [p.period, p.status]),
  cards: A.listAssetCards(setId).map((c) => [c.acquired_period, c.opening_accumulated, c.ledger_status, c.ledger_note, c.origin]),
  steps: A.periodEndCheck(setId, "2026-01").steps.map((s) => [s.id, s.status]),
  conflicts: A.periodEndCheck(setId, "2026-01").blocking.map((b) => b.code).sort(),
  batches: IM.importBatchState().batches.length,
}) + "\\n");
`, v3Target);
    assert.deepEqual(upgraded.periods, [["2026-01", "closed"], ["2026-02", "open"]], "升级不得改动封账状态");
    // 实际差异：v3 没有补项列，升级后按真实 DDL 默认值落成（不是凭空补出 24000 期初累计）。
    assert.deepEqual(upgraded.cards, [[null, 0, "booked", "", "purchase"]]);
    assert.deepEqual([...upgraded.conflicts].sort(), ["asset_accumulated_mismatch", "asset_acquired_period_missing"],
      `升级后的 v3→v4 卡片缺项必须如实报告，实际 ${JSON.stringify(upgraded.conflicts)}`);
    assert.equal(upgraded.batches, 2, "升级不得丢失导入批次");

    const upgradedFacts = migrationFacts(join(businessSeed4(v3Target), "workbench.db"));
    assert.deepEqual(upgradedFacts.migrations, [1, 2, 3, 4, 5], "产品入口必须把迁移记录推进到 4");
    assert.ok(upgradedFacts.backupVersions.includes(5), "升级前必须留下迁移前备份登记");
    assert.ok(fs.readdirSync(businessSeed4(v3Target)).some((name) => name.startsWith("workbench.db.pre-v5-")),
      "v3→v4 升级必须留下迁移前备份文件");
    assert.deepEqual(assetCardColumns(join(businessSeed4(v3Target), "workbench.db")),
      [...V3_ASSET_COLUMNS, ...V4_ADDED_COLUMNS.map((c) => [c.name, c.type, c.notnull, c.dflt])],
      "升级后的列必须与真实 v4 DDL 一致（含默认值）");

    // 17.6 升级后的库能被当前工具按 v4 备份 / 验证（旧 v3 备份与新 v4 备份共存）
    const upgradedBackup = join(ROOT, "backup-v3-upgraded");
    const upgradedResult = runCli(["backup", "--db", join(businessSeed4(v3Target), "workbench.db"), "--out", upgradedBackup]);
    assert.equal(upgradedResult.code, 0, `升级后的库应能按 v4 备份：${upgradedResult.stdout}${upgradedResult.stderr}`);
    const upgradedManifest = JSON.parse(fs.readFileSync(join(upgradedBackup, LB.MANIFEST_FILE), "utf8"));
    assert.equal(upgradedManifest.structure.schemaVersion, 5);
    assert.deepEqual(upgradedManifest.structure.migrations, [1, 2, 3, 4, 5]);
    assert.equal(runCli(["verify", "--backup", upgradedBackup]).code, 0);
    // 旧 v3 备份仍然只读可用
    assert.equal(runCli(["verify", "--backup", v3Backup]).code, 0);
    assert.deepEqual(dirSignature(v3Backup), backupSignature, "再次验证不得改动 v3 备份");
  });

  // ================================================================ 18. 伪 v4 / 未知组件 / 未来版本
  await test("伪报 v4（只抬版本号 / 缺列 / 错默认值 / 错 null / 错类型）/ 未知组件 / 未来版本 / 不连续迁移记录一律拒绝，且不改源库、不留半成品", () => {
    const v4Snapshot = join(V4_BACKUP, LB.SNAPSHOT_FILE);
    const assertSourceRejected = (file, code, kinds = []) => {
      const out = join(ROOT, `out-v4-${Math.random().toString(16).slice(2)}`);
      const before = sha256File(file);
      const result = runCli(["backup", "--db", file, "--out", out]);
      assertRejected(result, code);
      const details = JSON.stringify(result.json?.details ?? {});
      for (const kind of kinds) assert.ok(details.includes(kind), `拒绝明细应含 ${kind}，实际 ${details}`);
      assert.equal(fs.existsSync(out), false, "被拒绝的源库不得留下备份目录");
      assert.equal(sha256File(file), before, "被拒绝时源库必须完全不变");
      return result;
    };

    // 18.1 只把版本号抬高（真 v3 结构 + 一条 version=4 迁移记录）——不得被当成 v4
    const v3Only = join(ROOT, "v3-claimed-v4.db");
    deriveV3Database(v4Snapshot, v3Only);
    const claimedWriter = new DatabaseSync(v3Only);
    claimedWriter.prepare("INSERT INTO schema_migrations (version, applied_at, note) VALUES (?,?,?)")
      .run(4, "2026-10-22T00:00:00.000Z", "claimed v4");
    claimedWriter.prepare("INSERT INTO schema_backups (version, path, created_at, integrity) VALUES (?,?,?,?)")
      .run(4, "workbench.db.pre-v4-fake.bak", "2026-10-22T00:00:00.000Z", "ok");
    claimedWriter.close();
    assertSourceRejected(v3Only, "source_structure_invalid", ["missing_columns"]);

    // v4 的真实列清单（用于重建伪结构时保持其余列不变）
    const v4ColumnDdl = [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      "account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE",
      "kind TEXT NOT NULL DEFAULT 'fixed'",
      "name TEXT NOT NULL",
      "original_cost REAL NOT NULL",
      "residual_rate REAL NOT NULL DEFAULT 0.05",
      "useful_life_months INTEGER NOT NULL",
      "start_period TEXT NOT NULL",
      "asset_account TEXT NOT NULL",
      "accum_account TEXT NOT NULL",
      "expense_account TEXT NOT NULL DEFAULT '5602'",
      "created_at TEXT NOT NULL",
    ];
    const rebuildAssetCards = (overrides) => {
      const columns = [...v4ColumnDdl];
      for (const [index, ddl] of Object.entries(overrides)) columns[Number(index)] = ddl;
      return `
        CREATE TABLE asset_cards_x (${columns.join(",")});
        INSERT INTO asset_cards_x (id, account_set_id, kind, name, original_cost, residual_rate,
          useful_life_months, start_period, asset_account, accum_account, expense_account, created_at)
          SELECT id, account_set_id, kind, name, original_cost, residual_rate,
            useful_life_months, start_period, asset_account, accum_account, expense_account, created_at FROM asset_cards;
        DROP TABLE asset_cards;
        ALTER TABLE asset_cards_x RENAME TO asset_cards;
      `;
    };
    // 18.2 缺一列（ledger_note）
    const missingColumn = tamperedDatabase("v4-missing-ledger-note", rebuildAssetCards({}), v4Snapshot);
    assertSourceRejected(missingColumn, "source_structure_invalid", ["missing_columns", "ledger_note"]);
    // 18.3 默认值错（ledger_status 默认 'pending'）
    const wrongDefault = tamperedDatabase("v4-wrong-default", rebuildAssetCards({
      12: "acquired_period TEXT",
      13: "opening_accumulated REAL NOT NULL DEFAULT 0",
      14: "ledger_status TEXT NOT NULL DEFAULT 'pending'",
      15: "ledger_note TEXT NOT NULL DEFAULT ''",
      16: "origin TEXT NOT NULL DEFAULT 'purchase'",
    }), v4Snapshot);
    assertSourceRejected(wrongDefault, "source_structure_invalid", ["column_default", "ledger_status"]);
    // 18.4 null 约束错（acquired_period 变成 NOT NULL DEFAULT ''）
    const wrongNull = tamperedDatabase("v4-wrong-null", rebuildAssetCards({
      12: "acquired_period TEXT NOT NULL DEFAULT ''",
      13: "opening_accumulated REAL NOT NULL DEFAULT 0",
      14: "ledger_status TEXT NOT NULL DEFAULT 'booked'",
      15: "ledger_note TEXT NOT NULL DEFAULT ''",
      16: "origin TEXT NOT NULL DEFAULT 'purchase'",
    }), v4Snapshot);
    assertSourceRejected(wrongNull, "source_structure_invalid", ["column_not_null", "acquired_period"]);
    // 18.5 类型错（opening_accumulated 变成 TEXT）
    const wrongType = tamperedDatabase("v4-wrong-type", rebuildAssetCards({
      12: "acquired_period TEXT",
      13: "opening_accumulated TEXT NOT NULL DEFAULT '0'",
      14: "ledger_status TEXT NOT NULL DEFAULT 'booked'",
      15: "ledger_note TEXT NOT NULL DEFAULT ''",
      16: "origin TEXT NOT NULL DEFAULT 'purchase'",
    }), v4Snapshot);
    assertSourceRejected(wrongType, "source_structure_invalid", ["column_type", "opening_accumulated"]);

    // 18.6 未知组件（未来 bank / batch / audit 表）不得被当成已支持
    const unknownComponent = tamperedDatabase("v4-unknown-component",
      "CREATE TABLE bank_statements (id INTEGER PRIMARY KEY, account_set_id INTEGER NOT NULL, amount REAL)",
      v4Snapshot);
    assertSourceRejected(unknownComponent, "source_structure_invalid", ["unexpected_tables", "bank_statements"]);

    // 18.7 未来版本（v5 迁移记录）→ schema_unsupported
    const futureVersion = tamperedDatabase("v4-future",
      "INSERT INTO schema_migrations (version, applied_at, note) VALUES (6,'2027-01-01T00:00:00.000Z','future')",
      v4Snapshot);
    assertSourceRejected(futureVersion, "schema_unsupported");

    // 18.8 迁移记录不连续（1,2,4）→ migrations_gap
    const migrationGap = tamperedDatabase("v4-migration-gap", "DELETE FROM schema_migrations WHERE version = 3", v4Snapshot);
    assertSourceRejected(migrationGap, "source_structure_invalid", ["migrations_gap"]);

    // 18.9 快照侧：把快照换成伪结构并**同步重算清单字节数与 sha256**，仍必须被真实结构校验拦住
    for (const [label, file, kind] of [
      ["missing-column", missingColumn, "missing_columns"],
      ["wrong-default", wrongDefault, "column_default"],
      ["unknown-component", unknownComponent, "unexpected_tables"],
    ]) {
      const dir = join(ROOT, `backup-v4-${label}`);
      fs.cpSync(V4_BACKUP, dir, { recursive: true });
      replaceSnapshot(dir, file);
      const verify = runCli(["verify", "--backup", dir]);
      assertRejected(verify, "structure_invalid");
      assert.ok(JSON.stringify(verify.json?.details ?? {}).includes(kind),
        `快照拒绝明细应含 ${kind}，实际 ${JSON.stringify(verify.json?.details)}`);
      const target = join(ROOT, `t-v4-${label}`);
      assertRejected(runCli(["restore-new", "--backup", dir, "--target", target]), "structure_invalid");
      assert.equal(fs.existsSync(target), false, "伪兼容备份不得被恢复（不得留半成品目标）");
    }

    // 18.10 清单层面：自报 v4 但迁移记录与 v4 不符；自报未来版本
    const manifestBad = join(ROOT, "backup-v4-manifest-bad");
    fs.cpSync(V4_BACKUP, manifestBad, { recursive: true });
    mutateManifest(manifestBad, (m) => { m.structure.migrations = [1, 2, 3]; });
    assertRejected(runCli(["verify", "--backup", manifestBad]), "manifest_invalid");
    const manifestFuture = join(ROOT, "backup-v4-manifest-future");
    fs.cpSync(V4_BACKUP, manifestFuture, { recursive: true });
    mutateManifest(manifestFuture, (m) => { m.structure.schemaVersion = 6; m.source.schemaVersion = 6; });
    assertRejected(runCli(["verify", "--backup", manifestFuture]), "schema_unsupported");

    // 18.11 反向伪造：v4 结构却只声称 v3（删掉迁移记录 4）——不得被当成 v3 放行
    const claimedV3 = tamperedDatabase("v4-claimed-v3", "DELETE FROM schema_migrations WHERE version = 4", v4Snapshot);
    assertSourceRejected(claimedV3, "source_structure_invalid", ["unexpected_columns"]);
  });

  // ================================================================ 19. 唯一性键比较语义（v4）
  await test("唯一性键比较语义：NOCASE / RTRIM / 主键文字键 / 键列顺序 / 升降序 / 表达式 / 部分索引 / 额外与重复唯一索引在源库与重算摘要的快照都被拒绝", () => {
    // 独立复现（银行候选、继承自旧版本的核心缺陷）：只把 import_voucher_sources 表级 UNIQUE 的
    // 最后一列改成 COLLATE NOCASE，列 / 默认值 / 外键全部不变，旧版本 create / verify / restore 全部放行；
    // 而恢复后真实 IM 已存 Ref-A 再 append ref-a 会撞收敛（正常 BINARY 对照是 applied 且两条）。
    // 下面用同一份真实快照的变体重算清单字节数与 sha256，确认只有唯一性键的**完整比较语义**能拦住它。
    const v4Snapshot = join(BACKUP_DIR, LB.SNAPSHOT_FILE);
    const assertSourceRejected = (dbFile, code, kinds = []) => {
      const before = sha256File(dbFile);
      const out = join(ROOT, `out-key-${Math.random().toString(16).slice(2)}`);
      const result = runCli(["backup", "--db", dbFile, "--out", out]);
      assertRejected(result, code);
      assert.equal(fs.existsSync(out), false, "唯一性语义不符的源库不得创建备份目录");
      assert.equal(sha256File(dbFile), before, "被拒绝时源库必须完全不变");
      const details = JSON.stringify(result.json?.details ?? {});
      for (const kind of kinds) assert.ok(details.includes(kind), `拒绝明细应含 ${kind}，实际 ${details}`);
      // 错误不得回显 SQL / 本机路径 / 业务原值。
      for (const forbidden of ["CREATE TABLE", "COLLATE", "SELECT ", ROOT, META.name, ENTERPRISE_KEY]) {
        assert.equal(details.includes(forbidden), false, `拒绝明细不得回显 ${forbidden}：${details}`);
      }
      return result;
    };
    const assertSnapshotRejected = (label, file, kinds) => {
      const dir = copyBackup();
      replaceSnapshot(dir, file);
      const manifest = JSON.parse(fs.readFileSync(join(dir, LB.MANIFEST_FILE), "utf8"));
      assert.equal(manifest.snapshot.sha256, sha256File(join(dir, LB.SNAPSHOT_FILE)),
        "前置条件：清单字节数与 sha256 已跟着变体重算（摘要本身自洽）");
      const verify = runCli(["verify", "--backup", dir]);
      assertRejected(verify, "structure_invalid");
      const details = JSON.stringify(verify.json?.details ?? {});
      for (const kind of kinds) assert.ok(details.includes(kind), `快照拒绝明细应含 ${kind}，实际 ${details}`);
      const target = join(ROOT, `t-key-${label}`);
      assertRejected(runCli(["restore-new", "--backup", dir, "--target", target]), "structure_invalid");
      assert.equal(fs.existsSync(target), false, "唯一性语义不符的备份不得被恢复（不得留半成品目标）");
      return details;
    };

    // ---- 变体 1 / 2：真实表级 UNIQUE 的最后一列改 COLLATE NOCASE / RTRIM ----
    const voucherSourcesDdl = (uniqueClause) => `
      CREATE TABLE import_voucher_sources_x (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_system TEXT NOT NULL,
        enterprise_key TEXT NOT NULL,
        source_voucher_id TEXT NOT NULL,
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        voucher_id INTEGER NOT NULL,
        voucher_fingerprint TEXT NOT NULL DEFAULT '',
        content_fingerprint TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ${uniqueClause}
      );
      INSERT INTO import_voucher_sources_x SELECT * FROM import_voucher_sources;
      DROP TABLE import_voucher_sources;
      ALTER TABLE import_voucher_sources_x RENAME TO import_voucher_sources;
    `;
    // 等价重建（除比较规则外逐字相同）必须被放行：证明拒绝来自比较语义，不是重建 / 重命名本身。
    const identicalRebuild = tamperedDatabase("unique-identical",
      voucherSourcesDdl("UNIQUE (source_system, enterprise_key, source_voucher_id)"));
    const identicalOut = join(ROOT, "out-unique-identical");
    const identicalResult = runCli(["backup", "--db", identicalRebuild, "--out", identicalOut]);
    assert.equal(identicalResult.code, 0,
      `与真实 DDL 同义的重建不得被拒绝：${identicalResult.stdout}${identicalResult.stderr}`);
    assert.equal(runCli(["verify", "--backup", identicalOut]).code, 0, "同义重建库的备份必须可验证");

    // 前置条件：NOCASE 变体真的改变了业务（真实 SQLite 行为），不是「无害的结构差异」。
    const nocaseVariant = tamperedDatabase("unique-nocase",
      voucherSourcesDdl("UNIQUE (source_system, enterprise_key, source_voucher_id COLLATE NOCASE)"));
    const rtrimVariant = tamperedDatabase("unique-rtrim",
      voucherSourcesDdl("UNIQUE (source_system, enterprise_key, source_voucher_id COLLATE RTRIM)"));
    const sourceVoucherIds = (file) => {
      const conn = openSnapshot(file);
      try {
        return conn.prepare("SELECT source_voucher_id FROM import_voucher_sources ORDER BY id").all()
          .map((row) => String(row.source_voucher_id));
      } finally { conn.close(); }
    };
    const originalIds = sourceVoucherIds(v4Snapshot);
    assert.deepEqual(sourceVoucherIds(nocaseVariant), originalIds, "变体不得改动已有数据（否则内容摘要就能拦住）");
    const probeNocase = new DatabaseSync(nocaseVariant);
    try {
      probeNocase.exec("BEGIN");
      try {
        assert.throws(() => probeNocase.exec(`INSERT INTO import_voucher_sources
          (source_system, enterprise_key, source_voucher_id, account_set_id, voucher_id,
           content_fingerprint, batch_id, created_at)
          SELECT source_system, enterprise_key, lower(source_voucher_id), account_set_id, voucher_id,
                 content_fingerprint, batch_id, created_at FROM import_voucher_sources LIMIT 1`),
        /UNIQUE constraint failed/,
        "前置条件：NOCASE 下只差大小写的来源凭证 ID 必须撞唯一约束（这正是必须拒绝它的原因）");
      } finally { probeNocase.exec("ROLLBACK"); }
    } finally { probeNocase.close(); }
    const controlProbe = new DatabaseSync(v4Snapshot);
    try {
      // 正常对照：BINARY 下小写形式不命中已存的同字母大写来源 ID（两套语义在业务上确实不同）。
      assert.ok(originalIds.some((id) => id !== id.toLowerCase()), "前置条件：快照里应有含大写的来源 ID");
      const hits = controlProbe.prepare(
        "SELECT COUNT(*) AS n FROM import_voucher_sources WHERE source_voucher_id = lower(?)",
      ).get(originalIds[0]);
      assert.equal(Number(hits.n), 0, "对照：BINARY 下大小写不同的来源 ID 不互相命中");
    } finally { controlProbe.close(); }

    // ---- 变体 3：主键里的文字键比较规则（opening_balances 的 code 是主键文字列）----
    const pkNocase = tamperedDatabase("unique-pk-nocase", `
      CREATE TABLE opening_balances_x (
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        code TEXT COLLATE NOCASE NOT NULL,
        debit REAL NOT NULL DEFAULT 0,
        credit REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (account_set_id, code)
      );
      INSERT INTO opening_balances_x SELECT * FROM opening_balances;
      DROP TABLE opening_balances;
      ALTER TABLE opening_balances_x RENAME TO opening_balances;
    `);

    // ---- 变体 4：主键键列降序（真实 DDL 是升序）----
    const pkDesc = tamperedDatabase("unique-pk-desc", `
      CREATE TABLE periods_x (
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY (account_set_id, period DESC)
      );
      INSERT INTO periods_x SELECT * FROM periods;
      DROP TABLE periods;
      ALTER TABLE periods_x RENAME TO periods;
    `);

    // ---- 变体 5：UNIQUE 键列顺序反转（(code, account_set_id) 是另一条约束）----
    const reversedUnique = tamperedDatabase("unique-reversed", `
      CREATE TABLE accounts_x (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,
        contra INTEGER NOT NULL DEFAULT 0, is_leaf INTEGER NOT NULL DEFAULT 1,
        UNIQUE (code, account_set_id)
      );
      INSERT INTO accounts_x SELECT * FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_x RENAME TO accounts;
    `);

    // ---- 变体 6：把 v1 已删除的旧命名唯一索引加回来（现结构没有它，不得按旧 DDL 认）----
    const resurrectedIndex = tamperedDatabase("unique-resurrected",
      "CREATE UNIQUE INDEX idx_import_bindings_set ON import_source_bindings (enterprise_key, source_system)");

    // ---- 变体 7：同一唯一键再声明一次（origin=c 的命名重复）----
    const duplicateUnique = tamperedDatabase("unique-duplicate",
      "CREATE UNIQUE INDEX ux_voucher_source_dup ON import_voucher_sources (source_system, enterprise_key, source_voucher_id)");

    // ---- 变体 8 / 9：表达式唯一索引 / 部分唯一索引 ----
    const expressionUnique = tamperedDatabase("unique-expression", "CREATE UNIQUE INDEX ux_expr ON vouchers ((id + 0))");
    const partialUnique = tamperedDatabase("unique-partial",
      "CREATE UNIQUE INDEX ux_partial ON vouchers (account_set_id, period, word, number) WHERE status = 'posted'");

    // ---- 变体 10：INTEGER PRIMARY KEY DESC（不再是 rowid 别名，另建了降序主键索引）----
    const rowidDesc = tamperedDatabase("unique-rowid-desc", `
      CREATE TABLE vouchers_x (
        id INTEGER PRIMARY KEY DESC,
        account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
        period TEXT NOT NULL, voucher_date TEXT NOT NULL, word TEXT NOT NULL DEFAULT '记',
        number INTEGER NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal'
      );
      INSERT INTO vouchers_x SELECT * FROM vouchers;
      DROP TABLE vouchers;
      ALTER TABLE vouchers_x RENAME TO vouchers;
    `);

    const variants = [
      ["nocase", nocaseVariant, ["unique", "import_voucher_sources", "NOCASE", "semantics"]],
      ["rtrim", rtrimVariant, ["unique", "import_voucher_sources", "RTRIM"]],
      ["pk-nocase", pkNocase, ["unique", "opening_balances", "pk", "NOCASE"]],
      ["pk-desc", pkDesc, ["unique", "periods", "pk"]],
      ["reversed", reversedUnique, ["unique", "unexpected_unique_index", "accounts"]],
      ["resurrected", resurrectedIndex, ["unexpected_unique_index", "import_source_bindings"]],
      ["duplicate", duplicateUnique, ["unexpected_unique_index", "import_voucher_sources"]],
      ["expression", expressionUnique, ["unexpected_unique_index", "expression"]],
      ["partial", partialUnique, ["unexpected_unique_index", "vouchers"]],
      ["rowid-desc", rowidDesc, ["rowid_alias", "vouchers"]],
    ];
    for (const [label, file, kinds] of variants) {
      // 19.1 源库入口
      const sourceResult = assertSourceRejected(file, "source_structure_invalid", kinds);
      // 表达式索引的拒绝明细不得回显表达式原文
      if (label === "expression") {
        assert.equal(JSON.stringify(sourceResult.json?.details ?? {}).includes("id + 0"), false,
          "拒绝明细不得回显索引表达式原文");
      }
      // 19.2 快照入口：重算字节数与 sha256 后仍被真实结构校验拦住
      assertSnapshotRejected(label, file, kinds);
    }

    // 19.3 正常索引不误拒绝：额外**非唯一**查询索引不改变唯一性 / 去重语义，不得据此拒绝
    const perfIndex = tamperedDatabase("unique-perf-index", "CREATE INDEX ux_perf ON vouchers (period)");
    const perfOut = join(ROOT, "out-perf-index");
    const perfResult = runCli(["backup", "--db", perfIndex, "--out", perfOut]);
    assert.equal(perfResult.code, 0, `非唯一索引不得被误拒：${perfResult.stdout}${perfResult.stderr}`);
    assert.equal(runCli(["verify", "--backup", perfOut]).code, 0, "带非唯一索引的合法备份必须可验证");
    // 19.4 真实 v4 备份本身仍正常（没有把正常结构误判成额外唯一索引），且清单格式未变
    assert.equal(runCli(["verify", "--backup", BACKUP_DIR]).code, 0, "真实 v4 备份必须继续通过");
    const realManifest = JSON.parse(fs.readFileSync(join(BACKUP_DIR, LB.MANIFEST_FILE), "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(realManifest, "indexes"), false,
      "清单格式未变：不新增索引字段（防止旧清单结构摘要无故失配）");
    assert.deepEqual(realManifest.structure.tables, [...realManifest.structure.tables].sort(),
      "清单结构字段仍只有原有的版本 / 迁移 / 表清单");
  });

  // ================================================================ 20. 唯一性键比较语义（v3 旧快照）
  await test("v3 旧快照的唯一性语义变体（NOCASE / 主键文字键 / 复活旧命名唯一索引）同样拒绝且不产恢复目标", () => {
    const v3Source = join(ROOT, "v3-key-source.db");
    deriveV3Database(join(V4_BACKUP, LB.SNAPSHOT_FILE), v3Source);
    const v3Backup = join(ROOT, "backup-v3-key");
    const backup = runCli(["backup", "--db", v3Source, "--out", v3Backup]);
    assert.equal(backup.code, 0, `v3 对照备份应成功：${backup.stdout}${backup.stderr}`);
    const v3Snapshot = join(v3Backup, LB.SNAPSHOT_FILE);
    assert.equal(JSON.parse(fs.readFileSync(join(v3Backup, LB.MANIFEST_FILE), "utf8")).structure.schemaVersion, 3);

    const variants = [
      ["v3-nocase", `
        CREATE TABLE import_voucher_sources_x (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_system TEXT NOT NULL, enterprise_key TEXT NOT NULL,
          source_voucher_id TEXT NOT NULL,
          account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
          voucher_id INTEGER NOT NULL,
          voucher_fingerprint TEXT NOT NULL DEFAULT '',
          content_fingerprint TEXT NOT NULL, batch_id TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE (source_system, enterprise_key, source_voucher_id COLLATE NOCASE)
        );
        INSERT INTO import_voucher_sources_x SELECT * FROM import_voucher_sources;
        DROP TABLE import_voucher_sources;
        ALTER TABLE import_voucher_sources_x RENAME TO import_voucher_sources;
      `, ["unique", "import_voucher_sources", "NOCASE"]],
      ["v3-pk-nocase", `
        CREATE TABLE opening_balances_x (
          account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
          code TEXT COLLATE NOCASE NOT NULL, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (account_set_id, code)
        );
        INSERT INTO opening_balances_x SELECT * FROM opening_balances;
        DROP TABLE opening_balances;
        ALTER TABLE opening_balances_x RENAME TO opening_balances;
      `, ["unique", "opening_balances", "NOCASE"]],
      ["v3-resurrected",
        "CREATE UNIQUE INDEX idx_import_bindings_set ON import_source_bindings (enterprise_key, source_system)",
        ["unexpected_unique_index", "import_source_bindings"]],
    ];
    for (const [label, statements, kinds] of variants) {
      const file = tamperedDatabase(label, statements, v3Snapshot);
      const out = join(ROOT, `out-${label}`);
      const sourceResult = runCli(["backup", "--db", file, "--out", out]);
      assertRejected(sourceResult, "source_structure_invalid");
      const sourceDetails = JSON.stringify(sourceResult.json?.details ?? {});
      for (const kind of kinds) assert.ok(sourceDetails.includes(kind), `${label} 应含 ${kind}，实际 ${sourceDetails}`);
      assert.equal(fs.existsSync(out), false, "v3 变体源库不得创建备份目录");

      const dir = join(ROOT, `backup-${label}`);
      fs.cpSync(v3Backup, dir, { recursive: true });
      replaceSnapshot(dir, file);
      const verify = runCli(["verify", "--backup", dir]);
      assertRejected(verify, "structure_invalid");
      const verifyDetails = JSON.stringify(verify.json?.details ?? {});
      for (const kind of kinds) assert.ok(verifyDetails.includes(kind), `${label} 快照应含 ${kind}，实际 ${verifyDetails}`);
      assert.ok(verifyDetails.includes("\"schemaVersion\":3"), `v3 拒绝明细应指向 3，实际 ${verifyDetails}`);
      const target = join(ROOT, `t-${label}`);
      assertRejected(runCli(["restore-new", "--backup", dir, "--target", target]), "structure_invalid");
      assert.equal(fs.existsSync(target), false, "v3 变体备份不得被恢复");
    }
    // 正常对照：未变形的 v3 备份仍然可验证 / 可恢复
    assert.equal(runCli(["verify", "--backup", v3Backup]).code, 0, "真实 v3 备份必须继续通过");
    const controlTarget = join(ROOT, "t-v3-key-control");
    assert.equal(runCli(["restore-new", "--backup", v3Backup, "--target", controlTarget]).code, 0,
      "真实 v3 备份必须继续可恢复");
  });
  await test("v5 profile exact column contract: missing/type/null/default/claimed version rejected in source and recomputed manifest", () => {
    for (const [label, sql] of [
      ["missing", "ALTER TABLE account_sets DROP COLUMN accounting_profile_id"],
      ["type", "ALTER TABLE account_sets DROP COLUMN accounting_profile_id; ALTER TABLE account_sets ADD COLUMN accounting_profile_id INTEGER NOT NULL DEFAULT 'legacy-small-coa-v1'"],
      ["null", "ALTER TABLE account_sets DROP COLUMN accounting_profile_id; ALTER TABLE account_sets ADD COLUMN accounting_profile_id TEXT DEFAULT 'legacy-small-coa-v1'"],
      ["default", "ALTER TABLE account_sets DROP COLUMN accounting_profile_id; ALTER TABLE account_sets ADD COLUMN accounting_profile_id TEXT NOT NULL DEFAULT 'small-2011-basic-v1'"],
    ]) {
      const file = tamperedDatabase("v5-profile-" + label, sql);
      const output = join(ROOT, "v5-rejected-" + label);
      const before = sha256File(file);
      assert.equal(LB.createBackup({ dbPath: file, outDir: output }).code, "source_structure_invalid");
      assert.equal(sha256File(file), before); assert.equal(fs.existsSync(output), false);
      const dir = copyBackup(); replaceSnapshot(dir, file);
      assert.equal(LB.verifyBackup({ backupDir: dir }).code, "structure_invalid");
      const targetDir = join(ROOT, "v5-rejected-target-" + label);
      assert.equal(LB.restoreNew(R4({ backupDir: dir, targetDir })).code, "structure_invalid");
      assert.equal(fs.existsSync(targetDir), false);
    }
    const false5 = tamperedDatabase("v4-false5", "INSERT INTO schema_migrations(version,applied_at,note) VALUES(5,'2026-01-01T00:00:00.000Z','synthetic claim')", join(V4_BACKUP, LB.SNAPSHOT_FILE));
    assert.equal(LB.createBackup({ dbPath: false5, outDir: join(ROOT, "false5-out") }).code, "source_structure_invalid");
  });

  // Explicit cross product: historical core versions and optional exact bank component.
  for (const coreVersion of [3, 4, 5]) for (const bankVersion of [0, 1]) {
    await test(`core${coreVersion} × bank${bankVersion}: true backup→verify→restore and content equality`, async () => {
      const name = `matrix-v${coreVersion}-bank${bankVersion}`;
      const sourceDir = join(ROOT, name); fs.mkdirSync(sourceDir);
      const file = join(sourceDir, "workbench.db");
      const base = coreVersion === 5 ? join(BACKUP_DIR, LB.SNAPSHOT_FILE) : join(V4_BACKUP, LB.SNAPSHOT_FILE);
      if (coreVersion === 3) deriveV3Database(base, file); else fs.copyFileSync(base, file);
      const conn = new DatabaseSync(file);
      try {
        if (bankVersion) {
          const bank = await import("../server/bank-storage.mjs");
          await bank.ensureBankSchema(conn, { dbPath: file, dataDir: sourceDir, backupService: LB });
          const setId = conn.prepare("SELECT id FROM account_sets ORDER BY id LIMIT 1").get().id;
          bank.insertBankAccount(conn, { accountSetId: setId, bankAccountId: "SYNTHETIC-BANK-01", sourceId: "SYNTHETIC-SOURCE-01", currency: "CNY", glAccountCode: "1002" });
          assert.equal(bank.bankSchemaContract(conn).ok, true);
          assert.equal(conn.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'bank_%'").get().n, 19);
        }
      } finally { conn.close(); }
      const backupDir = join(ROOT, name + "-backup"), targetDir = join(ROOT, name + "-restored");
      const backup = LB.createBackup({ dbPath: file, outDir: backupDir }); assert.equal(backup.ok, true, JSON.stringify(backup));
      assert.equal(LB.verifyBackup({ backupDir }).ok, true);
      const restored = LB.restoreNew(R4({ backupDir, targetDir })); assert.equal(restored.ok, true, JSON.stringify(restored));
      const raw = new DatabaseSync(file, { readOnly: true });
      const dst = new DatabaseSync(join(targetDir, "workbench.db"), { readOnly: true });
      try {
        const names = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
        for (const table of names.filter(t=>!["audit_database_instances","local_batch_database_instances","local_batch_job_bindings","local_batch_input_bindings","local_batch_locks","local_batch_lock_epochs","local_batch_stages"].includes(t))) assert.deepEqual(dst.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(), raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(), table);
        assert.equal(S.schemaVersion(dst), coreVersion);
        assert.equal(dst.prepare("SELECT debit FROM opening_balances WHERE code='1002'").get().debit, coreVersion === 5 ? 100000 : 400000);
        assert.equal(dst.prepare("SELECT COUNT(*) n FROM import_voucher_sources").get().n, 4);
      } finally { raw.close(); dst.close(); }
      if (bankVersion) {
        for (const [label, sql] of [
          ["missing", "DROP TABLE bank_reconcile_runs"],
          ["future", "UPDATE bank_component_migrations SET version=2"],
          ["extra-index", "CREATE INDEX synthetic_bank_extra ON bank_accounts(currency)"],
          ["trigger", "CREATE TRIGGER synthetic_bank_trigger AFTER INSERT ON bank_accounts BEGIN SELECT 1; END"],
          ["partial-ref", "DROP INDEX idx_bank_txn_ref; CREATE UNIQUE INDEX idx_bank_txn_ref ON bank_transactions(account_set_id,bank_account_id,source_id,bank_ref_id) WHERE bank_ref_id IS NOT NULL AND bank_ref_id<>''"],
          ["partial-txn", "DROP INDEX idx_bank_matches_active_txn; CREATE UNIQUE INDEX idx_bank_matches_active_txn ON bank_matches(transaction_id) WHERE status<>'rejected'"],
          ["partial-entry", "DROP INDEX idx_bank_matches_active_entry; CREATE UNIQUE INDEX idx_bank_matches_active_entry ON bank_matches(account_set_id,entry_id) WHERE status<>'rejected'"],
        ]) {
          const mutant = tamperedDatabase(name + "-" + label, sql, join(backupDir, LB.SNAPSHOT_FILE));
          const badBackup = join(ROOT, name + "-" + label + "-bad-backup");
          fs.cpSync(backupDir, badBackup, { recursive: true }); replaceSnapshot(badBackup, mutant);
          assert.equal(LB.verifyBackup({ backupDir: badBackup }).ok, false, label);
          const rejectedTarget = join(ROOT, name + "-" + label + "-bad-target");
          assert.equal(LB.restoreNew(R4({ backupDir: badBackup, targetDir: rejectedTarget })).ok, false, label);
          assert.equal(fs.existsSync(rejectedTarget), false);
          assert.equal(LB.createBackup({ dbPath: mutant, outDir: join(ROOT, name + "-" + label + "-bad-out") }).ok, false, label);
        }
      }
      // Real product entry performs the upgrade only after a version-preserving restore.
      const facts = runInDataDir(`
const { db } = await import(${JSON.stringify(MODULE_URLS.db)});
process.stdout.write(JSON.stringify({ version: db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,
 profiles: db.prepare("SELECT accounting_profile_id FROM account_sets").all().map(r => r.accounting_profile_id),
 backups: db.prepare("SELECT version,path FROM schema_backups").all() }) + "\\n");
db.close();
`, targetDir);
      assert.equal(facts.version, 5);
      if (coreVersion < 5) {
        assert.ok(facts.profiles.every(profile => profile === "legacy-small-coa-v1"));
        const before5 = facts.backups.find(row => row.version === 5); assert.ok(before5);
        const pre = new DatabaseSync(before5.path, { readOnly: true });
        try { assert.equal(S.schemaVersion(pre), coreVersion); assert.equal(pre.prepare("PRAGMA table_info(account_sets)").all().some(c => c.name === "accounting_profile_id"), false); }
        finally { pre.close(); }
      }
      const upgradedBackup = join(ROOT, name + "-upgraded-backup");
      assert.equal(LB.createBackup({ dbPath: join(targetDir, "workbench.db"), outDir: upgradedBackup }).ok, true);
      assert.equal(LB.verifyBackup({ backupDir: upgradedBackup }).ok, true);
      assert.equal(LB.restoreNew(R4({ backupDir: upgradedBackup, targetDir: join(ROOT, name + "-upgraded-restored") })).ok, true);
      console.log(`    matrix evidence: ${name}; openingCash=${coreVersion === 5 ? 100000 : 400000}; sourceVoucherIds=4; upgraded=5`);
    });
  }

} catch (error) {
  console.error("测试初始化失败：", error);
  results.push([false, "初始化"]);
} finally {
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
  try { db?.close(); } catch { /* ignore */ }
  try { if (!failed && process.env.WORKBENCH_TEST_KEEP_FIXTURES !== "1") fs.rmSync(ROOT, { recursive: true, force: true }); else console.log(`保留合成夹具：${ROOT}`); } catch { /* ignore */ }
}
