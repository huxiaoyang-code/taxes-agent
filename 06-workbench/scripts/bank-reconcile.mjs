#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { withRequestMetadata,operationErrorEvidence } from '../server/local-audit-coordinator.mjs';
import { installAuditSchema,assertAuditSchema } from '../server/local-audit-storage.mjs';
// bank-reconcile.mjs — LOCAL-04 本机银行流水与余额调节 CLI。
//
// 使用前提：
//  - 每个业务命令都必须显式 --db <库文件>；不存在、不是本产品账务库或路径拼错一律失败，
//    绝不回落到默认 data/workbench.db，也不会为了「方便」创建库。
//  - 只有 `init-db` 会在一个**不存在**的 workbench.db 路径上创建新库：它先声明创建事实，
//    再调用本产品真实建库入口（server/db.mjs，经 WORKBENCH_DATA_DIR 指向显式目录），
//    最后在同一进程内初始化 bank_* 组件。已有库加入 bank_* 需要已审查的 LOCAL-06 备份实现
//    （--backup-service <模块>）；未提供时返回 migration_backup_unavailable（exit 5）。
//  - 输出默认是 JSON（ok / command / 数据 / 稳定错误码）；--format text 给操作者本机可读明细。
//    默认不打印原始 SQL、堆栈或整份 CSV。
//
// 退出码：0 成功；2 用法 / 路径 / 范围参数错误；3 业务拒绝或冲突；
//         4 内部错误（未输出 SQL/堆栈）；5 依赖未就绪 / 写入被阻断（备份 / 结构门槛 / 回滚未确认）。

