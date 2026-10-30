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
import { ensureImportSchema } from '../server/import-storage.mjs';
import { COA } from '../server/coa.mjs';
/**
 * LOCAL-04 / LOCAL-06 集成回归：真实现库安装银行组件 + 可验证备份 / 恢复到全新目标。
 *
 * 覆盖（全部使用合成临时库，不读取真实账套 / 凭据）：
 *  - core v4（含未 checkpoint 的 WAL）安装前真实 create + verify，备份可还原原核心；
 *  - 安装后银行流水 / 批次 / 人工确认取消 / 未达调节 / 期间关联完整；
 *  - 固定手算金额：账面 1120、对账单 1110，调节双方 1130，差额 0（不生成调整凭证）；
 *  - backup → verify → restore-new 后金额 / 匹配 / 批次 / 运行记录保留；取消匹配与反过账使 stale 可见；
 *  - 双账套隔离；已安装重跑幂等且不新增备份；
 *  - core v3 兼容路径：不升级、备份可验证、恢复仍为 v3；
 *  - 故障：create / verify / DDL 自检失败回滚；错 DBPath 不写；安装期间外部写入被排他拒绝；
 *  - 篡改矩阵（多/少表、错 partial 谓词、FK 动作 / 重复 / 额外、版本表缺列 / 多行 / 未来、
 *    类型 / 默认值 / NOT NULL、未知 trigger、未知组件表、清单组件漏报 / 错报）重算快照摘要后仍拒绝；
 *    被拒绝的备份不得生成恢复目标。
 *
 * 运行：node test/local-bank-backup-integration.test.mjs（在 06-workbench 目录）
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const WORKBENCH = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureParent = new URL("../../.agent-runs/", import.meta.url);
const fixtureFs = await import("node:fs");
const fixturePath = await import("node:path");
const fixtureBase = fixturePath.resolve((await import("node:url")).fileURLToPath(fixtureParent));
for (let ancestor = fixturePath.dirname(fixtureBase); ; ancestor = fixturePath.dirname(ancestor)) {
  if (fixtureFs.lstatSync(ancestor).isSymbolicLink()) throw new Error("fixture ancestor is a reparse point");
  if (fixturePath.dirname(ancestor) === ancestor) break;
}
if (fixtureFs.existsSync(fixtureBase) && fixtureFs.lstatSync(fixtureBase).isSymbolicLink()) throw new Error("fixture parent is a reparse point");
fixtureFs.mkdirSync(fixtureBase, { recursive: true });
const fixtureRoot = fixtureFs.mkdtempSync(fixturePath.join(fixtureBase, "bank-fresh-"));
process.env.TEMP = fixtureRoot;
process.env.TMP = fixtureRoot;
process.env.WORKBENCH_DATA_DIR = fixturePath.join(fixtureRoot, "fallback");

const ROOT = mkdtempSync(join(tmpdir(), "wb-bank-backup-it-"));
const CLI_BANK = join(WORKBENCH, "scripts", "bank-reconcile.mjs");
const CLI_BACKUP = join(WORKBENCH, "scripts", "local-backup.mjs");
const BACKUP_SERVICE = join(WORKBENCH, "server", "local-backup.mjs");
const URLS = {
  db: pathToFileURL(join(WORKBENCH, "server", "db.mjs")).href,
  accounting: pathToFileURL(join(WORKBENCH, "server", "accounting.mjs")).href,
  bank: pathToFileURL(join(WORKBENCH, "server", "bank-reconciliation.mjs")).href,
  storage: pathToFileURL(join(WORKBENCH, "server", "bank-storage.mjs")).href,
};
const LB = await import(pathToFileURL(BACKUP_SERVICE).href);
const S = await import(pathToFileURL(join(WORKBENCH, "server", "bank-storage.mjs")).href);

const results = [];
let seq = 0;
const test = async (name, fn) => {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`  ✗ ${name}`);
    console.log(String(error && error.stack ? error.stack : error).split("\n").slice(0, 14).join("\n"));
  }
};

const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const assertEqual = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const assertRejected = (result, code, message = "") => {
  assert(result && result.ok === false, `${message} 期望被拒绝，实际：${JSON.stringify(result)}`);
  assertEqual(result.code, code, `${message} 拒绝 code`);
};

const cleanEnv = () => {
  const env = { ...process.env };
  env.WORKBENCH_DATA_DIR = join(fixtureRoot, "fallback");
  delete env.NODE_NO_WARNINGS;
  return env;
};

/** 在独立子进程中运行一段 ESM 代码（用于真实 db.mjs 创建 / 读取临时库）。 */
function runChild(code, { dataDir = null, env = {} } = {}) {
  const file = join(ROOT, `child-${++seq}.mjs`);
  fs.writeFileSync(file, code, "utf8");
  try {
    return spawnSync(process.execPath, [file], {
      cwd: WORKBENCH,
      env: { ...cleanEnv(), ...(dataDir ? { WORKBENCH_DATA_DIR: dataDir } : {}), ...env },
      encoding: "utf8",
      timeout: 120000,
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function runBankCli(args) {
  const result = spawnSync(process.execPath, [CLI_BANK, ...args], {
    cwd: WORKBENCH, env: cleanEnv(), encoding: "utf8", timeout: 120000,
  });
  let json = null;
  try { json = JSON.parse((result.stdout || result.stderr || "").trim()); } catch { /* 保留原文 */ }
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim(), json };
}

function runBackupCli(args) {
 args=cli4(args);
  const result = spawnSync(process.execPath, [CLI_BACKUP, ...args], {
    cwd: WORKBENCH, env: cleanEnv(), encoding: "utf8", timeout: 120000,
  });
  let json = null;
  try { json = JSON.parse(result.stdout || ""); } catch { /* 保留原文 */ }
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim(), json };
}

function okBank(args) {
  const result = runBankCli(args);
  assertEqual(result.status, 0, `${args[0]} exit（${result.stdout}${result.stderr}）`);
  assert(result.json && result.json.ok === true, `${args[0]} 应返回 ok：${result.stdout}${result.stderr}`);
  return result.json;
}

function okBackup(args) {
  const result = runBackupCli(args);
  assertEqual(result.status, 0, `${args[0]} exit（${result.stdout}${result.stderr}）`);
  assert(result.json && result.json.ok === true, `${args[0]} 应返回 ok：${result.stdout}${result.stderr}`);
  return result.json;
}

/** 造一个已封装的 core v4 库（子进程退出时不 close，刻意留下已提交 WAL），返回 id 与核心摘要。 */
function createHistoricalCoreDatabase(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'workbench.db');
  const conn = new DatabaseSync(dbPath);
  conn.exec("\nPRAGMA journal_mode = WAL;\nPRAGMA foreign_keys = ON;\nCREATE TABLE account_sets (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  taxpayer_type TEXT NOT NULL DEFAULT '小规模纳税人',\n  accounting_standard TEXT NOT NULL DEFAULT '小企业会计准则',\n  start_period TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE accounts (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,\n  code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,\n  contra INTEGER NOT NULL DEFAULT 0, is_leaf INTEGER NOT NULL DEFAULT 1,\n  UNIQUE (account_set_id, code)\n);\nCREATE TABLE opening_balances (\n  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,\n  code TEXT NOT NULL, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0,\n  PRIMARY KEY (account_set_id, code)\n);\nCREATE TABLE periods (\n  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,\n  period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', PRIMARY KEY (account_set_id, period)\n);\nCREATE TABLE vouchers (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,\n  period TEXT NOT NULL, voucher_date TEXT NOT NULL, word TEXT NOT NULL DEFAULT '记',\n  number INTEGER NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL\n);\nCREATE TABLE voucher_entries (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,\n  line_no INTEGER NOT NULL, code TEXT NOT NULL, summary TEXT,\n  debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0\n);\nCREATE INDEX idx_vouchers_set_period ON vouchers(account_set_id, period, status);\nCREATE INDEX idx_entries_voucher ON voucher_entries(voucher_id);\nCREATE INDEX idx_entries_code ON voucher_entries(code);\nCREATE TABLE asset_cards (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,\n  kind TEXT NOT NULL DEFAULT 'fixed', name TEXT NOT NULL, original_cost REAL NOT NULL,\n  residual_rate REAL NOT NULL DEFAULT 0.05, useful_life_months INTEGER NOT NULL,\n  start_period TEXT NOT NULL, asset_account TEXT NOT NULL, accum_account TEXT NOT NULL,\n  expense_account TEXT NOT NULL DEFAULT '5602', created_at TEXT NOT NULL\n);\nCREATE TABLE asset_depreciation_runs (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,\n  asset_id INTEGER NOT NULL REFERENCES asset_cards(id) ON DELETE CASCADE,\n  period TEXT NOT NULL, amount REAL NOT NULL, voucher_id INTEGER, created_at TEXT NOT NULL,\n  UNIQUE (account_set_id, asset_id, period)\n);\nALTER TABLE vouchers ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';\n");
  ensureImportSchema(conn, { dataDir: dir, targetVersion: version });
  const now = '2026-01-01T00:00:00.000Z';
  for (const [id,name,cash] of [[1,'合成甲公司',1000],[2,'合成乙公司',500]]) {
    conn.prepare('INSERT INTO account_sets (id,name,start_period,created_at) VALUES (?,?,?,?)').run(id,name,'2026-01',now);
    for (const a of COA) conn.prepare('INSERT INTO accounts (account_set_id,code,name,category,direction,contra) VALUES (?,?,?,?,?,?)').run(id,a.code,a.name,a.category,a.direction,a.contra?1:0);
    conn.prepare("INSERT INTO periods (account_set_id,period) VALUES (?,'2026-01')").run(id);
    conn.prepare("INSERT INTO opening_balances (account_set_id,code,debit,credit) VALUES (?,'1002',?,0),(?,'3001',0,?)").run(id,cash,id,cash);
  }
  for (const [id,setId,amount,opposite,inflow] of [[1,1,200,'1122',true],[2,1,50,'1122',true],[3,1,100,'5602',false],[4,1,30,'5602',false],[5,2,100,'1122',true]]) {
    conn.prepare("INSERT INTO vouchers (id,account_set_id,period,voucher_date,number,status,created_at) VALUES (?,?,'2026-01','2026-01-05',?,'posted',?)").run(id,setId,id,now);
    conn.prepare('INSERT INTO voucher_entries (voucher_id,line_no,code,debit,credit) VALUES (?,1,?,?,?),(?,2,?,?,?)').run(id,inflow?'1002':opposite,amount,0,id,inflow?opposite:'1002',0,amount);
  }
  conn.close();
  return { dbPath, wire: { setA:1, setB:2, vouchers:{in200:1,unIn:2,out100:3,unOut:4,b:5} } };
}

function createCore4Database(dir, name = "workbench.db") {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, name);
  const resultFile = join(dir, "setup.json");
  const child = runChild(`
import { writeFileSync } from "node:fs";
const { db } = await import(${JSON.stringify(URLS.db)});
const A = await import(${JSON.stringify(URLS.accounting)});
const setA = A.createAccountSet({ enterprise: { enterpriseKey: "SYNTHETIC-local-bank-backup-integration-1" }, name: "合成甲公司", start_period: "2026-01" });
A.setOpeningBalances(setA.id, [
  { code: "1002", debit: 1000, credit: 0 },
  { code: "3001", debit: 0, credit: 1000 },
]);
const vin = A.createVoucher(setA.id, { period: "2026-01", voucher_date: "2026-01-05", status: "posted",
  entries: [{ code: "1002", debit: 200, credit: 0 }, { code: "1122", debit: 0, credit: 200 }] });
const vunin = A.createVoucher(setA.id, { period: "2026-01", voucher_date: "2026-01-06", status: "posted",
  entries: [{ code: "1002", debit: 50, credit: 0 }, { code: "1122", debit: 0, credit: 50 }] });
const vout = A.createVoucher(setA.id, { period: "2026-01", voucher_date: "2026-01-07", status: "posted",
  entries: [{ code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 }] });
const vunout = A.createVoucher(setA.id, { period: "2026-01", voucher_date: "2026-01-08", status: "posted",
  entries: [{ code: "5602", debit: 30, credit: 0 }, { code: "1002", debit: 0, credit: 30 }] });
const setB = A.createAccountSet({ enterprise: { enterpriseKey: "SYNTHETIC-local-bank-backup-integration-2" }, name: "合成乙公司", start_period: "2026-01" });
A.setOpeningBalances(setB.id, [
  { code: "1002", debit: 500, credit: 0 },
  { code: "3001", debit: 0, credit: 500 },
]);
const vb = A.createVoucher(setB.id, { period: "2026-01", voucher_date: "2026-01-09", status: "posted",
  entries: [{ code: "1002", debit: 100, credit: 0 }, { code: "1122", debit: 0, credit: 100 }] });
const entryOf = (v) => db.prepare("SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'").get(v.id).id;
const wire = {
  setA: setA.id, setB: setB.id,
  vouchers: { in200: vin.id, unIn: vunin.id, out100: vout.id, unOut: vunout.id, b: vb.id },
  entries: { in200: entryOf(vin), out100: entryOf(vout) },
  counts: {
    sets: Number(db.prepare("SELECT COUNT(*) n FROM account_sets").get().n),
    vouchers: Number(db.prepare("SELECT COUNT(*) n FROM vouchers").get().n),
    entries: Number(db.prepare("SELECT COUNT(*) n FROM voucher_entries").get().n),
  },
  balanceA: (() => { const m = A.accountBalances(setA.id, "2026-01"); return m.get("1002").net; })(),
  balanceB: (() => { const m = A.accountBalances(setB.id, "2026-01"); return m.get("1002").net; })(),
};
writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(wire));
// 故意不 close：模拟断电 / 强杀后遗留已提交但未 checkpoint 的 WAL。
process.exit(0);
`, { dataDir: dir });
  assertEqual(child.status, 0, `创建 core4 库失败：${child.stdout}${child.stderr}`);
  const wire = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  return {
    dbPath,
    dir,
    wire,
    walExists: fs.existsSync(`${dbPath}-wal`) && fs.statSync(`${dbPath}-wal`).size > 0,
  };
}

