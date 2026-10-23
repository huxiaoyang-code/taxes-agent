#!/usr/bin/env node
/**
 * LOCAL-04 银行对账 CLI 端到端回归（每个命令都是独立子进程）。
 *
 * 覆盖：显式 --db 强制、无参 / 拼错路径不创建默认库、新库真实创建入口、
 * 预检 / 导入 / 批次 / 流水 / 候选 / 确认 / 取消 / 再确认 / 歧义判定 / 余额调节 / 状态 / 审计
 * 的跨进程持久化与幂等；错误码与退出码；已有库无备份时拒绝迁移（exit 5）。
 *
 * 全部使用合成临时目录、合成企业与合成 CSV，不读取真实账套 / 银行文件 / 凭据。
 * 运行：node test/bank-reconcile-cli.test.mjs（在 06-workbench 目录）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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

const CLI = join(WORKBENCH, "scripts", "bank-reconcile.mjs");
const baseDir = mkdtempSync(join(tmpdir(), "wb-bank-cli-"));
const dbPath = join(baseDir, "workbench.db");

process.on("exit", () => {
  try { if (db) db.close(); } catch { /* ignore */ }
  try { rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
});

function run(args, { env = {} } = {}) {
  const clean = { ...process.env };
  clean.WORKBENCH_DATA_DIR = join(fixtureRoot, "fallback");
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: WORKBENCH, env: { ...clean, ...env }, encoding: "utf8", timeout: 120000,
  });
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function okJson(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")} exit=${result.status}\nSTDOUT ${result.stdout}\nSTDERR ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  return parsed;
}

function expectError(args, code, status, options) {
  const result = run(args, options);
  assert.equal(result.status, status, `${args.join(" ")} exit=${result.status}\nSTDOUT ${result.stdout}\nSTDERR ${result.stderr}`);
  assert.equal(result.stdout, "", "失败时不得往 stdout 写成功结果");
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, code, `期望 ${code}，实际 ${parsed.error.code}：${parsed.error.message}`);
  assert.ok(!/SELECT |INSERT INTO|UPDATE |constraint failed at|at Object\./i.test(result.stderr),
    "错误输出不得包含原始 SQL / 堆栈");
  return parsed;
}

const file = (name, content) => {
  const path = join(baseDir, name);
  writeFileSync(path, content, "utf8");
  return path;
};
const money = (text) => text;

// ------------------------------------------------------------------ 新库创建 + 合成账务
let db;
let bankCoreUserVersion;
let A;
let setA;
let setB;
let setC;
let voucherOut;
let voucherIn;
let entryOut;
let entryIn;

test("init-db：在不存在路径上通过真实创建入口建库并初始化 bank_*；已存在则拒绝", async () => {
  const created = okJson(["init-db", "--db", dbPath]);
  assert.equal(created.bankSchema.migrated, true);
  assert.equal(created.bankSchema.creation, "fresh-database");
  assert.equal(created.importSchema.to, 4, "当前核心已到 schema v4（资产补项）");
  assert.ok(existsSync(dbPath));
  expectError(["init-db", "--db", dbPath], "db_already_exists", 2);
  expectError(["init-db", "--db", join(baseDir, "other.db")], "init_db_filename_required", 2);

  // 用真实会计 API 在同一库建两个企业账套、期初、posted / 草稿凭证。
  process.env.WORKBENCH_DATA_DIR = baseDir;
  ({ db } = await import("../server/db.mjs"));
  bankCoreUserVersion = db.prepare("PRAGMA user_version").get().user_version;
  A = await import("../server/accounting.mjs");

  setA = A.createAccountSet({ name: "合成甲公司", start_period: "2026-01" });
  A.setOpeningBalances(setA.id, [
    { code: "1002", debit: 800, credit: 0 },
    { code: "3001", debit: 0, credit: 800 },
  ]);
  voucherIn = A.createVoucher(setA.id, {
    period: "2026-01", voucher_date: "2026-01-10", status: "posted",
    entries: [{ code: "1002", debit: 300, credit: 0 }, { code: "1122", debit: 0, credit: 300 }],
  });
  voucherOut = A.createVoucher(setA.id, {
    period: "2026-01", voucher_date: "2026-01-11", status: "posted",
    entries: [{ code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 }],
  });
  A.createVoucher(setA.id, {
    period: "2026-01", voucher_date: "2026-01-12", status: "draft",
    entries: [{ code: "1002", debit: 50, credit: 0 }, { code: "1122", debit: 0, credit: 50 }],
  });
  setB = A.createAccountSet({ name: "合成乙公司", start_period: "2026-01" });
  A.setOpeningBalances(setB.id, [
    { code: "1002", debit: 100, credit: 0 },
    { code: "3001", debit: 0, credit: 100 },
  ]);
  entryOut = db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'`).get(voucherOut.id).id;
  entryIn = db.prepare(`SELECT id FROM voucher_entries WHERE voucher_id=? AND code='1002'`).get(voucherIn.id).id;

  // 第三个账套：余额调节固定手算场景（两边期初 800.00，未达收 300/500，未达付 100/100）。
  setC = A.createAccountSet({ name: "合成丙公司", start_period: "2026-01" });
  A.setOpeningBalances(setC.id, [
    { code: "1002", debit: 800, credit: 0 },
    { code: "3001", debit: 0, credit: 800 },
  ]);
  A.createVoucher(setC.id, {
    period: "2026-01", voucher_date: "2026-01-10", status: "posted",
    entries: [{ code: "1002", debit: 300, credit: 0 }, { code: "1122", debit: 0, credit: 300 }],
  });
  A.createVoucher(setC.id, {
    period: "2026-01", voucher_date: "2026-01-11", status: "posted",
    entries: [{ code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 }],
  });
});