import { existsSync, mkdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as BANK from "../server/bank-reconciliation.mjs";
import * as STORAGE from "../server/bank-storage.mjs";
import * as IMPORT from "../server/bank-import.mjs";

const WORKBENCH = join(dirname(fileURLToPath(import.meta.url)), "..");

class CliError extends Error {
  constructor(code, message, details = undefined, exitCode = null) {
    super(message || code);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

const USAGE_CODES = new Set([
  "usage_error", "missing_argument", "invalid_argument", "unknown_command", "unknown_flag",
  "db_not_found", "db_not_file", "db_not_workbench", "db_already_exists", "init_db_filename_required",
  "help_requested", "file_not_found", "csv_file_invalid", "csv_file_too_large", "mapping_file_invalid",
  "mapping_file_too_large", "amount_invalid", "amount_precision", "amount_overflow", "amount_exponent",
  "account_set_id_invalid", "account_set_not_found", "bank_account_not_registered", "bank_account_id_invalid",
  "source_id_invalid", "batch_id_invalid", "period_invalid", "period_before_start", "as_of_invalid",
  "as_of_period_mismatch", "date_from_invalid", "date_to_invalid", "date_window_invalid",
  "date_window_too_wide", "date_tolerance_invalid", "statement_coverage_required",
  "statement_coverage_invalid", "statement_source_required", "statement_open_invalid",
  "statement_close_invalid", "transaction_id_invalid", "voucher_id_invalid", "entry_id_invalid",
  "match_id_invalid", "ambiguity_id_invalid", "ambiguity_decision_invalid", "reason_required",
  "cancel_reason_required", "ambiguity_reason_required", "reason_too_long", "gl_account_code_required",
  "currency_unsupported", "bank_account_currency_mismatch",
]);

const BLOCKED_CODES = new Set([
  "migration_backup_unavailable", "migration_backup_failed", "migration_backup_invalid",
  "schema_not_supported", "bank_schema_missing", "bank_migration_failed",
  "bank_schema_future_version", "bank_schema_version_contradiction", "bank_schema_corrupt",
  "backup_service_not_found", "backup_service_invalid", "db_path_required",
  "fresh_database_file_exists", "fresh_database_path_required",
  // 事务回滚未确认 / 连接状态未知：写入结果不确定，必须人工恢复或丢弃连接后再继续。
  "bank_transaction_rollback_failed", "bank_connection_state_unknown",
  // 事务冲突 / 事务没建立：本次没有写入（也没有回滚任何东西），属于写入被阻断，可处理后重试。
  "bank_transaction_conflict", "bank_transaction_begin_failed",
]);

function exitCodeFor(code) {
  if (!code) return 4;
  if (BLOCKED_CODES.has(code)) return 5;
  if (USAGE_CODES.has(code)) return 2;
  return 3;
}

// ------------------------------------------------------------------ 参数
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 2) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

function flagText(flags, name, { required = false, fallback = null } = {}) {
  const value = flags[name];
  if (value === undefined) {
    if (required) throw new CliError("missing_argument", `缺少参数 --${name}`, { flag: name });
    return fallback;
  }
  if (value === true) throw new CliError("missing_argument", `参数 --${name} 需要取值`, { flag: name });
  const text = String(value).trim();
  if (!text) {
    if (required) throw new CliError("missing_argument", `参数 --${name} 不能为空`, { flag: name });
    return fallback;
  }
  return text;
}

function flagInt(flags, name, { required = false, fallback = null, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = flagText(flags, name, { required, fallback: null });
  if (text === null) return fallback;
  if (!/^-?\d+$/.test(text)) {
    throw new CliError("invalid_argument", `参数 --${name} 必须是整数`, { flag: name });
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CliError("invalid_argument", `参数 --${name} 超出允许范围`, { flag: name, min, max });
  }
  return value;
}

/** 金额参数（元，最多两位小数）-> 整数分（BigInt，可为负）。 */
function flagCents(flags, name, { required = false } = {}) {
  const text = flagText(flags, name, { required });
  if (text === null) return null;
  const parsed = IMPORT.parseAmountText(text);
  if (!parsed.ok) throw new CliError(parsed.code, `参数 --${name}：${parsed.message}`, { flag: name });
  return parsed.negative ? -BigInt(parsed.cents) : BigInt(parsed.cents);
}

function readTextFile(path, { flag, maxBytes = IMPORT.BANK_CSV_LIMITS.maxBytes } = {}) {
  const abs = resolve(String(path));
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new CliError("file_not_found", `文件不存在：${abs}`, { flag, path: abs });
  }
  const bytes = statSync(abs).size;
  if (bytes > maxBytes) {
    throw new CliError(flag === "csv" ? "csv_file_too_large" : "mapping_file_too_large",
      `文件超过上限 ${maxBytes} 字节`, { flag, bytes });
  }
  try {
    return readFileSync(abs, "utf8");
  } catch (e) {
    throw new CliError("file_not_found", `文件无法读取：${abs}`, { flag, reason: String(e?.code ?? "") });
  }
}

function readMapping(flags) {
  const path = flagText(flags, "mapping", { required: true });
  const text = readTextFile(path, { flag: "mapping", maxBytes: 1024 * 1024 });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CliError("mapping_file_invalid", "映射文件不是合法 JSON", {
      flag: "mapping", reason: String(e?.message ?? "").slice(0, 120),
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("mapping_file_invalid", "映射文件必须是 JSON 对象", { flag: "mapping" });
  }
  return parsed;
}

// ------------------------------------------------------------------ 数据库
function openExplicitDatabase(rawPath) {
  if (!rawPath) throw new CliError("missing_argument", "必须显式提供 --db <库文件>", { flag: "db" });
  const abs = resolve(String(rawPath));
  if (!existsSync(abs)) {
    throw new CliError("db_not_found", `数据库文件不存在：${abs}（不会创建或回落到默认库）`, { dbPath: abs });
  }
  if (!statSync(abs).isFile()) {
    throw new CliError("db_not_file", `--db 不是普通文件：${abs}`, { dbPath: abs });
  }
  let db;
  try {
    db = new DatabaseSync(abs);
    db.exec("PRAGMA foreign_keys = ON");
    const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all().map((row) => String(row.name)));
    const required = ["account_sets", "accounts", "opening_balances", "periods", "vouchers", "voucher_entries"];
    const missing = required.filter((t) => !tables.has(t));
    if (missing.length) {
      throw new CliError("db_not_workbench", "该文件不是本产品账务库（缺少账务核心表）", { missing });
    }
  } catch (e) {
    try { if (db) db.close(); } catch { /* ignore */ }
    if (e instanceof CliError) throw e;
    // 非 SQLite 文件 / 损坏文件：不输出驱动原始堆栈，统一按「不是本产品账务库」处理。
    throw new CliError("db_not_workbench", "该文件不是本产品账务库（无法读取 SQLite 结构）", { dbPath: abs });
  }
  return { db, abs };
}

async function loadBackupService(flags) {
  const path = flagText(flags, "backup-service", { required: false });
  if (!path) return null;
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new CliError("backup_service_not_found", `备份服务模块不存在：${abs}`, { path: abs });
  }
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (e) {
    throw new CliError("backup_service_invalid", "备份服务模块无法加载", {
      reason: String(e?.message ?? "").slice(0, 160),
    });
  }
  if (typeof mod.createBackup !== "function" || typeof mod.verifyBackup !== "function") {
    throw new CliError("backup_service_invalid", "备份服务必须导出 createBackup 与 verifyBackup", {
      exports: Object.keys(mod).slice(0, 20),
    });
  }
  return mod;
}

async function ensureBankReady(ctx, flags) {
  // 统一组件检查：版本 / 结构契约符合就直接用；已存在 bank_* 但不符合契约（未来版本、
  // 矛盾版本、缺表 / 缺列 / 主键 / 索引 / 外键动作）必须在任何命令动作之前拒绝；
  // 只有「完全没有 bank_*」才进入备份门槛迁移。
  const contract = STORAGE.bankSchemaContract(ctx.db);
  if (contract.ok) return null;
  if (contract.initialized) {
    throw new CliError(contract.code, contract.message, {
      version: contract.version,
      target: contract.target,
      problems: contract.problems.slice(0, 10),
    });
  }
  const backupService = await loadBackupService(flags);
  return STORAGE.ensureBankSchema(ctx.db, {
    dbPath: ctx.abs,
    backupService,
    dataDir: dirname(ctx.abs),
  });
}

function requireScope(flags) {
  return {
    accountSetId: flagInt(flags, "account-set", { required: true, min: 1 }),
    bankAccountId: flagText(flags, "bank-account", { required: true }),
  };
}

// ------------------------------------------------------------------ 命令
const COMMANDS = {
  "init-db": {
    summary: "在不存在的新路径上创建账务库并初始化 bank_* 组件（仅本命令允许建库）",
    flags: ["--db <workbench.db>"],
    run: initDb,
  },
  "account-register": {
    summary: "登记银行账户（绑定本账套一个银行存款叶子科目）",
    flags: ["--account-set <id>", "--bank-account <id>", "--source <id>", "--gl-code <1002 或明细>",
      "[--name]", "[--number]", "[--currency CNY]"],
    run: accountRegister,
  },
  accounts: {
    summary: "列出账套内已登记的银行账户",
    flags: ["--account-set <id>"],
    run: accounts,
  },
  "import-preview": {
    summary: "预检 CSV + 字段映射（不写库）",
    flags: ["--account-set", "--bank-account", "--source", "--period YYYY-MM", "--csv <file>", "--mapping <file>"],
    run: importPreview,
  },
  import: {
    summary: "执行一批银行流水导入（单事务、幂等、持久去重）",
    flags: ["--account-set", "--bank-account", "--source", "--period", "--batch <batchId>", "--csv", "--mapping"],
    run: importBatch,
  },
  batches: {
    summary: "查询批次状态",
    flags: ["--account-set", "--bank-account", "[--limit]"],
    run: batches,
  },
  transactions: {
    summary: "查询银行流水（含匹配状态）",
    flags: ["--account-set", "--bank-account", "[--from]", "[--to]", "[--status matched|unmatched|all]", "[--limit]"],
    run: transactions,
  },
  ambiguities: {
    summary: "查询无稳定 ID 的疑似重复行（待人工判定）",
    flags: ["--account-set", "--bank-account", "[--status pending|resolved_same|resolved_distinct]"],
    run: ambiguities,
  },
  "resolve-ambiguity": {
    summary: "人工判定疑似重复行是同一笔还是不同一笔（必须给理由）",
    flags: ["--account-set", "--bank-account", "--ambiguity <id>", "--decision same|distinct",
      "--reason <text>", "[--transaction <id>]"],
    run: resolveAmbiguity,
  },
  candidates: {
    summary: "列出某条流水的 posted 账务分录候选（候选不是已匹配）",
    flags: ["--account-set", "--bank-account", "--transaction <id>", "[--from]", "[--to]",
      "[--tolerance-days 0..31]", "[--period YYYY-MM]"],
    run: candidates,
  },
  confirm: {
    summary: "人工确认流水与账务分录的一对一匹配（事务内复核当前账务）",
    flags: ["--account-set", "--bank-account", "--transaction", "--voucher <id>", "--entry <id>",
      "--reason <text>", "[--tolerance-days 0..31]"],
    run: confirm,
  },
  cancel: {
    summary: "取消匹配（释放占用、保留原匹配与审计，必须给理由）",
    flags: ["--account-set", "--bank-account", "--match <id>", "--reason <text>"],
    run: cancel,
  },
  matches: {
    summary: "查询匹配记录与当前有效性",
    flags: ["--account-set", "--bank-account", "[--status confirmed,cancelled,invalidated]"],
    run: matches,
  },
  reconcile: {
    summary: "余额调节（四类未达项 + 调节后余额 + 差额，不生成凭证）",
    flags: ["--account-set", "--bank-account", "--period", "--as-of YYYY-MM-DD",
      "--statement-open <元>", "--statement-close <元>",
      "--coverage-from YYYY-MM-DD", "--coverage-to YYYY-MM-DD",
      "--statement-source <来源说明>", "[--currency CNY]", "[--note]"],
    run: reconcile,
  },
  status: {
    summary: "银行账户 / 批次 / 流水 / 匹配 / 歧义 / 最近对账状态",
    flags: ["--account-set", "--bank-account"],
    run: status,
  },
  audit: {
    summary: "查询该账户的 append-only 审计事件",
    flags: ["--account-set", "--bank-account", "[--limit]"],
    run: audit,
  },
  help: { summary: "显示命令列表", flags: [], run: help },
};

function help() {
  return {
    usage: "node scripts/bank-reconcile.mjs <command> --db <库文件> [选项]",
    commands: Object.entries(COMMANDS).map(([name, spec]) => ({
      command: name, summary: spec.summary, flags: spec.flags,
    })),
    exitCodes: {
      0: "成功",
      2: "用法 / 路径 / 范围参数错误",
      3: "业务拒绝或冲突（预检失败、批次冲突、匹配冲突等）",
      4: "内部错误（默认不输出 SQL / 堆栈）",
      5: "依赖未就绪 / 写入被阻断（LOCAL-06 备份、结构门槛、事务回滚未确认）",
    },
    notes: [
      "业务命令必须显式 --db；无参 / 拼错路径不会创建或打开默认库。",
      "已有库加入 bank_* 需要已审查的 LOCAL-06 备份实现：--backup-service <模块路径>。",
      "金额参数用元（最多两位小数），输出同时给出整数分与两位小数文本。",
    ],
  };
}

async function initDb(flags) {
  const raw = flagText(flags, "db", { required: true });
  const abs = resolve(raw);
  if (existsSync(abs)) {
    throw new CliError("db_already_exists", "目标路径已存在；init-db 只创建新库", { dbPath: abs });
  }
  if (basename(abs) !== "workbench.db") {
    throw new CliError("init_db_filename_required",
      "init-db 要求目标文件名是 workbench.db（与账务库真实创建入口一致）", { dbPath: abs });
  }
  for (let parent = dirname(abs); ; parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
      throw new CliError("data_dir_alias", "新库目录不能经过别名 / junction");
    }
    if (dirname(parent) === parent) break;
  }
  mkdirSync(dirname(abs), { recursive: true });
  const receipt = STORAGE.claimFreshDatabase({ dbPath: abs });
  let dbModule;
  try {
    dbModule = await STORAGE.initializeFreshDatabaseCore(receipt);
    const schema = await STORAGE.ensureBankSchema(dbModule.db, { dbPath: abs, receipt });
    return {
      dbPath: abs, bankSchema: schema, importSchema: dbModule.importSchema ?? null,
      note: "新库由本命令的真实创建入口创建；bank_* 在同一进程内初始化。",
    };
  } finally {
    try { dbModule?.db.close(); } finally { STORAGE.releaseFreshDatabaseClaim(receipt); }
  }
}