const readDbFacts = (dbPath) => {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    const bankTables = tables.filter((name) => name.startsWith("bank_"));
    return {
      tables,
      bankTables,
      schemaVersion: tables.includes("schema_migrations")
        ? Number(conn.prepare("SELECT MAX(version) v FROM schema_migrations").get().v) : 0,
      sets: tables.includes("account_sets") ? Number(conn.prepare("SELECT COUNT(*) n FROM account_sets").get().n) : 0,
      vouchers: tables.includes("vouchers") ? Number(conn.prepare("SELECT COUNT(*) n FROM vouchers").get().n) : 0,
      entries: tables.includes("voucher_entries") ? Number(conn.prepare("SELECT COUNT(*) n FROM voucher_entries").get().n) : 0,
      bankRows: Object.fromEntries([...bankTables].sort().map((table) => [
        table, Number(conn.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n),
      ])),
    };
  } finally { conn.close(); }
};

const listBackupDirs = (dataDir) => {
  const root = join(dataDir, "bank-component-backups");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().map((name) => join(root, name));
};

/** 读取 / 写入清单（测试只改必要字段，并重新计算被改快照的物理摘要）。 */
const mutateManifest = (backupDir, mutate) => {
  const file = join(backupDir, LB.MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(manifest);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};
const refreshSnapshotDigest = (backupDir) => {
  const snapshot = join(backupDir, LB.SNAPSHOT_FILE);
  mutateManifest(backupDir, (manifest) => {
    manifest.snapshot.bytes = fs.statSync(snapshot).size;
    manifest.snapshot.sha256 = sha256File(snapshot);
  });
};
const tamperSnapshot = (backupDir, statements) => {
  const snapshot = join(backupDir, LB.SNAPSHOT_FILE);
  const conn = new DatabaseSync(snapshot);
  try {
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec(statements);
  } finally { conn.close(); }
  // 只重算物理快照摘要：后续结构 / 组件契约必须自己拦住伪结构，不能只靠摘要不一致。
  refreshSnapshotDigest(backupDir);
};
const copyBackup = (source, label) => {
  const target = join(ROOT, `tamper-${label}-${++seq}`);
  fs.cpSync(source, target, { recursive: true });
  return target;
};
const expectVerifyRejected = (backupDir, code, message) => {
  const result = LB.verifyBackup({ backupDir });
  assertRejected(result, code, message);
  return result;
};
const expectRestoreNotCreated = (backupDir, label) => {
  const target = join(ROOT, `restore-target-${label}-${++seq}`);
  const result = LB.restoreNew(R4({ backupDir, targetDir: target }));
  assert(result.ok === false, `${label}：被拒绝的备份不得恢复成功`);
  assertEqual(fs.existsSync(join(target, LB.TARGET_DATABASE_FILE)), false, `${label}：不得生成目标库`);
  return result;
};

const buildBankScenario = () => {
  const dir = join(ROOT, `scenario-${++seq}`);
  const core = createCore4Database(dir);
  const { wire } = core;
  const dbPath = core.dbPath;
  const install = okBank([
    "account-register", "--db", dbPath, "--backup-service", BACKUP_SERVICE,
    "--account-set", String(wire.setA), "--bank-account", "BANK-A", "--source", "local-statement",
    "--gl-code", "1002", "--name", "合成甲银行",
  ]);
  assertEqual(install.created, true, "安装并登记 BANK-A");
  okBank([
    "account-register", "--db", dbPath,
    "--account-set", String(wire.setB), "--bank-account", "BANK-B", "--source", "local-statement",
    "--gl-code", "1002", "--name", "合成乙银行",
  ]);
  return { ...core, install };
};

const writeImportFiles = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const csv = join(dir, "statement.csv");
  const mapping = join(dir, "mapping.json");
  fs.writeFileSync(csv, [
    "日期,摘要,金额,方向,流水号",
    "2026-01-05,共同收款,200.00,收,M-IN-200",
    "2026-01-06,银收企未收,20.00,收,B-IN-20",
    "2026-01-07,共同付款,100.00,付,M-OUT-100",
    "2026-01-08,银付企未付,10.00,付,B-OUT-10",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(mapping, JSON.stringify({
    columns: { date: "日期", summary: "摘要", amount: "金额", direction: "方向", refId: "流水号" },
    amountMode: "amount_direction",
    directionLabels: { inflow: ["收"], outflow: ["付"] },
    currency: "CNY",
  }), "utf8");
  return { csv, mapping };
};

try {
  console.log("LOCAL-04 银行现库安装 / 组件备份恢复集成回归\n");

  await test("core5 + WAL：安装前真实备份可还原原核心；安装后固定手算对账 → backup → verify → restore-new 全保留", () => {
    const { dir, wire } = buildBankScenario();
    const dbPath = join(dir, "workbench.db");
    const backupDirs = listBackupDirs(dir);
    assertEqual(backupDirs.length, 1, "安装应当只生成一个专属迁移备份子目录");
    const preInstall = backupDirs[0];
    assert(/pre-bank-v1-/.test(preInstall), "备份目录名应可识别");

    // 安装前备份：真实 verify、无 bank 组件、包含 WAL 已提交业务；恢复回原核心。
    const preVerified = LB.verifyBackup({ backupDir: preInstall });
    assert(preVerified.ok === true, `安装前备份必须真实 verify 通过：${JSON.stringify(preVerified)}`);
    assertEqual(JSON.stringify(preVerified.manifest.components.map(c=>[c.name,c.version])), JSON.stringify([["business-audit",2],["local-batch",3]]), "安装前已有真实audit2而无bank");
    const preSnapshot = readDbFacts(join(preInstall, LB.SNAPSHOT_FILE));
    assertEqual(preSnapshot.bankTables.length, 0, "安装前备份快照不得有 bank_* 表");
    assertEqual(preSnapshot.vouchers, 5, "安装前备份必须包含 WAL 中已提交的凭证");
    assertEqual(preSnapshot.schemaVersion, 5, "core5 备份按 v5 契约");
    const preRestore = LB.restoreNew(R4({ backupDir: preInstall, targetDir: join(ROOT, `pre-restore-${++seq}`) }));
    assert(preRestore.ok === true, `安装前备份应可恢复到全新目标：${JSON.stringify(preRestore)}`);
    const preRestored = readDbFacts(join(preRestore.targetDir, LB.TARGET_DATABASE_FILE));
    assertEqual(preRestored.bankTables.length, 0, "恢复出的原核心不得带银行组件");
    assertEqual(preRestored.sets, 2, "恢复原核心账套数");
    assertEqual(preRestored.vouchers, 5, "恢复原核心凭证数");
    assertEqual(preRestored.entries, wire.counts.entries, "恢复原核心分录数");

    // 安装后的组件库：结构契约、备份证据、幂等重跑。
    const installed = readDbFacts(dbPath);
    assertEqual(installed.schemaVersion, 5, "安装不得改变核心 schema 版本");
    assertEqual(installed.bankTables.length, S.BANK_TABLES.length, "安装后必须完整 10 张 bank_* 表");
    const stateDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const backupRows = stateDb.prepare("SELECT version, path, bytes, integrity FROM bank_component_backups").all();
      assertEqual(backupRows.length, 1, "必须登记一条迁移前备份证据");
      assertEqual(Number(backupRows[0].version), 1);
      assertEqual(backupRows[0].integrity, "ok");
      assert(Number(backupRows[0].bytes) > 0, "备份证据必须记录真实字节数");
      assertEqual(Number(stateDb.prepare("SELECT COUNT(*) n FROM bank_component_migrations").get().n), 1);
    } finally { stateDb.close(); }
    const status = okBank([
      "status", "--db", dbPath, "--backup-service", BACKUP_SERVICE,
      "--account-set", String(wire.setA), "--bank-account", "BANK-A",
    ]);
    assertEqual(status.schema.version, 1, "重跑应识别已安装 v1");
    assertEqual(listBackupDirs(dir).length, 1, "已安装重跑不得再生成迁移备份");

    // 银行流水 / 匹配 / 调节：固定手算场景。
    const files = writeImportFiles(join(dir, "import"));
    const imported = okBank([
      "import", "--db", dbPath, "--account-set", String(wire.setA), "--bank-account", "BANK-A",
      "--source", "local-statement", "--period", "2026-01", "--batch", "A-1",
      "--csv", files.csv, "--mapping", files.mapping,
    ]);
    assertEqual(imported.transactionIds.length, 4, "应导入 4 条银行流水");
    okBank([
      "confirm", "--db", dbPath, "--account-set", String(wire.setA), "--bank-account", "BANK-A",
      "--transaction", String(imported.transactionIds[0]), "--voucher", String(wire.vouchers.in200),
      "--entry", String(wire.entries.in200), "--reason", "共同收款核对一致",
    ]);
    okBank([
      "confirm", "--db", dbPath, "--account-set", String(wire.setA), "--bank-account", "BANK-A",
      "--transaction", String(imported.transactionIds[2]), "--voucher", String(wire.vouchers.out100),
      "--entry", String(wire.entries.out100), "--reason", "共同付款核对一致",
    ]);
    const reconciled = okBank([
      "reconcile", "--db", dbPath, "--account-set", String(wire.setA), "--bank-account", "BANK-A",
      "--period", "2026-01", "--as-of", "2026-01-31",
      "--statement-open", "1000.00", "--statement-close", "1110.00",
      "--coverage-from", "2026-01-01", "--coverage-to", "2026-01-31",
      "--statement-source", "合成对账单（固定手算）",
    ]);
    assertEqual(reconciled.book.closingCents, 112000, "账面期末 1120.00");
    assertEqual(reconciled.statement.closeCents, 111000, "对账单期末 1110.00");
    assertEqual(reconciled.outstanding.totals.bookReceivedBankMissingCents, 5000, "企业已收银行未收 50");
    assertEqual(reconciled.outstanding.totals.bookPaidBankMissingCents, 3000, "企业已付银行未付 30");
    assertEqual(reconciled.outstanding.totals.bankReceivedBookMissingCents, 2000, "银行已收企业未收 20");
    assertEqual(reconciled.outstanding.totals.bankPaidBookMissingCents, 1000, "银行已付企业未付 10");
    assertEqual(reconciled.adjusted.bookCents, 113000, "调节账面 1130.00");
    assertEqual(reconciled.adjusted.bankCents, 113000, "调节银行 1130.00");
    assertEqual(reconciled.adjusted.differenceCents, 0, "调节差额 0");
    const voucherCount = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assertEqual(Number(voucherCount.prepare("SELECT COUNT(*) n FROM vouchers WHERE account_set_id=?").get(wire.setA).n), 4,
        "余额调节不得生成调整凭证");
    } finally { voucherCount.close(); }

    // 第二账套也导入一笔银行流水，验证备份 / 恢复后的隔离。
    fs.mkdirSync(join(dir, "import-b"), { recursive: true });
    const csvB = join(dir, "import-b", "statement.csv");
    const mappingB = join(dir, "import-b", "mapping.json");
    fs.writeFileSync(csvB, "日期,摘要,金额,方向,流水号\n2026-01-10,乙公司收款,77.00,收,B-ONLY-1\n", "utf8");
    fs.writeFileSync(mappingB, fs.readFileSync(files.mapping, "utf8"), "utf8");
    const importedB = okBank([
      "import", "--db", dbPath, "--account-set", String(wire.setB), "--bank-account", "BANK-B",
      "--source", "local-statement", "--period", "2026-01", "--batch", "B-1",
      "--csv", csvB, "--mapping", mappingB,
    ]);
    assertEqual(importedB.transactionIds.length, 1, "乙账套独立导入 1 条");

    // 安装后备份 → verify → restore-new。
    const postDir = join(ROOT, `post-bank-backup-${++seq}`);
    const created = LB.createBackup({ dbPath, outDir: postDir });
    assert(created.ok === true, `安装后真实备份应成功：${JSON.stringify(created)}`);
    assertEqual(created.backupMeta.components.length, 3, "清单精确绑定bank及business-audit2");
    const bankMeta=created.backupMeta.components.find(c=>c.name==="bank"),auditMeta=created.backupMeta.components.find(c=>c.name==="business-audit");
    assertEqual(auditMeta.version,2);assertEqual(auditMeta.tables,4);
    assertEqual(bankMeta.version, 1, "清单绑定真实组件版本 v1");
    assertEqual(bankMeta.tables, 10, "清单绑定完整 10 表");
    const verified = LB.verifyBackup({ backupDir: postDir });
    assert(verified.ok === true, `安装后备份 must verify：${JSON.stringify(verified)}`);
    assertEqual(verified.summary.snapshotSha256, created.backupMeta.snapshotSha256, "verify 摘要必须等于 create 摘要");
    const manifest = JSON.parse(fs.readFileSync(join(postDir, LB.MANIFEST_FILE), "utf8"));
    assertEqual(manifest.components.length, 3, "清单应有精确两个组件");
    const bankComponent=manifest.components.find(c=>c.name==="bank"),auditComponent=manifest.components.find(c=>c.name==="business-audit");
    assertEqual(JSON.stringify(manifest.components.map(c=>c.name).sort()),JSON.stringify(["bank","business-audit","local-batch"]));
    assertEqual(auditComponent.version,2);assertEqual(JSON.stringify(auditComponent.tables),JSON.stringify(["audit_components","audit_database_instances","audit_events","audit_operations"]));
    for(const key of ["structureDigest","contentDigest"])assert(/^[a-f0-9]{64}$/.test(auditComponent[key]),"真实audit2摘要");
    assertEqual(bankComponent.name, "bank");
    assertEqual(bankComponent.version, 1);
    assert(/^[a-f0-9]{64}$/.test(bankComponent.structureDigest), "结构摘要必须绑定真实结构");
    assert(/^[a-f0-9]{64}$/.test(bankComponent.contentDigest), "内容摘要必须绑定真实内容");
    assert(bankComponent.tables.includes("bank_transactions"), "组件表集必须含 bank_transactions");
    assert(!bankComponent.tables.includes("audit_events"), "不得把未知组件表写进 bank 组件");

    const restoredDir = join(ROOT, `restored-bank-${++seq}`);
    const restored = LB.restoreNew(R4({ backupDir: postDir, targetDir: restoredDir }));
    assert(restored.ok === true, `恢复全新目标应成功：${JSON.stringify(restored)}`);
    assertEqual(restored.receipt.source.components.length, 3, "恢复回执应记录全部真实组件");
    assertEqual(restored.receipt.source.components.find(c=>c.name==="bank").name, "bank");

    const auditTables=["audit_components","audit_database_instances","audit_events","audit_operations"];
    const sourceAudit=new DatabaseSync(dbPath,{readOnly:true}),restoredAudit=new DatabaseSync(join(restoredDir,LB.TARGET_DATABASE_FILE),{readOnly:true});
    try{for(const table of auditTables.filter(t=>t!=="audit_database_instances"))assertEqual(JSON.stringify(restoredAudit.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()),JSON.stringify(sourceAudit.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()),"审计四表逐行恢复");}finally{try{restoredAudit.close();}finally{sourceAudit.close();}}

    // 在恢复库上重新打开真实产品入口：金额、匹配、批次、期间关联保留；取消 / 反过账后 stale 可见。
    const resultFile = join(ROOT, `restored-facts-${++seq}.json`);
    const child = runChild(`
import { writeFileSync } from "node:fs";
const { db } = await import(${JSON.stringify(URLS.db)});
const A = await import(${JSON.stringify(URLS.accounting)});
const B = await import(${JSON.stringify(URLS.bank)});
const S = await import(${JSON.stringify(URLS.storage)});
const setA = A.listAccountSets().find((s) => s.name === "合成甲公司");
const setB = A.listAccountSets().find((s) => s.name === "合成乙公司");
const scope = { accountSetId: setA.id, bankAccountId: "BANK-A" };
const before = B.reconcileBank(db, {
  ...scope, period: "2026-01", asOf: "2026-01-31",
  statementOpenCents: 100000n, statementCloseCents: 111000n,
  coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "恢复后合成对账单",
});
const statusBefore = B.getBankStatus(db, scope);
const runsBefore = statusBefore.reconciles.map((r) => ({ status: r.status, stale: Number(r.stale), reason: r.stale_reason }));
const match = db.prepare("SELECT id, voucher_id FROM bank_matches WHERE account_set_id=? AND status='confirmed' ORDER BY id LIMIT 1").get(setA.id);
B.cancelMatch(db, { ...scope, matchId: Number(match.id), reason: "恢复后取消匹配" });
const afterCancel = B.getBankStatus(db, scope);
B.reconcileBank(db, {
  ...scope, period: "2026-01", asOf: "2026-01-31",
  statementOpenCents: 100000n, statementCloseCents: 111000n,
  coverageFrom: "2026-01-01", coverageTo: "2026-01-31", statementSource: "取消后再核对",
});
const remaining = db.prepare("SELECT id, voucher_id FROM bank_matches WHERE account_set_id=? AND status='confirmed' ORDER BY id LIMIT 1").get(setA.id);
A.unpostVoucher(setA.id, Number(remaining.voucher_id));
const afterUnpost = B.getBankStatus(db, scope);
const balanceB = (() => { const m = A.accountBalances(setB.id, "2026-01"); return m.get("1002").net; })();
const bStatus = B.getBankStatus(db, { accountSetId: setB.id, bankAccountId: "BANK-B" });
const bankRowsA = Object.fromEntries(["bank_batches","bank_transactions","bank_matches","bank_reconcile_runs","bank_audit_events"]
  .map((t) => [t, Number(db.prepare("SELECT COUNT(*) n FROM " + t + " WHERE account_set_id=?").get(setA.id).n)]));
const bankRowsB = Object.fromEntries(["bank_batches","bank_transactions","bank_matches","bank_reconcile_runs","bank_audit_events"]
  .map((t) => [t, Number(db.prepare("SELECT COUNT(*) n FROM " + t + " WHERE account_set_id=?").get(setB.id).n)]));
const receipts = db.prepare("SELECT COUNT(*) n FROM bank_component_backups").get().n;
writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
  setA: setA.id, setB: setB.id,
  before: {
    book: before.book.closingCents, statement: before.statement.closeCents,
    adjustedBook: before.adjusted.bookCents, adjustedBank: before.adjusted.bankCents,
    difference: before.adjusted.differenceCents,
    outstanding: before.outstanding.totals,
  },
  statusBefore: {
    batches: statusBefore.batches.total, transactions: statusBefore.transactions.total,
    confirmed: statusBefore.matches.confirmed, schemaVersion: statusBefore.schema.version,
    runs: runsBefore,
  },
  afterCancel: {
    cancelled: afterCancel.matches.cancelled,
    confirmed: afterCancel.matches.confirmed,
    runs: afterCancel.reconciles.map((r) => ({ stale: Number(r.stale), reason: r.stale_reason })),
  },
  afterUnpost: {
    invalidated: afterUnpost.matches.invalidated,
    invalidations: afterUnpost.invalidations.map((i) => i.reason),
    runs: afterUnpost.reconciles.map((r) => ({ stale: Number(r.stale), reason: r.stale_reason })),
  },
  balanceB, bStatus: { transactions: bStatus.transactions.total, batches: bStatus.batches.total },
  bankRowsA, bankRowsB, receipts: Number(receipts), schemaState: S.bankSchemaState(db).contract,
}));
`, { dataDir: businessSeed4(restoredDir) });
    assertEqual(child.status, 0, `恢复库真实读取失败：${child.stdout}${child.stderr}`);
    const facts = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assertEqual(facts.before.book, 112000, "恢复后账面期末仍 1120.00");
    assertEqual(facts.before.statement, 111000, "恢复后对账单期末仍 1110.00");
    assertEqual(facts.before.adjustedBook, 113000, "恢复后调节账面仍 1130.00");
    assertEqual(facts.before.adjustedBank, 113000, "恢复后调节银行仍 1130.00");
    assertEqual(facts.before.difference, 0, "恢复后差额仍 0");
    assertEqual(facts.before.outstanding.bookReceivedBankMissingCents, 5000);
    assertEqual(facts.before.outstanding.bookPaidBankMissingCents, 3000);
    assertEqual(facts.before.outstanding.bankReceivedBookMissingCents, 2000);
    assertEqual(facts.before.outstanding.bankPaidBookMissingCents, 1000);
    assertEqual(facts.statusBefore.batches, 1, "恢复后来源批次保留");
    assertEqual(facts.statusBefore.transactions, 4, "恢复后银行流水保留");
    assertEqual(facts.statusBefore.confirmed, 2, "恢复后人工确认匹配保留");
    assertEqual(facts.statusBefore.schemaVersion, 1, "恢复后组件版本仍 v1");
    assertEqual(facts.statusBefore.runs.length, 2, "恢复后保留原运行记录，并在恢复库上新增一次对账（旧记录标记 stale）");
    assert(facts.statusBefore.runs.some((r) => r.stale === 1 && /superseded|reconcile/i.test(String(r.reason))),
      "恢复后重新对账应把先前运行记录标记 stale");
    assertEqual(facts.receipts, 1, "恢复后组件备份证据保留");
    assertEqual(facts.schemaState.ok, true, "恢复库组件结构契约必须通过");
    assertEqual(facts.afterCancel.cancelled, 1, "取消匹配应持久化");
    assert(facts.afterCancel.runs.some((r) => r.stale === 1 && /match_cancelled/.test(String(r.reason))),
      "取消匹配后运行记录 stale 可见");
    assert(facts.afterUnpost.invalidated >= 1, "反过账后剩余确认匹配必须失效");
    assert(facts.afterUnpost.invalidations.some((reason) => /voucher|posted|entry|amount|status/i.test(reason)),
      "失效原因必须可见");
    assert(facts.afterUnpost.runs.some((r) => r.stale === 1 && /match_invalidated/.test(String(r.reason))),
      "反过账后 stale 可见");
    assertEqual(facts.balanceB, 600, "乙账套账面余额不受甲账套操作影响（500 + 100）");
    assertEqual(facts.bStatus.transactions, 1, "乙账套只看到自己的 1 条流水");
    assertEqual(facts.bStatus.batches, 1, "乙账套只看到自己的 1 个批次");
    assertEqual(facts.bankRowsA.bank_transactions, 4, "甲账套流水隔离");
    assertEqual(facts.bankRowsB.bank_transactions, 1, "乙账套流水隔离");
  });

  await test("core3 兼容路径：安装前备份按 v3 验证；安装银行后仍为 v3，backup→verify→restore 后版本不升级", () => {
    for (const version of [3,4]) {
    const dir = join(ROOT, 'historical-v' + version + '-' + (++seq));
    const core = createHistoricalCoreDatabase(dir, version);
    const dbPath = core.dbPath;
    // 先确认这是被独立 v3 契约接受的库。
    const v3Check = LB.createBackup({ dbPath, outDir: join(ROOT, `v3-check-${++seq}`) });
    assert(v3Check.ok === true, `派生 v3 库应能按 v3 契约备份：${JSON.stringify(v3Check)}`);
    assertEqual(v3Check.manifest.structure.schemaVersion, version, "派生库必须是 v3");
    const install = okBank([
      "account-register", "--db", dbPath, "--backup-service", BACKUP_SERVICE,
      "--account-set", String(core.wire.setA), "--bank-account", "BANK-A", "--source", "local-statement",
      "--gl-code", "1002",
    ]);
    assertEqual(install.created, true, "v3 库应可安装银行组件");
    const installed = readDbFacts(dbPath);
    assertEqual(installed.schemaVersion, version, "安装银行组件不得升级核心 v3");
    assertEqual(installed.bankTables.length, 10, "v3 库安装后应有完整 10 表");
    const out = join(ROOT, `v3-bank-backup-${++seq}`);
    const created = LB.createBackup({ dbPath, outDir: out });
    assert(created.ok === true, `v3 + bank 备份应成功：${JSON.stringify(created)}`);
    assertEqual(created.manifest.structure.schemaVersion, version, "v3 + bank 备份仍按 v3 契约");
    assertEqual(created.manifest.components[0].version, 1, "组件仍绑定 v1");
    const verified = LB.verifyBackup({ backupDir: out });
    assert(verified.ok === true, `v3 + bank 备份应 verify：${JSON.stringify(verified)}`);
    const restored = LB.restoreNew(R4({ backupDir: out, targetDir: join(ROOT, `v3-restored-${++seq}`) }));
    assert(restored.ok === true, `v3 + bank 恢复应成功：${JSON.stringify(restored)}`);
    const facts = readDbFacts(join(restored.targetDir, LB.TARGET_DATABASE_FILE));
    assertEqual(facts.schemaVersion, version, "恢复后仍是 v3，不得自动升级");
    assertEqual(facts.bankTables.length, 10, "恢复后银行组件完整");
    assertEqual(facts.vouchers, 5, "恢复后核心业务保留");
    assertEqual(restored.receipt.source.components.find(c=>c.name==="bank").version, 1, "恢复回执组件版本 v1");
    }
  });

  await test("故障：create / verify / DDL 自检失败整体回滚；错 DBPath 不写；安装期间外部写入被排他拒绝", async () => {
    const mk = (label) => {
      const dir = join(ROOT, `fail-${label}-${++seq}`);
      const core = createCore4Database(dir);
      return { dir, dbPath: core.dbPath, wire: core.wire };
    };
    const assertUnchanged = (dbPath, baseline, label) => {
      const facts = readDbFacts(dbPath);
      assertEqual(facts.bankTables.length, 0, `${label}：不得留下 bank_* 表`);
      assertEqual(facts.schemaVersion, baseline.schemaVersion, `${label}：核心版本不得改变`);
      assertEqual(facts.sets, baseline.sets, `${label}：账套不得改变`);
      assertEqual(facts.vouchers, baseline.vouchers, `${label}：凭证不得改变`);
      assertEqual(facts.entries, baseline.entries, `${label}：分录不得改变`);
    };
    const ensure = async (dbPath, backupService, dataDir) => {
      const conn = new DatabaseSync(dbPath);
      try {
        conn.exec("PRAGMA foreign_keys = ON");
        return await S.ensureBankSchema(conn, { dbPath, backupService, dataDir });
      } finally { conn.close(); }
    };

    // 1) create 抛错。
    {
      const { dir, dbPath } = mk("create");
      const baseline = readDbFacts(dbPath);
      const service = {
        createBackup: () => { throw new Error("injected_disk_full"); },
        verifyBackup: LB.verifyBackup,
      };
      let error;
      try { await ensure(dbPath, service, dir); } catch (e) { error = e; }
      assertEqual(error?.code, "migration_backup_failed", "create 失败 code");
      assertUnchanged(dbPath, baseline, "create 失败");
    }

    // 2) 真实 create 成功但快照被删除 → 真实 verify 失败。
    {
      const { dir, dbPath } = mk("verify");
      const baseline = readDbFacts(dbPath);
      const service = {
        createBackup: (options) => {
          const result = LB.createBackup(options);
          if (result.ok) fs.rmSync(join(result.backupDir, LB.SNAPSHOT_FILE));
          return result;
        },
        verifyBackup: LB.verifyBackup,
      };
      let error;
      try { await ensure(dbPath, service, dir); } catch (e) { error = e; }
      assertEqual(error?.code, "migration_backup_invalid", "verify 失败 code");
      assertUnchanged(dbPath, baseline, "verify 失败");
    }

    // 3) DDL 后自检失败（预置同名索引使 CREATE IF NOT EXISTS 跳过）→ 单事务整体回滚。
    {
      const { dir, dbPath } = mk("ddl");
      const baseline = readDbFacts(dbPath);
      const conn = new DatabaseSync(dbPath);
      try {
        conn.exec("CREATE INDEX idx_bank_accounts_gl ON accounts (account_set_id, code, name)");
      } finally { conn.close(); }
      let error;
      try { await ensure(dbPath, LB, dir); } catch (e) { error = e; }
      assert(["bank_schema_corrupt", "bank_migration_failed"].includes(error?.code),
        `DDL 自检失败应结构化回滚，实际 ${error?.code}`);
      assertUnchanged(dbPath, baseline, "DDL 失败");
      const backups = listBackupDirs(dir);
      assertEqual(backups.length, 1, "DDL 失败时迁移前备份应保留为证据");
      const verified = LB.verifyBackup({ backupDir: backups[0] });
      assert(verified.ok === true, "DDL 失败保留的迁移前备份仍应可验证");
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assertEqual(Number(probe.prepare("SELECT COUNT(*) n FROM bank_component_backups").get().n), 0,
          "DDL 失败不得登记备份证据");
      } catch { /* 表不存在即正确 */ } finally { probe.close(); }
    }

    // 4) 错 DBPath：连接 A 却要求迁移 B，必须拒绝且两库都不动。
    {
      const a = mk("path-a");
      const b = mk("path-b");
      const baselineA = readDbFacts(a.dbPath);
      const baselineB = readDbFacts(b.dbPath);
      const conn = new DatabaseSync(a.dbPath);
      try {
        conn.exec("PRAGMA foreign_keys = ON");
        let error;
        try {
          await S.ensureBankSchema(conn, { dbPath: b.dbPath, backupService: LB, dataDir: b.dir });
        } catch (e) { error = e; }
        assertEqual(error?.code, "database_handle_mismatch", "错 DBPath code");
      } finally { conn.close(); }
      assertUnchanged(a.dbPath, baselineA, "错 DBPath 的连接库");
      assertUnchanged(b.dbPath, baselineB, "错 DBPath 的目标库");
      assertEqual(listBackupDirs(b.dir).length, 0, "错 DBPath 不得为另一个库生成备份");
    }

    // 5) 安装期间外部写入：备份 / DDL 持有 BEGIN IMMEDIATE，另一个连接必须被拒绝而不是静默丢失。
    {
      const { dir, dbPath } = mk("concurrent");
      const baseline = readDbFacts(dbPath);
      let observedBusy = null;
      const service = {
        createBackup: LB.createBackup,
        verifyBackup: (options) => {
          const result = LB.verifyBackup(options);
          const other = new DatabaseSync(dbPath);
          try {
            other.exec("PRAGMA busy_timeout = 0");
            other.exec("BEGIN IMMEDIATE");
            other.prepare("UPDATE account_sets SET name = name WHERE id = 1").run();
            other.exec("COMMIT");
            observedBusy = false;
          } catch (error) {
            observedBusy = String(error?.code || error?.message || error).includes("SQLITE_BUSY")
              || /busy|locked/i.test(String(error?.message || ""));
            try { other.exec("ROLLBACK"); } catch { /* 忽略 */ }
          } finally { other.close(); }
          return result;
        },
      };
      const migrated = await ensure(dbPath, service, dir);
      assertEqual(migrated.migrated, true, "排他安装应成功");
      assertEqual(observedBusy, true, "安装持锁期间另一个连接写入必须被拒绝（SQLITE_BUSY）");
      const installed = readDbFacts(dbPath);
      assertEqual(installed.bankTables.length, 10, "排他安装后组件完整");
      assertEqual(installed.vouchers, baseline.vouchers, "排他安装不得丢失既有业务");
    }
  });

  await test("篡改矩阵：多/少表、错 partial 谓词、FK 动作/重复/额外、版本缺列/多行/未来、类型/默认值/NOT NULL、未知 trigger、未知组件、清单组件漏报/错报 → 重算快照摘要仍拒绝且不生成恢复目标", () => {
    // 一个已安装 bank 的真实库 + 合法备份作为篡改基线。
    const { dir, wire } = buildBankScenario();
    const dbPath = join(dir, "workbench.db");
    const files = writeImportFiles(join(dir, "import"));
    const imported = okBank([
      "import", "--db", dbPath, "--account-set", String(wire.setA), "--bank-account", "BANK-A",
      "--source", "local-statement", "--period", "2026-01", "--batch", "T-1",
      "--csv", files.csv, "--mapping", files.mapping,
    ]);
    assertEqual(imported.transactionIds.length, 4);
    const validBackup = join(ROOT, `valid-bank-backup-${++seq}`);
    const created = LB.createBackup({ dbPath, outDir: validBackup });
    assert(created.ok === true, "基线 bank 备份应成功");
    const baseVerified = LB.verifyBackup({ backupDir: validBackup });
    assert(baseVerified.ok === true, "基线 bank 备份应可验证");

    const expectStructure = (label, sql, kind = null, message = "") => {
      const backup = copyBackup(validBackup, label);
      tamperSnapshot(backup, sql);
      const result = expectVerifyRejected(backup, "structure_invalid", message || label);
      const details = JSON.stringify(result.details ?? {});
      if (kind) assert(details.includes(kind), `${label}：拒绝明细应含 ${kind}，实际 ${details}`);
      expectRestoreNotCreated(backup, label);
    };

    // 1) 少一张表 / 半套组件。
    expectStructure("missing-table", "DROP TABLE bank_reconcile_runs", "component_tables_missing");
    expectStructure("missing-version-table", "DROP TABLE bank_component_migrations", "component_version_table_corrupt");

    // 2) 多一张未登记 bank 表。
    expectStructure("extra-bank-table", "CREATE TABLE bank_extra_probe (id INTEGER PRIMARY KEY)", "component_tables_unexpected");

    // 3) 同名同列同 UNIQUE/partial，谓词改错。
    expectStructure("wrong-partial",
      `DROP INDEX idx_bank_txn_ref;
       CREATE UNIQUE INDEX idx_bank_txn_ref
         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id)
         WHERE bank_ref_id IS NULL;`,
      "component_index_mismatch");

    // 4) 额外 / 重复外键。
    expectStructure("extra-foreign-key",
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE bank_audit_events_x (
         id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER,
         bank_account_id TEXT, event_type TEXT NOT NULL,
         subject_type TEXT NOT NULL DEFAULT '', subject_id TEXT NOT NULL DEFAULT '',
         detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
         FOREIGN KEY (account_set_id) REFERENCES account_sets(id) ON DELETE CASCADE);
       INSERT INTO bank_audit_events_x SELECT id, account_set_id, bank_account_id, event_type,
         subject_type, subject_id, detail_json, created_at FROM bank_audit_events;
       DROP TABLE bank_audit_events;
       ALTER TABLE bank_audit_events_x RENAME TO bank_audit_events;
       CREATE INDEX idx_bank_audit_scope ON bank_audit_events (account_set_id, bank_account_id, event_type);
       PRAGMA foreign_keys = ON;`,
      "unexpected_foreign_keys");
    expectStructure("duplicate-foreign-key",
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE bank_accounts_x (
         account_set_id INTEGER NOT NULL REFERENCES account_sets(id) ON DELETE CASCADE,
         bank_account_id TEXT NOT NULL, source_id TEXT NOT NULL, currency TEXT NOT NULL,
         gl_account_code TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
         bank_account_no TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
         PRIMARY KEY (account_set_id, bank_account_id),
         FOREIGN KEY (account_set_id) REFERENCES account_sets(id) ON DELETE CASCADE);
       INSERT INTO bank_accounts_x SELECT account_set_id, bank_account_id, source_id, currency,
         gl_account_code, display_name, bank_account_no, created_at FROM bank_accounts;
       DROP TABLE bank_accounts;
       ALTER TABLE bank_accounts_x RENAME TO bank_accounts;
       CREATE UNIQUE INDEX idx_bank_accounts_gl ON bank_accounts (account_set_id, gl_account_code);
       CREATE INDEX idx_bank_accounts_source ON bank_accounts (account_set_id, source_id);
       PRAGMA foreign_keys = ON;`,
      "foreign_key_duplicate");

    // 5) 外键动作被改成 CASCADE（匹配证据会被连带删除）。
    expectStructure("foreign-key-action",
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE bank_matches_x (
         id INTEGER PRIMARY KEY AUTOINCREMENT, account_set_id INTEGER NOT NULL,
         bank_account_id TEXT NOT NULL, currency TEXT NOT NULL,
         transaction_id INTEGER REFERENCES bank_transactions(id) ON DELETE CASCADE,
         voucher_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, entry_line_no INTEGER NOT NULL,
         status TEXT NOT NULL, snapshot_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
         confirmed_at TEXT NOT NULL, cancelled_at TEXT, cancel_reason TEXT,
         invalidated_at TEXT, invalidation_reason TEXT);
       INSERT INTO bank_matches_x SELECT id, account_set_id, bank_account_id, currency,
         transaction_id, voucher_id, entry_id, entry_line_no, status, snapshot_json, reason,
         confirmed_at, cancelled_at, cancel_reason, invalidated_at, invalidation_reason FROM bank_matches;
       DROP TABLE bank_matches;
       ALTER TABLE bank_matches_x RENAME TO bank_matches;
       CREATE UNIQUE INDEX idx_bank_matches_active_txn ON bank_matches (transaction_id) WHERE status = 'confirmed';
       CREATE UNIQUE INDEX idx_bank_matches_active_entry ON bank_matches (account_set_id, entry_id) WHERE status = 'confirmed';
       CREATE INDEX idx_bank_matches_scope ON bank_matches (account_set_id, bank_account_id, status);
       PRAGMA foreign_keys = ON;`,
      "foreign_key_actions");

    // 6) 版本表：缺列 / 多行 / 未来版本。
    expectStructure("version-missing-column",
      "ALTER TABLE bank_component_migrations RENAME COLUMN version TO broken_version",
      "component_version_table_corrupt");
    expectStructure("version-multi-row",
      "INSERT INTO bank_component_migrations (version, applied_at, note) VALUES (0, '2026-01-01T00:00:00.000Z', 'evil')",
      "component_version_contradiction");
    expectStructure("version-future",
      "UPDATE bank_component_migrations SET version = 2",
      "component_version_future");

    // 7) 列类型 / 默认值 / NOT NULL。
    expectStructure("column-default",
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE bank_component_backups_x (
         id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, path TEXT NOT NULL,
         bytes INTEGER, integrity TEXT NOT NULL DEFAULT 'changed', created_at TEXT NOT NULL, note TEXT);
       INSERT INTO bank_component_backups_x SELECT id, version, path, bytes, integrity, created_at, note
         FROM bank_component_backups;
       DROP TABLE bank_component_backups;
       ALTER TABLE bank_component_backups_x RENAME TO bank_component_backups;
       PRAGMA foreign_keys = ON;`,
      "column_default");
    expectStructure("column-type",
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE bank_component_backups_x (
         id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, path TEXT NOT NULL,
         bytes INTEGER, integrity TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL, note TEXT);
       INSERT INTO bank_component_backups_x SELECT id, version, path, bytes, integrity, created_at, note
         FROM bank_component_backups;
       DROP TABLE bank_component_backups;
       ALTER TABLE bank_component_backups_x RENAME TO bank_component_backups;
       PRAGMA foreign_keys = ON;`,
      "column_type");
    expectStructure("column-not-null",
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE bank_component_backups_x (
         id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, path TEXT NOT NULL,
         bytes INTEGER, integrity TEXT DEFAULT 'unknown', created_at TEXT NOT NULL, note TEXT);
       INSERT INTO bank_component_backups_x SELECT id, version, path, bytes, integrity, created_at, note
         FROM bank_component_backups;
       DROP TABLE bank_component_backups;
       ALTER TABLE bank_component_backups_x RENAME TO bank_component_backups;
       PRAGMA foreign_keys = ON;`,
      "column_not_null");

    // 8) 未知 trigger / 未知组件表。
    expectStructure("unknown-trigger",
      `CREATE TRIGGER bank_tamper AFTER INSERT ON bank_transactions
       BEGIN SELECT 1; END;`,
      "component_trigger_unexpected");
    expectStructure("unknown-view",
      "CREATE VIEW bank_probe AS SELECT id FROM account_sets",
      "component_view_unexpected");
    expectStructure("unknown-component-table",
      "CREATE TABLE local_audit_events (id INTEGER PRIMARY KEY, payload TEXT)",
      "unexpected_tables");
    expectStructure("unknown-batch-table",
      "CREATE TABLE batch_jobs (id INTEGER PRIMARY KEY, status TEXT)",
      "unexpected_tables");

    // 9) 清单组件漏报 / 错报（快照本身合法，只在清单上做手脚）。
    {
      const missing = copyBackup(validBackup, "manifest-components-missing");
      mutateManifest(missing, (manifest) => { delete manifest.components; });
      expectVerifyRejected(missing, "component_mismatch", "清单漏报组件");
      expectRestoreNotCreated(missing, "manifest-components-missing");
    }
    {
      const wrongVersion = copyBackup(validBackup, "manifest-component-version");
      mutateManifest(wrongVersion, (manifest) => { manifest.components.find(c=>c.name==="bank").version = 2; });
      expectVerifyRejected(wrongVersion, "component_version_unsupported", "清单错报未来组件版本");
      expectRestoreNotCreated(wrongVersion, "manifest-component-version");
    }
    {
      const wrongDigest = copyBackup(validBackup, "manifest-component-digest");
      mutateManifest(wrongDigest, (manifest) => { manifest.components.find(c=>c.name==="bank").structureDigest = "0".repeat(64); });
      expectVerifyRejected(wrongDigest, "component_mismatch", "清单结构摘要错报");
      expectRestoreNotCreated(wrongDigest, "manifest-component-digest");
    }
    {
      const wrongTables = copyBackup(validBackup, "manifest-component-tables");
      mutateManifest(wrongTables, (manifest) => {
        manifest.components.find(c=>c.name==="bank").tables = manifest.components.find(c=>c.name==="bank").tables.filter((name) => name !== "bank_matches");
      });
      expectVerifyRejected(wrongTables, "component_tables_mismatch", "清单组件表集错报");
      expectRestoreNotCreated(wrongTables, "manifest-component-tables");
    }
    {
      // 无 bank 的旧备份清单不得被追加虚假组件声明。
      const unknownComponent = copyBackup(validBackup, "manifest-unknown-component");
      mutateManifest(unknownComponent, (manifest) => { manifest.components.find(c=>c.name==="bank").name = "audit"; });
      expectVerifyRejected(unknownComponent, "component_unsupported", "清单声明未登记组件");
      expectRestoreNotCreated(unknownComponent, "manifest-unknown-component");
    }
    {
      const coreOnly = listBackupDirs(dir)[0];
      assert(coreOnly, "应有安装前 core-only 备份");
      const claimed = copyBackup(coreOnly, "manifest-claims-bank");
      mutateManifest(claimed, (manifest) => {
        manifest.components = [{
          name: "bank", version: 1,
          tables: [...S.BANK_TABLES].sort(),
          structureDigest: "0".repeat(64), contentDigest: "0".repeat(64), rows: 0,
        }];
      });
      expectVerifyRejected(claimed, "component_mismatch", "core-only 清单虚报 bank 组件");
      expectRestoreNotCreated(claimed, "manifest-claims-bank");
    }
  });

  await test("索引键语义 + 备份恢复：健康备份恢复后键语义保留、大小写不同稳定 ID 可继续导入；NOCASE / RTRIM / DESC / 表达式 / 额外唯一 / 来源顶替 / 主键 rowid 漂移在源库、快照与恢复目标三入口全拒绝", async () => {
    const { dir, wire } = buildBankScenario();
    const dbPath = join(dir, "workbench.db");
    const files = join(dir, "keys-import");
    fs.mkdirSync(files, { recursive: true });
    const mappingPath = join(files, "mapping.json");
    fs.writeFileSync(mappingPath, JSON.stringify({
      columns: { date: "日期", summary: "摘要", amount: "金额", direction: "方向", refId: "流水号" },
      amountMode: "amount_direction",
      directionLabels: { inflow: ["收"], outflow: ["付"] },
      currency: "CNY",
    }), "utf8");
    const csvPath = join(files, "case-refs.csv");
    fs.writeFileSync(csvPath, "日期,摘要,金额,方向,流水号\n2026-01-05,收款甲,10.00,收,Ref-A\n2026-01-06,收款乙,20.00,收,ref-a\n", "utf8");
    // 恢复库用另一份内容（不同流水号命名空间），避免同一文件被识别为历史批次回放。
    const restoredCsvPath = join(files, "case-refs-restored.csv");
    fs.writeFileSync(restoredCsvPath, "日期,摘要,金额,方向,流水号\n2026-01-15,收款丙,30.00,收,Ref-B\n2026-01-16,收款丁,40.00,收,ref-b\n", "utf8");
    const importArgs = (dbFile, batchId, csvFile = csvPath) => [
      "import", "--db", dbFile, "--account-set", String(wire.setA), "--bank-account", "BANK-A",
      "--source", "local-statement", "--period", "2026-01", "--batch", batchId,
      "--csv", csvFile, "--mapping", mappingPath,
    ];
    const first = okBank(importArgs(dbPath, "CASE-REFS"));
    assertEqual(first.transactionIds.length, 2, "健康结构与真实 DDL 下只差大小写的稳定 ID 必须两条都导入");

    // 健康备份 → verify → restore-new：恢复库的索引键语义必须保留，产品入口可继续导入。
    const backupDir = join(ROOT, `keys-backup-${++seq}`);
    const created = LB.createBackup({ dbPath, outDir: backupDir });
    assert(created.ok === true, `健康 bank 备份应成功：${JSON.stringify(created)}`);
    assert(LB.verifyBackup({ backupDir }).ok === true, "健康 bank 备份应可验证");
    const restored = LB.restoreNew(R4({ backupDir, targetDir: join(ROOT, `keys-restored-${++seq}`) }));
    assert(restored.ok === true, `健康备份应可恢复到全新目标：${JSON.stringify(restored)}`);
    const restoredPath = join(restored.targetDir, LB.TARGET_DATABASE_FILE);
    const restoredConn = new DatabaseSync(restoredPath);
    try {
      assertEqual(S.bankSchemaContract(restoredConn).ok, true, "恢复库必须满足完整索引键语义契约（BINARY 升序普通列）");
      const keys = restoredConn.prepare("SELECT * FROM pragma_index_xinfo('idx_bank_txn_ref')").all()
        .filter((row) => Number(row.key) === 1)
        .map((row) => [String(row.name), String(row.coll).toUpperCase(), Number(row.desc)]);
      assertEqual(JSON.stringify(keys), JSON.stringify([
        ["account_set_id", "BINARY", 0], ["bank_account_id", "BINARY", 0],
        ["source_id", "BINARY", 0], ["bank_ref_id", "BINARY", 0],
      ]), "恢复后 idx_bank_txn_ref 的键语义必须与产品真实 DDL 一致");
    } finally { restoredConn.close(); }
    const restoredImport = okBank(importArgs(join(seed4(backupDir),"workbench.db"), "CASE-REFS-RESTORED", restoredCsvPath));
    assertEqual(restoredImport.transactionIds.length, 2, "恢复库必须仍能导入只差大小写的两条稳定 ID");

    // collation 漂移：先证明它真的改变写入结果（不是等价写法），后文再证明源库 / 快照 / 恢复三入口一致拒绝。
    {
      const probePath = join(ROOT, `keys-collation-probe-${++seq}.db`);
      const source = new DatabaseSync(dbPath);
      try { source.prepare("VACUUM INTO ?").run(probePath); } finally { source.close(); }
      const probe = new DatabaseSync(probePath);
      try {
        probe.exec(`DROP INDEX idx_bank_txn_ref`);
        let collision = null;
        try {
          probe.exec(`CREATE UNIQUE INDEX idx_bank_txn_ref
                         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id COLLATE NOCASE)
                         WHERE bank_ref_id IS NOT NULL`);
        } catch (error) { collision = error; }
        assert(collision && /UNIQUE|constraint/i.test(String(collision.message)),
          "已导入 Ref-A / ref-a 的库改成 COLLATE NOCASE 会直接撞 UNIQUE：collation 改变真实写入结果");
      } finally { probe.close(); }
    }

    // 索引键语义反例：真实产品 DDL 的每一条索引都要逐键一致（seqno 顺序 / collation / 方向 /
    // 表达式 / rowid / 来源 / partial 与真实谓词）。源库、快照、恢复目标三个入口都必须拒绝，
    // 快照同时重算清单字节数与 sha256（摘要自洽），证明拒绝来自结构契约而不是摘要不一致。
    const keysBase = buildBankScenario();
    const keysBasePath = join(keysBase.dir, "workbench.db");
    const keysBaseBackup = join(ROOT, `keys-base-backup-${++seq}`);
    const keysBaseCreated = LB.createBackup({ dbPath: keysBasePath, outDir: keysBaseBackup });
    assert(keysBaseCreated.ok === true, `键语义基线备份应成功：${JSON.stringify(keysBaseCreated)}`);
    assert(LB.verifyBackup({ backupDir: keysBaseBackup }).ok === true, "键语义基线备份应可验证");

    const tamperedBankDatabase = (label, statements) => {
      const file = join(ROOT, `keys-db-${label}-${++seq}.db`);
      const source = new DatabaseSync(keysBasePath);
      try { source.prepare("VACUUM INTO ?").run(file); } finally { source.close(); }
      const conn = new DatabaseSync(file);
      try {
        conn.exec("PRAGMA foreign_keys = OFF");
        conn.exec(statements);
        conn.exec("PRAGMA foreign_keys = ON");
      } finally { conn.close(); }
      return file;
    };
    const assertNoExpressionEcho = (label, details) => {
      assertEqual(details.includes("lower("), false, `${label}：拒绝明细不得回显索引表达式原文`);
    };
    // 源库入口：createBackup 必须直接拒绝，且不生成备份目录。
    const expectSourceRejected = (label, dbFile, kinds = []) => {
      const out = join(ROOT, `keys-source-${label}-${++seq}`);
      const result = LB.createBackup({ dbPath: dbFile, outDir: out });
      assertRejected(result, "source_structure_invalid", `${label} 源库`);
      assertEqual(fs.existsSync(out), false, `${label}：源库被拒绝时不得创建备份目录`);
      const details = JSON.stringify(result.details ?? {});
      for (const kind of kinds) assert(details.includes(kind), `${label}：源库拒绝明细应含 ${kind}，实际 ${details}`);
      assertNoExpressionEcho(label, details);
      return result;
    };
    // 快照入口：把同一份变体写成快照并重算清单字节数 / sha256（摘要自洽），verify 仍拒绝；
    // restore-new 不得生成目标库。
    const expectSnapshotRejected = (label, statements, kinds = []) => {
      const backup = copyBackup(keysBaseBackup, `keys-${label}`);
      tamperSnapshot(backup, statements);
      const result = expectVerifyRejected(backup, "structure_invalid", `${label} 快照`);
      const details = JSON.stringify(result.details ?? {});
      for (const kind of kinds) assert(details.includes(kind), `${label}：快照拒绝明细应含 ${kind}，实际 ${details}`);
      assertNoExpressionEcho(label, details);
      expectRestoreNotCreated(backup, `keys-${label}`);
      return result;
    };

    // 等价重建对照：同样重建但保持真实 BINARY 升序语义，必须通过（证明拒绝来自键语义而非重建本身）。
    const identicalRebuild = tamperedBankDatabase("identical-rebuild",
      `DROP INDEX idx_bank_txn_scope_date;
       CREATE INDEX idx_bank_txn_scope_date ON bank_transactions (account_set_id, bank_account_id, txn_date);`);
    const identicalOut = join(ROOT, `keys-identical-out-${++seq}`);
    const identicalBackup = LB.createBackup({ dbPath: identicalRebuild, outDir: identicalOut });
    assert(identicalBackup.ok === true, `与真实 DDL 同义的重建不得被拒绝：${JSON.stringify(identicalBackup)}`);
    assert(LB.verifyBackup({ backupDir: identicalOut }).ok === true, "同义重建库的备份必须可验证");

    const indexKeyVariants = [
      ["nocase", `DROP INDEX idx_bank_txn_ref;
        CREATE UNIQUE INDEX idx_bank_txn_ref
          ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id COLLATE NOCASE)
          WHERE bank_ref_id IS NOT NULL;`, ["component_index_mismatch", "NOCASE"]],
      ["rtrim", `DROP INDEX idx_bank_txn_scope_date;
        CREATE INDEX idx_bank_txn_scope_date
          ON bank_transactions (account_set_id, bank_account_id, txn_date COLLATE RTRIM);`,
        ["component_index_mismatch", "RTRIM"]],
      ["desc", `DROP INDEX idx_bank_txn_batch_row;
        CREATE UNIQUE INDEX idx_bank_txn_batch_row
          ON bank_transactions (account_set_id, bank_account_id, batch_id, row_index DESC);`,
        ["component_index_mismatch"]],
      ["expression", `DROP INDEX idx_bank_txn_ref;
        CREATE UNIQUE INDEX idx_bank_txn_ref
          ON bank_transactions (account_set_id, bank_account_id, source_id, lower(bank_ref_id))
          WHERE bank_ref_id IS NOT NULL;`, ["component_index_mismatch", "expression"]],
      ["partial-predicate", `DROP INDEX idx_bank_txn_ref;
        CREATE UNIQUE INDEX idx_bank_txn_ref
          ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id)
          WHERE bank_ref_id IS NULL;`, ["component_index_mismatch"]],
      ["extra-unique", "CREATE UNIQUE INDEX idx_bank_txn_summary_extra ON bank_transactions (summary);",
        ["component_index_unexpected", "unexpected_unique_index"]],
      ["origin-substitution", `PRAGMA foreign_keys = OFF;
        CREATE TABLE bank_batch_rows_x (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_set_id INTEGER NOT NULL,
          bank_account_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          row_index INTEGER NOT NULL,
          row_sha256 TEXT NOT NULL,
          row_fingerprint TEXT,
          status TEXT NOT NULL,
          transaction_id INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
          ambiguity_id INTEGER,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          FOREIGN KEY (account_set_id, bank_account_id, batch_id)
            REFERENCES bank_batches(account_set_id, bank_account_id, batch_id) ON DELETE CASCADE
        );
        INSERT INTO bank_batch_rows_x SELECT * FROM bank_batch_rows;
        DROP TABLE bank_batch_rows;
        ALTER TABLE bank_batch_rows_x RENAME TO bank_batch_rows;
        CREATE UNIQUE INDEX bank_batch_rows_named
          ON bank_batch_rows (account_set_id, bank_account_id, batch_id, row_index);
        CREATE INDEX idx_bank_batch_rows_txn ON bank_batch_rows (transaction_id);`,
        ["component_index_missing", "component_index_unexpected"]],
      ["pk-key", `PRAGMA foreign_keys = OFF;
        CREATE TABLE bank_component_migrations_x (
          version INTEGER PRIMARY KEY DESC,
          applied_at TEXT NOT NULL,
          note TEXT
        );
        INSERT INTO bank_component_migrations_x SELECT version, applied_at, note FROM bank_component_migrations;
        DROP TABLE bank_component_migrations;
        ALTER TABLE bank_component_migrations_x RENAME TO bank_component_migrations;`,
        ["rowid_alias"]],
    ];
    for (const [label, statements, kinds] of indexKeyVariants) {
      const file = tamperedBankDatabase(label, statements);
      expectSourceRejected(label, file, kinds);
      expectSnapshotRejected(label, statements, kinds);
      // 产品入口同样失败关闭（不是只在备份工具里拒绝）。
      const stateConn = new DatabaseSync(file, { readOnly: true });
      try {
        assertEqual(S.bankSchemaContract(stateConn).ok, false, `${label}：产品结构契约必须同时拒绝`);
      } finally { stateConn.close(); }
    }

    // 真实写入语义对照：已导入 Ref-A / ref-a 的库改成 COLLATE NOCASE 会直接撞 UNIQUE，
    // 证明 collation 不是「等价写法」，而是改变真实业务写入。
    {
      const probePath = join(ROOT, `keys-collation-probe-${++seq}.db`);
      const source = new DatabaseSync(dbPath);
      try { source.prepare("VACUUM INTO ?").run(probePath); } finally { source.close(); }
      const probe = new DatabaseSync(probePath);
      try {
        probe.exec(`DROP INDEX idx_bank_txn_ref`);
        let collision = null;
        try {
          probe.exec(`CREATE UNIQUE INDEX idx_bank_txn_ref
                         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id COLLATE NOCASE)
                         WHERE bank_ref_id IS NOT NULL`);
        } catch (error) { collision = error; }
        assert(collision && /UNIQUE|constraint/i.test(String(collision.message)),
          "已导入 Ref-A / ref-a 的库改成 COLLATE NOCASE 会直接撞 UNIQUE：collation 改变真实写入结果");
      } finally { probe.close(); }
    }

    // 产品入口在漂移库上同样 exit 5（结构化结构错误），不会静默按 NOCASE 写库。
    const driftFile = tamperedBankDatabase("drift-entry",
      `DROP INDEX idx_bank_txn_ref;
       CREATE UNIQUE INDEX idx_bank_txn_ref
         ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id COLLATE NOCASE)
         WHERE bank_ref_id IS NOT NULL;`);
    const rejected = runBankCli([
      "import", "--db", driftFile, "--account-set", String(keysBase.wire.setA), "--bank-account", "BANK-A",
      "--source", "local-statement", "--period", "2026-01", "--batch", "CASE-REFS-TAMPERED",
      "--csv", csvPath, "--mapping", mappingPath,
    ]);
    assertEqual(rejected.status, 5, `漂移库上的导入必须 exit 5（实际 ${rejected.status}：${rejected.stdout}${rejected.stderr}）`);
    assert(rejected.json && rejected.json.ok === false, "漂移库上的导入不得成功");
    assertEqual(rejected.json.error.code, "bank_schema_corrupt", "漂移库必须给结构化结构错误");
  });
} finally {
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
  try { if (!process.env.KEEP_FIXTURES) fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 忽略 */ }
}