const mappingPath = file("mapping.json", JSON.stringify({
  columns: { date: "日期", summary: "摘要", amount: "金额", direction: "方向", refId: "流水号" },
  amountMode: "amount_direction",
  directionLabels: { inflow: ["收"], outflow: ["付"] },
  currency: "CNY",
}, null, 2));
const mappingNoRefPath = file("mapping-noref.json", JSON.stringify({
  columns: { date: "日期", summary: "摘要", amount: "金额", direction: "方向" },
  amountMode: "amount_direction",
  directionLabels: { inflow: ["收"], outflow: ["付"] },
  currency: "CNY",
}, null, 2));
const csvA = file("statement-a.csv", "\uFEFF日期,摘要,金额,方向,流水号\r\n"
  + "2026-01-20,客户回款,\"500.00\",收,CLI-1\r\n"
  + "2026-01-11,支付货款,100.00,付,CLI-2\r\n");

test("CLI 账户登记：两企业各自银行账户，跨账套引用与重复科目被拒绝", () => {
  const a = okJson(["account-register", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--source", "local-statement", "--gl-code", "1002",
    "--name", "基本户", "--number", "6222****0001"]);
  assert.equal(a.created, true);
  assert.equal(a.account.currency, "CNY");
  const b = okJson(["account-register", "--db", dbPath, "--account-set", String(setB.id),
    "--bank-account", "BANK-B", "--source", "local-statement", "--gl-code", "1002"]);
  assert.equal(b.created, true);

  const list = okJson(["accounts", "--db", dbPath, "--account-set", String(setA.id)]);
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].bankAccountId, "BANK-A");

  expectError(["account-register", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A2", "--source", "local-statement", "--gl-code", "1002"],
  "bank_gl_account_already_bound", 3);
  expectError(["account-register", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-U", "--source", "local-statement", "--gl-code", "1002", "--currency", "USD"],
  "currency_unsupported", 2);
  expectError(["account-register", "--db", dbPath, "--account-set", "99999",
    "--bank-account", "BANK-X", "--source", "local-statement", "--gl-code", "1002"],
  "account_set_not_found", 2);
});