function accountRegister(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => {
    const result = BANK.registerBankAccount(db, {
      ...requireScope(flags),
      sourceId: flagText(flags, "source", { required: true }),
      glAccountCode: flagText(flags, "gl-code", { required: true }),
      currency: flagText(flags, "currency", { required: false, fallback: "CNY" }),
      displayName: flagText(flags, "name", { required: false, fallback: "" }),
      bankAccountNo: flagText(flags, "number", { required: false, fallback: "" }),
    });
    return {
      created: result.created,
      account: accountView(result.account),
    };
  });
}

function accounts(flags) {
  const ctx = openDatabase();
  const accountSetId = flagInt(flags, "account-set", { required: true, min: 1 });
  return withDb(ctx, (db) => {
    const set = db.prepare(`SELECT id FROM account_sets WHERE id=?`).get(accountSetId);
    if (!set) throw new CliError("account_set_not_found", `账套不存在：${accountSetId}`, { accountSetId });
    return {
      accountSetId,
      accounts: STORAGE.listBankAccounts(db, { accountSetId }).map(accountView),
    };
  });
}

function accountView(account) {
  return {
    accountSetId: Number(account.account_set_id),
    bankAccountId: account.bank_account_id,
    sourceId: account.source_id,
    currency: account.currency,
    glAccountCode: account.gl_account_code,
    displayName: account.display_name,
    bankAccountNo: account.bank_account_no,
    createdAt: account.created_at,
  };
}

function importPreview(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => {
    const result = BANK.previewBankImport(db, {
      ...requireScope(flags),
      sourceId: flagText(flags, "source", { required: true }),
      period: flagText(flags, "period", { required: true }),
      csvText: readTextFile(flagText(flags, "csv", { required: true }), { flag: "csv" }),
      mapping: readMapping(flags),
    });
    return result;
  });
}

function importBatch(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => {
    const result = BANK.importBankBatch(db, {
      ...requireScope(flags),
      sourceId: flagText(flags, "source", { required: true }),
      period: flagText(flags, "period", { required: true }),
      batchId: flagText(flags, "batch", { required: true }),
      csvText: readTextFile(flagText(flags, "csv", { required: true }), { flag: "csv" }),
      mapping: readMapping(flags),
    });
    return result;
  });
}

function batches(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => {
    const items = BANK.listBatchesView(db, {
      ...requireScope(flags),
      limit: flagInt(flags, "limit", { fallback: 200, min: 1, max: 1000 }),
    });
    return { batches: items };
  });
}

function transactions(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => {
    const status = flagText(flags, "status", { required: false, fallback: "all" });
    if (!["all", "matched", "unmatched"].includes(status)) {
      throw new CliError("invalid_argument", "--status 只支持 all / matched / unmatched", { flag: "status" });
    }
    return BANK.listTransactionsView(db, {
      ...requireScope(flags),
      from: flagText(flags, "from", { required: false }),
      to: flagText(flags, "to", { required: false }),
      status,
      limit: flagInt(flags, "limit", { fallback: 500, min: 1, max: 5000 }),
    });
  });
}