test("CLI 预检不写库；导入 / 同批重试 / 同文件新批次都幂等", () => {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions`).get().n;
  const preview = okJson(["import-preview", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--source", "local-statement", "--period", "2026-01",
    "--csv", csvA, "--mapping", mappingPath]);
  assert.equal(preview.preview.ok, true, JSON.stringify(preview.preview.errors));
  assert.equal(preview.preview.stats.validRows, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions`).get().n, before, "预检不得写库");

  const imported = okJson(["import", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--source", "local-statement", "--period", "2026-01",
    "--batch", "CLI-A1", "--csv", csvA, "--mapping", mappingPath]);
  assert.equal(imported.replay, false);
  assert.equal(imported.batch.status, "completed");
  assert.equal(imported.batch.importedRows, 2);

  const replay = okJson(["import", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--source", "local-statement", "--period", "2026-01",
    "--batch", "CLI-A1", "--csv", csvA, "--mapping", mappingPath]);
  assert.equal(replay.replay, true);
  assert.equal(replay.replayKind, "same-batch");

  const fileReplay = okJson(["import", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--source", "local-statement", "--period", "2026-01",
    "--batch", "CLI-A2", "--csv", csvA, "--mapping", mappingPath]);
  assert.equal(fileReplay.replay, true);
  assert.equal(fileReplay.replayOfBatchId, "CLI-A1");
  assert.equal(fileReplay.batch.noNewTransactions, undefined);
  assert.equal(fileReplay.batch.result.noNewTransactions, true);

  const txns = okJson(["transactions", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A"]);
  assert.equal(txns.transactions.length, 2);
  assert.equal(txns.totals.inflowCents, 50000);
  assert.equal(txns.totals.outflowCents, 10000);

  const batches = okJson(["batches", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A"]);
  assert.equal(batches.batches.length, 2);
  assert.ok(batches.batches.every((b) => b.status === "completed"));
});

test("CLI 候选 / 确认 / 取消 / 再确认跨进程持久；草稿不参与候选", () => {
  const txns = okJson(["transactions", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--status", "unmatched"]);
  const outflow = txns.transactions.find((t) => t.direction === "outflow");
  const inflow = txns.transactions.find((t) => t.direction === "inflow");

  const candOut = okJson(["candidates", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--transaction", String(outflow.transactionId)]);
  assert.equal(candOut.selection, "single");
  assert.equal(candOut.candidates[0].voucherId, voucherOut.id);
  assert.equal(candOut.candidates[0].entryId, entryOut);

  // 未确认前不能取消匹配；确认必须给理由。
  expectError(["confirm", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--transaction", String(outflow.transactionId), "--voucher", String(voucherOut.id),
    "--entry", String(entryOut), "--reason", ""], "missing_argument", 2);

  const confirmed = okJson(["confirm", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--transaction", String(outflow.transactionId),
    "--voucher", String(voucherOut.id), "--entry", String(entryOut), "--reason", "回单与凭证一致"]);
  assert.equal(confirmed.match.status, "confirmed");
  assert.equal(confirmed.match.snapshot.amountCents, 10000);

  expectError(["confirm", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--transaction", String(outflow.transactionId), "--voucher", String(voucherOut.id),
    "--entry", String(entryOut), "--reason", "重复确认"], "match_already_confirmed", 3);

  // 草稿凭证的分录不能确认。
  const draft = db.prepare(`SELECT v.id AS voucher_id, e.id AS entry_id FROM vouchers v
                              JOIN voucher_entries e ON e.voucher_id=v.id
                             WHERE v.account_set_id=? AND v.status='draft' AND e.code='1002'`).get(setA.id);
  expectError(["confirm", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--transaction", String(inflow.transactionId), "--voucher", String(draft.voucher_id),
    "--entry", String(draft.entry_id), "--reason", "草稿"], "voucher_not_posted", 3);

  const matches = okJson(["matches", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A"]);
  assert.equal(matches.matches.length, 1);
  const matchId = matches.matches[0].matchId;

  expectError(["cancel", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--match", String(matchId), "--reason", ""], "missing_argument", 2);
  const cancelled = okJson(["cancel", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--match", String(matchId), "--reason", "凭证摘要录错，重新核对"]);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.match.status, "cancelled");
  const cancelledAgain = okJson(["cancel", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--match", String(matchId), "--reason", "重复取消"]);
  assert.equal(cancelledAgain.idempotent, true);

  const reconfirmed = okJson(["confirm", "--db", dbPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-A", "--transaction", String(outflow.transactionId),
    "--voucher", String(voucherOut.id), "--entry", String(entryOut), "--reason", "改正后重新确认"]);
  assert.notEqual(reconfirmed.match.matchId, matchId);

  const status = okJson(["status", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A"]);
  assert.equal(status.matches.confirmed, 1);
  assert.equal(status.matches.cancelled, 1);
  assert.equal(status.transactions.matched, 1);

  const audit = okJson(["audit", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A"]);
  const types = audit.events.map((e) => e.eventType);
  assert.ok(types.includes("match_confirmed"));
  assert.ok(types.includes("match_cancelled"));
  assert.ok(audit.events.filter((e) => e.eventType === "match_cancelled").length === 1, "重复取消不得重复刷审计");
});

test("CLI 余额调节：固定手算 140000/140000 差额 0；1 分差异降级为待核对；text 输出可读", () => {
  const csvC = file("statement-c.csv", "日期,摘要,金额,方向,流水号\n"
    + "2026-01-20,银行收款,500.00,收,REC-C1\n"
    + "2026-01-21,银行付款,100.00,付,REC-C2\n");
  okJson(["account-register", "--db", dbPath, "--account-set", String(setC.id),
    "--bank-account", "BANK-C", "--source", "local-statement", "--gl-code", "1002"]);
  const imported = okJson(["import", "--db", dbPath, "--account-set", String(setC.id),
    "--bank-account", "BANK-C", "--source", "local-statement", "--period", "2026-01",
    "--batch", "CLI-C1", "--csv", csvC, "--mapping", mappingPath]);
  assert.equal(imported.batch.importedRows, 2);

  const reconciled = okJson(["reconcile", "--db", dbPath, "--account-set", String(setC.id),
    "--bank-account", "BANK-C", "--period", "2026-01", "--as-of", "2026-01-31",
    "--statement-open", "800.00", "--statement-close", "1200.00",
    "--coverage-from", "2026-01-01", "--coverage-to", "2026-01-31",
    "--statement-source", "合成 2026-01 银行对账单"]);
  assert.equal(reconciled.status, "reconciled");
  assert.equal(reconciled.book.closingCents, 100000);
  assert.equal(reconciled.statement.computedCloseCents, 120000);
  assert.equal(reconciled.outstanding.totals.bookReceivedBankMissingCents, 30000);
  assert.equal(reconciled.outstanding.totals.bookPaidBankMissingCents, 10000);
  assert.equal(reconciled.outstanding.totals.bankReceivedBookMissingCents, 50000);
  assert.equal(reconciled.outstanding.totals.bankPaidBookMissingCents, 10000);
  assert.equal(reconciled.adjusted.bookCents, 140000);
  assert.equal(reconciled.adjusted.bankCents, 140000);
  assert.equal(reconciled.adjusted.differenceCents, 0);

  const cents = okJson(["reconcile", "--db", dbPath, "--account-set", String(setC.id),
    "--bank-account", "BANK-C", "--period", "2026-01", "--as-of", "2026-01-31",
    "--statement-open", "800.00", "--statement-close", "1199.99",
    "--coverage-from", "2026-01-01", "--coverage-to", "2026-01-31",
    "--statement-source", "合成对账单（期末少 1 分）"]);
  assert.equal(cents.status, "pending_review");
  assert.equal(cents.statement.computedCloseCents, 120000);
  assert.equal(cents.statement.differenceCents, -1);
  assert.equal(cents.adjusted.bookCents, 140000);
  assert.equal(cents.adjusted.bankCents, 139999);
  assert.equal(cents.adjusted.differenceCents, 1);
  assert.ok(cents.issues.some((i) => i.code === "statement_balance_mismatch"));

  const text = run(["reconcile", "--db", dbPath, "--account-set", String(setC.id),
    "--bank-account", "BANK-C", "--period", "2026-01", "--as-of", "2026-01-31",
    "--statement-open", "800.00", "--statement-close", "1200.00",
    "--coverage-from", "2026-01-01", "--coverage-to", "2026-01-31",
    "--statement-source", "合成 2026-01 银行对账单", "--format", "text"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /调节后账面 = 1400\.00/);
  assert.match(text.stdout, /调节后银行 = 1400\.00/);
  assert.match(text.stdout, /差额 = 0\.00/);
});

test("CLI 无稳定 ID 疑似重复：保存证据、人工判定、跨进程幂等", () => {
  const csvDup = file("amb-1.csv", "日期,摘要,金额,方向\n2026-01-05,同摘要,50.00,收\n2026-01-05,同摘要,50.00,收\n");
  const csvOverlap = file("amb-2.csv", "日期,摘要,金额,方向\n2026-01-05,同摘要,50.00,收\n");
  const first = okJson(["import", "--db", dbPath, "--account-set", String(setB.id),
    "--bank-account", "BANK-B", "--source", "local-statement", "--period", "2026-01",
    "--batch", "AMB-1", "--csv", csvDup, "--mapping", mappingNoRefPath]);
  assert.equal(first.batch.status, "completed");
  assert.equal(first.batch.importedRows, 2, "文件内同特征两条记录可能是两笔，必须都保留");

  const second = okJson(["import", "--db", dbPath, "--account-set", String(setB.id),
    "--bank-account", "BANK-B", "--source", "local-statement", "--period", "2026-01",
    "--batch", "AMB-2", "--csv", csvOverlap, "--mapping", mappingNoRefPath]);
  assert.equal(second.batch.status, "pending_review");
  assert.equal(second.batch.ambiguousRows, 1);

  const pending = okJson(["ambiguities", "--db", dbPath, "--account-set", String(setB.id), "--bank-account", "BANK-B"]);
  assert.equal(pending.pending, 1);
  const ambiguityId = pending.ambiguities[0].ambiguityId;
  assert.equal(pending.ambiguities[0].candidateTransactionIds.length, 2);

  expectError(["resolve-ambiguity", "--db", dbPath, "--account-set", String(setB.id), "--bank-account", "BANK-B",
    "--ambiguity", String(ambiguityId), "--decision", "maybe", "--reason", "x"], "ambiguity_decision_invalid", 2);
  expectError(["resolve-ambiguity", "--db", dbPath, "--account-set", String(setB.id), "--bank-account", "BANK-B",
    "--ambiguity", String(ambiguityId), "--decision", "same", "--reason", "x"], "ambiguity_target_required", 3);

  const resolved = okJson(["resolve-ambiguity", "--db", dbPath, "--account-set", String(setB.id),
    "--bank-account", "BANK-B", "--ambiguity", String(ambiguityId),
    "--decision", "distinct", "--reason", "两张回单是两笔不同交易"]);
  assert.equal(resolved.resolved, true);
  const idempotent = okJson(["resolve-ambiguity", "--db", dbPath, "--account-set", String(setB.id),
    "--bank-account", "BANK-B", "--ambiguity", String(ambiguityId),
    "--decision", "distinct", "--reason", "重复提交"]);
  assert.equal(idempotent.idempotent, true);
  const after = okJson(["ambiguities", "--db", dbPath, "--account-set", String(setB.id), "--bank-account", "BANK-B"]);
  assert.equal(after.pending, 0);
  const txns = okJson(["transactions", "--db", dbPath, "--account-set", String(setB.id), "--bank-account", "BANK-B"]);
  assert.equal(txns.transactions.length, 3, "判定不同一笔后新增 1 笔");
});

test("CLI 错误路径：显式 --db、无默认库、业务冲突退出码、非本产品库", () => {
  // 无参 / 未知命令 / 缺 --db 都不能创建默认库。
  expectError([], "usage_error", 2);
  expectError(["unknown-command"], "unknown_command", 2);
  expectError(["transactions", "--account-set", "1"], "missing_argument", 2);
  expectError(["transactions", "--db", join(baseDir, "missing.db"), "--account-set", "1"],
    "db_not_found", 2);
  assert.equal(existsSync(join(WORKBENCH, "data")), false, "CLI 不得创建默认 data/workbench.db");

  const plain = file("not-a-db.txt", "这不是数据库\n");
  expectError(["transactions", "--db", plain, "--account-set", "1"], "db_not_workbench", 2);

  // 业务冲突：同批次改内容。
  const conflictCsv = file("conflict.csv", "日期,摘要,金额,方向,流水号\n2026-01-20,客户回款,501.00,收,CLI-1\n");
  expectError(["import", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--source", "local-statement", "--period", "2026-01", "--batch", "CLI-A1",
    "--csv", conflictCsv, "--mapping", mappingPath], "batch_content_conflict", 3);
  // 预检失败给行级证据（exit 3，不写任何流水）。
  const badAmount = file("bad.csv", "日期,摘要,金额,方向,流水号\n2026-01-20,x,1.234,收,BAD-1\n");
  const rejected = expectError(["import", "--db", dbPath, "--account-set", String(setA.id), "--bank-account", "BANK-A",
    "--source", "local-statement", "--period", "2026-01", "--batch", "CLI-BAD",
    "--csv", badAmount, "--mapping", mappingPath], "import_rejected", 3);
  assert.equal(rejected.error.details.errors[0].code, "amount_precision");

  // 已有库有账务结构但没有 bank_*：无备份实现时返回 migration_backup_unavailable（exit 5）。
  const legacyDir = mkdtempSync(join(tmpdir(), "wb-bank-cli-legacy-"));
  try {
    const legacyPath = join(legacyDir, "workbench.db");
    const bootstrap = spawnSync(process.execPath, ["-e", "await import('./server/db.mjs')"], {
      cwd: WORKBENCH, env: { ...process.env, WORKBENCH_DATA_DIR: legacyDir }, encoding: "utf8",
    });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    assert.ok(existsSync(legacyPath));
    expectError(["status", "--db", legacyPath, "--account-set", "1", "--bank-account", "BANK-A"],
      "migration_backup_unavailable", 5);
    expectError(["status", "--db", legacyPath, "--account-set", "1", "--bank-account", "BANK-A",
      "--backup-service", join(legacyDir, "missing-backup.mjs")], "backup_service_not_found", 5);
    const probe = new DatabaseSync(legacyPath);
    try {
      const bankTables = probe.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'bank_%'`).get().n;
      assert.equal(Number(bankTables), 0, "备份门槛未过时不得创建任何 bank_* 表");
    } finally { probe.close(); }
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test("CLI 帮助：不接触数据库、不创建库", () => {
  const help = okJson(["help"]);
  assert.ok(help.commands.some((c) => c.command === "reconcile"));
  const flagHelp = run(["--help"]);
  assert.equal(flagHelp.status, 0);
  assert.match(flagHelp.stdout, /usage/);
  assert.equal(existsSync(join(WORKBENCH, "data")), false);
});

test("CLI 每一步都真实持久化：重新打开库能看到批次、流水、匹配与对账运行记录", () => {
  const probe = new DatabaseSync(dbPath);
  try {
    probe.exec("PRAGMA foreign_keys = ON");
    const tables = {
      batches: Number(probe.prepare(`SELECT COUNT(*) AS n FROM bank_batches`).get().n),
      transactions: Number(probe.prepare(`SELECT COUNT(*) AS n FROM bank_transactions`).get().n),
      rows: Number(probe.prepare(`SELECT COUNT(*) AS n FROM bank_batch_rows`).get().n),
      matches: Number(probe.prepare(`SELECT COUNT(*) AS n FROM bank_matches`).get().n),
      ambiguities: Number(probe.prepare(`SELECT COUNT(*) AS n FROM bank_ambiguities`).get().n),
      audits: Number(probe.prepare(`SELECT COUNT(*) AS n FROM bank_audit_events`).get().n),
      reconcileRuns: Number(probe.prepare(`SELECT COUNT(*) AS n FROM bank_reconcile_runs`).get().n),
    };
    for (const [name, value] of Object.entries(tables)) assert.ok(value > 0, `${name} 必须持久化`);
    const globalVersion = Number(probe.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get().v);
    assert.equal(globalVersion, 4, "银行组件不得改动全局迁移版本");
    const userVersion = Number(Object.values(probe.prepare(`PRAGMA user_version`).get())[0]);
    assert.equal(userVersion, bankCoreUserVersion, "后续银行命令不得改写创建nonce");
    assert.equal(readFileSync(dbPath).length > 0, true);
  } finally { probe.close(); }
});

// ------------------------------------------------------------------ 首轮独立审查：组件结构契约（CLI 旁路）
test("CLI 组件结构契约损坏：未来版本 / 缺表在任何命令动作前拒绝（exit 5）且不写入", () => {
  const futurePath = join(baseDir, "contract-future.db");
  const missingPath = join(baseDir, "contract-missing-table.db");
  // WAL 模式下直接复制文件不安全：用一致快照导出，再在副本上制造结构偏差。
  db.prepare("VACUUM INTO ?").run(futurePath);
  db.prepare("VACUUM INTO ?").run(missingPath);

  const tableCounts = (path) => {
    const conn = new DatabaseSync(path);
    try {
      const names = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
        .map((r) => String(r.name)).filter((n) => n.startsWith("bank_")).sort();
      const counts = Object.fromEntries(names.map((n) => [n, Number(conn.prepare(`SELECT COUNT(*) AS n FROM ${n}`).get().n)]));
      const tables = Object.fromEntries(conn.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all().map((r) => [String(r.name), 1]));
      return { counts, tables };
    } finally { conn.close(); }
  };

  // 1) 组件版本行被改成未来版本（v2）：不得被当成 already-initialized 放行。
  {
    const conn = new DatabaseSync(futurePath);
    try {
      conn.prepare(`INSERT INTO bank_component_migrations (version, applied_at) VALUES (2, ?)`)
        .run(new Date().toISOString());
    } finally { conn.close(); }
  }
  const futureBefore = tableCounts(futurePath);
  expectError(["status", "--db", futurePath, "--account-set", String(setA.id), "--bank-account", "BANK-A"],
    "bank_schema_future_version", 5);
  expectError(["account-register", "--db", futurePath, "--account-set", String(setA.id),
    "--bank-account", "BANK-FUTURE", "--source", "local-statement", "--gl-code", "1002"],
  "bank_schema_future_version", 5);
  assert.deepEqual(tableCounts(futurePath), futureBefore, "未来版本拒绝时不得写入任何 bank_* 数据");

  // 2) 缺少组件表：不得用 CREATE IF NOT EXISTS 静默修补，写入前就拒绝。
  {
    const conn = new DatabaseSync(missingPath);
    try { conn.exec("DROP TABLE bank_reconcile_runs"); } finally { conn.close(); }
  }
  const missingBefore = tableCounts(missingPath);
  const rejected = expectError(["account-register", "--db", missingPath, "--account-set", String(setA.id),
    "--bank-account", "BANK-MISSING", "--source", "local-statement", "--gl-code", "1002"],
  "bank_schema_corrupt", 5);
  assert.ok(rejected.error.details.problems.some((p) => p.code === "bank_schema_table_missing"
    && p.detail.table === "bank_reconcile_runs"), "必须给出结构化结构问题证据");
  const missingAfter = tableCounts(missingPath);
  assert.deepEqual(missingAfter, missingBefore, "结构损坏拒绝时不得写入或补建任何 bank_* 表");
  assert.equal(missingAfter.tables.bank_reconcile_runs, undefined, "损坏的表不得被静默重建");

  rmSync(futurePath, { force: true });
  rmSync(missingPath, { force: true });
});

test("CLI 版本表形状损坏：status / 写入命令都结构化拒绝（exit 5），不显示原始 SQL 错误也不写入", () => {
  const brokenPath = join(baseDir, "contract-broken-version.db");
  db.prepare("VACUUM INTO ?").run(brokenPath);
  {
    const conn = new DatabaseSync(brokenPath);
    try {
      // 只损坏版本表形状：version 列被改名（旧实现会直接 SELECT version 抛 ERR_SQLITE_ERROR）。
      conn.exec(`ALTER TABLE bank_component_migrations RENAME COLUMN version TO broken_version`);
    } finally { conn.close(); }
  }
  const snapshot = (path) => {
    const conn = new DatabaseSync(path);
    try {
      const names = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
        .map((r) => String(r.name)).sort();
      const counts = Object.fromEntries(names.map((n) => [n,
        Number(conn.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).get().n)]));
      return { names, counts };
    } finally { conn.close(); }
  };
  const before = snapshot(brokenPath);

  for (const args of [
    ["status", "--db", brokenPath, "--account-set", String(setA.id), "--bank-account", "BANK-A"],
    ["account-register", "--db", brokenPath, "--account-set", String(setA.id),
      "--bank-account", "BANK-BROKEN", "--source", "local-statement", "--gl-code", "1002"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 5, `${args[0]} exit=${result.status}\nSTDERR ${result.stderr}`);
    assert.equal(result.stdout, "", "失败时不得输出成功结果");
    assert.doesNotMatch(result.stderr, /ERR_SQLITE|SQLITE_ERROR|no such column|PRAGMA/i,
      "不得显示原始 SQLite 错误 / SQL 文本");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.code, "bank_schema_corrupt");
    assert.ok(parsed.error.details.problems.some((p) => p.code === "bank_schema_version_table_corrupt"
      && p.detail.table === "bank_component_migrations" && p.detail.missing.includes("version")),
    "必须给出版本表形状损坏的结构化证据");
  }

  assert.deepEqual(snapshot(brokenPath), before, "版本表形状损坏拒绝时不得写入 / 补建任何表");
  rmSync(brokenPath, { force: true });
});

test("CLI 索引键语义漂移：COLLATE NOCASE / DESC / 表达式在任何命令动作前拒绝（exit 5）且不写入", () => {
  const snapshot = (path) => {
    const conn = new DatabaseSync(path);
    try {
      const names = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
        .map((r) => String(r.name)).filter((name) => name.startsWith("bank_")).sort();
      const counts = Object.fromEntries(names.map((name) => [name,
        Number(conn.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n)]));
      return { names, counts };
    } finally { conn.close(); }
  };
  const cases = [
    ["nocase", `DROP INDEX idx_bank_txn_ref;
                CREATE UNIQUE INDEX idx_bank_txn_ref
                  ON bank_transactions (account_set_id, bank_account_id, source_id, bank_ref_id COLLATE NOCASE)
                  WHERE bank_ref_id IS NOT NULL`, "idx_bank_txn_ref"],
    ["desc", `DROP INDEX idx_bank_txn_batch_row;
              CREATE UNIQUE INDEX idx_bank_txn_batch_row
                ON bank_transactions (account_set_id, bank_account_id, batch_id, row_index DESC)`, "idx_bank_txn_batch_row"],
    ["expression", `DROP INDEX idx_bank_txn_fingerprint;
                    CREATE INDEX idx_bank_txn_fingerprint
                      ON bank_transactions (account_set_id, bank_account_id, source_id, lower(row_fingerprint))`, "idx_bank_txn_fingerprint"],
  ];
  for (const [label, sql, indexName] of cases) {
    const path = join(baseDir, `contract-keys-${label}.db`);
    db.prepare("VACUUM INTO ?").run(path);
    {
      const conn = new DatabaseSync(path);
      try { conn.exec(sql); } finally { conn.close(); }
    }
    const before = snapshot(path);
    for (const args of [
      ["status", "--db", path, "--account-set", String(setA.id), "--bank-account", "BANK-A"],
      ["account-register", "--db", path, "--account-set", String(setA.id),
        "--bank-account", `BANK-${label.toUpperCase()}`, "--source", "local-statement", "--gl-code", "1002"],
    ]) {
      const result = run(args);
      assert.equal(result.status, 5, `${label}/${args[0]} exit=${result.status}\nSTDERR ${result.stderr}`);
      assert.equal(result.stdout, "", `${label}: 失败时不得输出成功结果`);
      const parsed = JSON.parse(result.stderr);
      assert.equal(parsed.error.code, "bank_schema_corrupt", `${label}: 必须给结构错误`);
      assert.ok(parsed.error.details.problems.some((p) => p.code === "bank_schema_index_mismatch"
        && p.detail.index === indexName), `${label}: 必须给出 ${indexName} 的键语义不符证据`);
    }
    assert.deepEqual(snapshot(path), before, `${label}: 拒绝时不得写入 / 补建任何 bank_* 表`);
    rmSync(path, { force: true });
  }
});


test("真实 init-db 在 core3/4 旧业务替换与同 inode 填充后于核心 DDL/WAL/迁移前拒绝", () => {
  for (const version of [3, 4]) {
    const donorDir = fixtureFs.mkdtempSync(join(fixtureRoot, `donor-v${version}-`));
    const donorPath = join(donorDir, "workbench.db");
    const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const {db}=await import(${JSON.stringify(new URL("../server/db.mjs", import.meta.url).href)});
      const A=await import(${JSON.stringify(new URL("../server/accounting.mjs", import.meta.url).href)});
      const set=A.createAccountSet({name:"fresh guard 合成业务",start_period:"2026-01"});
      A.createVoucher(set.id,{period:"2026-01",voucher_date:"2026-01-01",status:"posted",
        entries:[{code:"1002",debit:10,credit:0},{code:"3001",debit:0,credit:10}]});
      db.close();
    `], { cwd: WORKBENCH, env: { ...process.env, WORKBENCH_DATA_DIR: donorDir }, encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stderr);
    if (version === 3) {
      const donor = new DatabaseSync(donorPath);
      donor.exec("PRAGMA foreign_keys=OFF");
      for (const col of ["acquired_period", "opening_accumulated", "ledger_status", "ledger_note", "origin"])
        donor.exec(`ALTER TABLE asset_cards DROP COLUMN ${col}`);
      donor.exec("DELETE FROM schema_migrations WHERE version=4; UPDATE schema_backups SET version=3 WHERE version=4");
      donor.close();
    }
    const before = readFileSync(donorPath);
    for (const mode of ["replace", "same-inode"]) {
      const dir = fixtureFs.mkdtempSync(join(fixtureRoot, `attack-v${version}-${mode}-`));
      const target = join(dir, "workbench.db");
      const hook = join(dir, "fault-hook.mjs");
      const injection = mode === "replace"
        ? `bankFaultFs.renameSync(abs, abs + ".owned"); bankFaultFs.copyFileSync(${JSON.stringify(donorPath)}, abs);`
        : `bankFaultFs.writeFileSync(abs, bankFaultFs.readFileSync(${JSON.stringify(donorPath)}));`;
      writeFileSync(hook, `
        import {registerHooks} from "node:module";
        registerHooks({load(url,context,nextLoad){
          const result=nextLoad(url,context);
          if(url.endsWith("/server/bank-storage.mjs")){
            const source=String(result.source);
            if(!source.includes("    return receipt;")) throw new Error("fault hook did not match");
            return {...result, source:'import * as bankFaultFs from "node:fs";\\n'+
              source.replace("    return receipt;",${JSON.stringify(injection)}+"    return receipt;")};
          }
          return result;
        }});
      `);
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, CLI, "init-db", "--db", target], {
        cwd: WORKBENCH, env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 120000,
      });
      assert.equal(result.status, 3, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code,
        mode === "replace" ? "fresh_database_replaced" : "fresh_database_foreign_content");
      assert.deepEqual(readFileSync(target), before, `v${version} ${mode}: old business bytes unchanged`);
      assert.equal(existsSync(target + "-wal"), false);
      assert.equal(existsSync(target + "-shm"), false);
      assert.deepEqual(fixtureFs.readdirSync(dir).sort(),
        ["fault-hook.mjs", "workbench.db", ...(mode === "replace" ? ["workbench.db.owned"] : [])].sort(),
        "no migration or bank backup directory is created");
      const check = new DatabaseSync(target, { readOnly: true });
      try {
        assert.equal(check.prepare("SELECT COUNT(*) n FROM vouchers").get().n, 1);
        assert.equal(check.prepare("SELECT MAX(version) v FROM schema_migrations").get().v, version);
        assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'bank_%'").get().n, 0);
      } finally { check.close(); }
    }
  }
});

test("真实 init-db 在文件预检后同 inode 填充旧 WAL 库：拒绝且不产生 sidecar", () => {
  const dir = fixtureFs.mkdtempSync(join(fixtureRoot, "late-wal-"));
  const donorPath = join(dir, "donor.db"), target = join(dir, "workbench.db");
  const donor = new DatabaseSync(donorPath);
  donor.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=73;
    CREATE TABLE existing_business(id INTEGER); INSERT INTO existing_business VALUES(991);
    CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(3);`);
  donor.close();
  const before = readFileSync(donorPath);
  assert.equal(before[18], 2, "donor must retain WAL header after normal close");
  const hook = join(dir, "late-hook.mjs");
  const search = "  assertPristineCreationFiles(claim);";
  const injection = `lateFs.writeFileSync(claim.dbPath,lateFs.readFileSync(${JSON.stringify(donorPath)}));`;
  writeFileSync(hook, `import {registerHooks} from "node:module";
    registerHooks({load(url,ctx,next){const r=next(url,ctx);
      if(!url.endsWith("/server/bank-storage.mjs"))return r;
      const s=String(r.source);const search=${JSON.stringify(search)};
      if(s.split(search).length!==2)throw new Error("late hook mismatch");
      return {...r,source:'import * as lateFs from "node:fs";\\n'+s.replace(search,search+${JSON.stringify(injection)})};}});`);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, CLI, "init-db", "--db", target], {
    cwd: WORKBENCH, env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 120000,
  });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "fresh_database_foreign_content");
  assert.deepEqual(readFileSync(target), before, "refusal preserves main database bytes");
  assert.equal(existsSync(target + "-wal"), false, "refusal must not create WAL");
  assert.equal(existsSync(target + "-shm"), false, "refusal must not create SHM");
  assert.deepEqual(fixtureFs.readdirSync(dir).sort(), ["donor.db", "late-hook.mjs", "workbench.db"],
    "no migration or backup directories created");
  // SQL checks follow the sidecar assertions: this independent read can itself create WAL/SHM.
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    assert.deepEqual(check.prepare("SELECT id FROM existing_business").all().map(row => row.id), [991]);
    assert.equal(check.prepare("SELECT MAX(version) v FROM schema_migrations").get().v, 3);
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 73);
    assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master").get().n, 2);
  } finally { check.close(); }
  assert.deepEqual(readFileSync(target), before);
});

test("真实 init-db 对 marker 同字节新对象、open/fstat 故障拒绝并关闭自己的创建句柄", () => {
  for (const mode of ["marker-replace", "open-failure", "fstat-failure"]) {
    const dir = fixtureFs.mkdtempSync(join(fixtureRoot, `fault-${mode}-`));
    const target = join(dir, "workbench.db"), hook = join(dir, "hook.mjs");
    const search = mode === "marker-replace" ? "    return receipt;"
      : mode === "open-failure" ? 'fd = openSync(abs, "wx+");' : "const identity = fstatSync(fd);";
    const replacement = mode === "marker-replace"
      ? 'bankFaultFs.renameSync(markerPath, markerPath+".owned"); bankFaultFs.copyFileSync(markerPath+".owned", markerPath); return receipt;'
      : 'throw Object.assign(new Error("injected create fault"), {code:"EIO"});';
    writeFileSync(hook, `import {registerHooks} from "node:module";
      registerHooks({load(url,ctx,next){const r=next(url,ctx);
        if(!url.endsWith("/server/bank-storage.mjs"))return r;
        const s=String(r.source);if(!s.includes(${JSON.stringify(search)}))throw new Error("hook mismatch");
        return {...r,source:'import * as bankFaultFs from "node:fs";\\n'+s.replace(${JSON.stringify(search)},${JSON.stringify(replacement)})};}});`);
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, CLI, "init-db", "--db", target], {
      cwd: WORKBENCH, env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 120000,
    });
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(existsSync(target + "-wal"), false);
    assert.equal(existsSync(target + "-shm"), false);
    if (mode === "marker-replace") {
      assert.equal(JSON.parse(r.stderr).error.code, "fresh_receipt_stale");
      assert.ok(existsSync(join(dir, ".local-bank-create-workbench.db")), "replacement marker must survive cleanup");
    } else if (mode === "fstat-failure") {
      assert.equal(fixtureFs.statSync(target).size, 0, "unproven file retained on failed fstat");
    } else assert.equal(existsSync(target), false);
  }
});