function ambiguities(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.listAmbiguitiesView(db, {
    ...requireScope(flags),
    status: flagText(flags, "status", { required: false }),
    limit: flagInt(flags, "limit", { fallback: 500, min: 1, max: 5000 }),
  }));
}

function resolveAmbiguity(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.resolveAmbiguity(db, {
    ...requireScope(flags),
    ambiguityId: flagInt(flags, "ambiguity", { required: true, min: 1 }),
    decision: flagText(flags, "decision", { required: true }),
    reason: flagText(flags, "reason", { required: true }),
    transactionId: flagInt(flags, "transaction", { required: false, fallback: null, min: 1 }),
  }));
}

function candidates(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.listCandidates(db, {
    ...requireScope(flags),
    transactionId: flagInt(flags, "transaction", { required: true, min: 1 }),
    from: flagText(flags, "from", { required: false }),
    to: flagText(flags, "to", { required: false }),
    period: flagText(flags, "period", { required: false }),
    dateToleranceDays: flagInt(flags, "tolerance-days", { fallback: 0, min: 0, max: 31 }),
  }));
}

function confirm(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.confirmMatch(db, {
    ...requireScope(flags),
    transactionId: flagInt(flags, "transaction", { required: true, min: 1 }),
    voucherId: flagInt(flags, "voucher", { required: true, min: 1 }),
    entryId: flagInt(flags, "entry", { required: true, min: 1 }),
    reason: flagText(flags, "reason", { required: true }),
    dateToleranceDays: flagInt(flags, "tolerance-days", { fallback: 0, min: 0, max: 31 }),
  }));
}

function cancel(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.cancelMatch(db, {
    ...requireScope(flags),
    matchId: flagInt(flags, "match", { required: true, min: 1 }),
    reason: flagText(flags, "reason", { required: true }),
  }));
}

function matches(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.listMatchesView(db, {
    ...requireScope(flags),
    status: flagText(flags, "status", { required: false }),
    limit: flagInt(flags, "limit", { fallback: 500, min: 1, max: 5000 }),
  }));
}

function reconcile(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.reconcileBank(db, {
    ...requireScope(flags),
    currency: flagText(flags, "currency", { required: false, fallback: "CNY" }),
    period: flagText(flags, "period", { required: true }),
    asOf: flagText(flags, "as-of", { required: true }),
    statementOpenCents: flagCents(flags, "statement-open", { required: true }),
    statementCloseCents: flagCents(flags, "statement-close", { required: true }),
    coverageFrom: flagText(flags, "coverage-from", { required: true }),
    coverageTo: flagText(flags, "coverage-to", { required: true }),
    statementSource: flagText(flags, "statement-source", { required: true }),
    note: flagText(flags, "note", { required: false }),
  }));
}

function status(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.getBankStatus(db, requireScope(flags)));
}

function audit(flags) {
  const ctx = openDatabase();
  return withDb(ctx, (db) => BANK.readBankAudit(db, {
    ...requireScope(flags),
    limit: flagInt(flags, "limit", { fallback: 200, min: 1, max: 2000 }),
  }));
}

// ------------------------------------------------------------------ 运行骨架
let activeContext = null;

/** 命令内获取当前显式连接（由 runCommand 统一打开 / 关闭）。 */
function openDatabase() {
  if (!activeContext) throw new CliError("internal_error", "连接上下文缺失");
  return activeContext;
}

/** 命令函数统一外壳：只接收已打开的显式连接，不在命令内自行开库 / 关库。 */
function withDb(ctx, fn) {
  return fn(ctx.db);
}

/** 命令执行前统一确保 bank_*；已有库没有备份服务时在这里拿到 migration_backup_unavailable。 */
let cliOperationId;
async function runCommand(name, flags) {
  if (name === "init-db") return initDb(flags);
  if (name === "help") return help();
  const spec = COMMANDS[name];
  if (!spec) {
    throw new CliError("unknown_command", `未知命令：${name}`, {
      command: name, available: Object.keys(COMMANDS),
    });
  }
  const ctx = openExplicitDatabase(flagText(flags, "db", { required: true }));
  activeContext = ctx;
  try {
    const writable=new Set(['account-register','import','resolve-ambiguity','candidates','confirm','cancel','matches','transactions','reconcile','status']);
    if(writable.has(name)) {const operationId=flagText(flags,'operation-id',{fallback:randomUUID()});cliOperationId=operationId;if(flags.format==='text')process.stdout.write(`OperationId: ${operationId}\n`);await ensureBankReady(ctx,flags);await installAuditSchema(ctx.db,{dbPath:ctx.dbPath??flagText(flags,'db'),outDir:join(dirname(flagText(flags,'db')),'audit-install-'+randomUUID())});return await withRequestMetadata({operationId,actor:'cli'},()=>spec.run(flags));}
    STORAGE.assertBankSchemaReady(ctx.db);
    return await spec.run(flags);
  } finally {
    activeContext = null;
    try { ctx.db.close(); } catch { /* 忽略关闭错误 */ }
  }
}

// ------------------------------------------------------------------ 文本输出
function renderText(command, data) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  if (command === "reconcile") {
    push(`余额调节  ${data.scope.accountSetName} / ${data.scope.bankAccountId} / ${data.period}（截止 ${data.asOf}）`);
    push(`状态：${data.status}`);
    push("");
    push(`账面期初 ${yuan(data.book.openingCents)} + 发生额 ${yuan(data.book.netCents)} = 截止 ${yuan(data.book.closingCents)}`);
    push(`对账单期初 ${yuan(data.statement.openCents)} + 净额 ${yuan(data.statement.netCents)} = 计算期末 ${yuan(data.statement.computedCloseCents)}（声明 ${yuan(data.statement.closeCents)}，差 ${yuan(data.statement.differenceCents)}）`);
    push("");
    push("未达项：");
    for (const [label, key] of [
      ["企业已收银行未收", "bookReceivedBankMissing"],
      ["企业已付银行未付", "bookPaidBankMissing"],
      ["银行已收企业未收", "bankReceivedBookMissing"],
      ["银行已付企业未付", "bankPaidBookMissing"],
    ]) {
      const items = data.outstanding[key];
      push(`  ${label}（${items.length} 笔，合计 ${data.outstanding.totalsText[key]}）`);
      for (const item of items.slice(0, 20)) {
        const id = item.entryId ? `凭证 ${item.voucherId}/${item.entryId}` : `流水 ${item.transactionId}`;
        push(`    - ${item.date ?? item.voucherDate} ${item.direction === "inflow" ? "收" : "付"} ${item.amountText} ${id} ${item.summary ?? ""}`.trimEnd());
      }
      if (items.length > 20) push(`    … 另有 ${items.length - 20} 笔（详见 --format json）`);
    }
    push("");
    push(`调节后账面 = ${yuan(data.adjusted.bookCents)}`);
    push(`调节后银行 = ${yuan(data.adjusted.bankCents)}`);
    push(`差额 = ${yuan(data.adjusted.differenceCents)}`);
    if (data.issues.length) {
      push("");
      push("问题：");
      for (const issue of data.issues) push(`  - [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
    return lines.join("\n");
  }
  if (command === "status") {
    push(`${data.scope.accountSetName} / ${data.scope.bankAccountId}（科目 ${data.scope.glAccountCode}，${data.scope.currency}）`);
    push(`银行组件 schema v${data.schema.version}；批次 ${data.batches.total}（完成 ${data.batches.completed} / 待判定 ${data.batches.pendingReview} / 失败 ${data.batches.failed}）`);
    push(`流水 ${data.transactions.total}（已匹配 ${data.transactions.matched} / 未匹配 ${data.transactions.unmatched}）`);
    push(`匹配 有效 ${data.matches.confirmed} / 取消 ${data.matches.cancelled} / 失效 ${data.matches.invalidated}；待判定歧义 ${data.ambiguities.pending}`);
    push(`最近对账：${data.lastReconcileStatus ?? "（无）"}`);
    for (const inv of data.invalidations) push(`  ! 匹配 ${inv.matchId} 失效：${inv.reason}`);
    return lines.join("\n");
  }
  if (["accounts", "batches", "transactions", "matches", "ambiguities", "candidates"].includes(command)) {
    const list = data.accounts ?? data.batches ?? data.transactions ?? data.matches
      ?? data.ambiguities ?? data.candidates ?? [];
    push(`${command}：${list.length} 条`);
    for (const item of list.slice(0, 200)) push(`  ${JSON.stringify(item)}`);
    if (list.length > 200) push(`  … 另有 ${list.length - 200} 条（详见 --format json）`);
    return lines.join("\n");
  }
  return JSON.stringify({ ok: true, command, ...data, ...(cliOperationId?{operationId:cliOperationId}:{}) }, null, 2);
}

function yuan(cents) {
  return IMPORT.formatCents(cents);
}

// ------------------------------------------------------------------ main
async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help === true || flags.h === true) {
    return { command: "help", data: help() };
  }
  if (!positional.length) {
    throw new CliError("usage_error", "缺少命令。使用 `node scripts/bank-reconcile.mjs help` 查看命令列表", {
      commands: Object.keys(COMMANDS),
    });
  }
  const command = positional[0];
  if (!COMMANDS[command]) {
    throw new CliError("unknown_command", `未知命令：${command}`, { command, available: Object.keys(COMMANDS) });
  }
  const format = flagText(flags, "format", { required: false, fallback: "json" });
  if (!["json", "text"].includes(format)) {
    throw new CliError("invalid_argument", "--format 只支持 json / text", { flag: "format" });
  }
  const data = await runCommand(command, flags);
  return { command, data, format };
}

try {
  const { command, data, format } = await main(process.argv.slice(2));
  if (format === "text") {
    process.stdout.write(`${renderText(command, data)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...data, ...(cliOperationId?{operationId:cliOperationId}:{}) }, null, 2)}\n`);
  }
  process.exitCode = 0;} catch (e) {
  const rawCode = e instanceof CliError ? e.code : (e && typeof e.code === "string" ? e.code : "internal_error");
  // 只展示本组件已声明的结构化错误码（小写下划线）；其他（含 SQLite 原始错误）统一按内部错误处理，
  // 不打印 SQL / 堆栈。
  const known = rawCode !== "internal_error" && /^[a-z][a-z0-9_]{2,60}$/.test(rawCode);
  const code = known ? rawCode : "internal_error";
  const message = known ? (e?.message || code) : "内部错误：操作未完成（默认不输出 SQL / 堆栈）";
  const payload = {
    ok: false,
    ...(cliOperationId?{operationId:cliOperationId}:{}),
    ...(operationErrorEvidence(e)??{}),
    error: {
      code,
      message,
      ...(known && e?.details !== undefined ? { details: e.details } : {}),
      ...(e?.auditRecorded === false
        ? { auditFailure: e.auditFailure ?? "失败结果未能写入审计（已如实返回）" }
        : {}),
    },
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = e instanceof CliError && e.exitCode ? e.exitCode : exitCodeFor(code);
}
