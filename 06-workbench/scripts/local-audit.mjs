#!/usr/bin/env node
// scripts/local-audit.mjs — LOCAL-06 审计 / 恢复 ledger **只读**查询 CLI。
//
// 边界（不可放宽）：
//   - 必须显式给出 `--db <path>` 或 `--ledger <path>`；**没有**默认数据目录、没有现库初始化快捷入口。
//   - 全部命令只读打开（readOnly）；缺文件不创建、未知 / 损坏结构直接拒绝。
//   - 输出只含白名单字段（技术 ID / 固定词表 / 时间 / 摘要）；不打印原始路径、payload、异常原文。
//   - 非法参数 / 未知选项只报固定错误码，不回显用户值（避免注入串或敏感哨兵被回显）。
//
// 用法（在 06-workbench 目录）：
//   node scripts/local-audit.mjs schema        --db <workbench.db>
//   node scripts/local-audit.mjs instances     --db <workbench.db>
//   node scripts/local-audit.mjs verify        --db <workbench.db>
//   node scripts/local-audit.mjs events        --db <workbench.db> [--action a] [--outcome o]
//                                              [--result-code r] [--actor x] [--operation id]
//                                              [--account-set n] [--voucher n] [--period YYYY-MM]
//                                              [--after-seq n] [--limit n]
//   node scripts/local-audit.mjs stats         --db <workbench.db>
//   node scripts/local-audit.mjs restore-operations --ledger <ledger.db> [--status s] [--producer p]
//                                              [--result-code r] [--after-started-at iso] [--after-operation id]
//                                              [--limit n]
//   node scripts/local-audit.mjs restore-operation  --ledger <ledger.db> --operation <id>
//   node scripts/local-audit.mjs restore-pending    --ledger <ledger.db> [--limit n]
//   node scripts/local-audit.mjs restore-transitions --ledger <ledger.db> --operation <id>
//   node scripts/local-audit.mjs restore-stats      --ledger <ledger.db>
//
// 退出码：0 成功；2 参数 / 过滤非法；3 结构 / 版本 / 文件不可用；4 其他不可用。

import { pathToFileURL } from "node:url";
import {
  AUDIT_COMPONENT,
  AUDIT_SCHEMA_VERSION,
  AuditError,
} from "../server/local-audit.mjs";
import {
  assertAuditSchema,
  auditEventStats,
  inspectAuditSchema,
  listAuditInstances,
  openAuditDatabase,
  queryAuditEvents,
  queryOperation,
  currentAuditInstanceId,
  verifyAuditEvents,
} from "../server/local-audit-storage.mjs";
import {
  RESTORE_LEDGER_COMPONENT,
  RESTORE_LEDGER_SCHEMA_VERSION,
  getRestoreOperation,
  listPendingRestoreOperations,
  listRestoreTransitions,
  openRestoreLedger,
  queryRestoreOperations,
  restoreLedgerStats,
} from "../server/local-restore-audit.mjs";

const USAGE = `local-audit（只读）
  schema | instances | verify | events | stats            --db <path>
  restore-operations | restore-operation | restore-pending |
  restore-transitions | restore-stats                      --ledger <path>`;

/** 命令成功输出但需要非 0 退出码（例如 schema 的 unsupported / invalid）。 */
class CliResult {
  constructor(payload, exitCode = 0) {
    this.payload = payload;
    this.exitCode = exitCode;
  }
}

/** 固定错误码 → 退出码；不回显用户值。 */
const EXIT_CODES = {
  audit_filter_invalid: 2,
  audit_operation_invalid: 2,
  audit_event_invalid: 2,
  restore_operation_invalid: 2,
  audit_cli_invalid_option: 2,
  audit_cli_missing_path: 2,
  audit_cli_unknown_command: 2,
  audit_database_missing: 3,
  audit_database_invalid: 3,
  restore_ledger_missing: 3,
  restore_ledger_invalid: 3,
  audit_schema_inconsistent: 3,
  audit_schema_newer: 3,
  restore_ledger_inconsistent: 3,
  restore_ledger_incompatible: 3,
  restore_ledger_foreign_tables: 3,
};

const VALUE_OPTIONS = new Set([
  "db",
  "ledger",
  "action",
  "outcome",
  "result-code",
  "actor",
  "operation",
  "account-set",
  "voucher",
  "period",
  "after-seq",
  "limit",
  "status",
  "producer",
  "after-started-at",
  "after-operation",
  "instance",
  "attempt",
]);

function usageError(code, details = null) {
  const err = new AuditError(code, details);
  return err;
}

/** 严格解析 `--key value`；未知选项 / 缺值 / 重复只给固定错误码，不回显键值。 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw usageError("audit_cli_missing_path", { reason: "command" });
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (typeof token !== "string" || !token.startsWith("--") || token.length < 3) {
      throw usageError("audit_cli_invalid_option", { reason: "positional" });
    }
    const key = token.slice(2);
    if (!VALUE_OPTIONS.has(key)) throw usageError("audit_cli_invalid_option", { reason: "unknown" });
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw usageError("audit_cli_invalid_option", { reason: "duplicate" });
    }
    const value = rest[i + 1];
    if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
      throw usageError("audit_cli_invalid_option", { reason: "missing_value" });
    }
    options[key] = value;
    i += 1;
  }
  return { command, options };
}

const toInt = (raw, field) => {
  if (!/^\d+$/.test(String(raw))) throw usageError("audit_filter_invalid", { field });
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw usageError("audit_filter_invalid", { field });
  return value;
};

const requirePath = (options, key) => {
  const value = options[key];
  if (value === undefined) throw usageError("audit_cli_missing_path", { reason: key });
  return value;
};

const rejectUnknown = (options, allowed) => {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw usageError("audit_cli_invalid_option", { reason: "unknown" });
  }
};

function runEvents(options) {
  rejectUnknown(options, [
    "db", "action", "outcome", "result-code", "actor", "operation", "account-set", "voucher",
    "period", "after-seq", "limit",
  ]);
  const db = openAuditDatabase(requirePath(options, "db"), { readOnly: true });
  try {
    assertAuditSchema(db);
    const filter = {};
    if (options.action !== undefined) filter.action = options.action;
    if (options.outcome !== undefined) filter.outcome = options.outcome;
    if (options["result-code"] !== undefined) filter.resultCode = options["result-code"];
    if (options.actor !== undefined) filter.actor = options.actor;
    if (options.operation !== undefined) filter.operationId = options.operation;
    if (options["account-set"] !== undefined) filter.accountSetId = toInt(options["account-set"], "accountSetId");
    if (options.voucher !== undefined) filter.voucherId = toInt(options.voucher, "voucherId");
    if (options.period !== undefined) filter.period = options.period;
    if (options["after-seq"] !== undefined) filter.afterSeq = toInt(options["after-seq"], "afterSeq");
    if (options.limit !== undefined) filter.limit = toInt(options.limit, "limit");
    return queryAuditEvents(db, filter);
  } finally {
    db.close();
  }
}

function runSchema(options) {
  rejectUnknown(options, ["db"]);
  const db = openAuditDatabase(requirePath(options, "db"), { readOnly: true });
  try {
    // 完整结构断言（表 / 列 / 版本 / 触发器定义 / 活动实例），不只“三表存在”。
    const state = inspectAuditSchema(db);
    const out = {
      component: AUDIT_COMPONENT,
      targetVersion: AUDIT_SCHEMA_VERSION,
      installed: state.installed,
      version: state.version,
      tables: state.present,
      activeInstanceId: state.activeInstanceId,
      ok: state.ok,
      state: state.state,
    };
    if (state.problems.length) out.problems = state.problems;
    // ok / unsupported（更高版本）/ invalid（缺表 / 缺列 / 缺触发器 / 同名无效触发器）分开表达；
    // 非 ok 按契约 exit 3，且只读打开不修改 DB。
    return state.ok ? out : new CliResult(out, 3);
  } finally {
    db.close();
  }
}

function runInstances(options) {
  rejectUnknown(options, ["db"]);
  const db = openAuditDatabase(requirePath(options, "db"), { readOnly: true });
  try {
    assertAuditSchema(db);
    return { instances: listAuditInstances(db) };
  } finally {
    db.close();
  }
}

function runVerify(options) {
  rejectUnknown(options, ["db"]);
  const db = openAuditDatabase(requirePath(options, "db"), { readOnly: true });
  try {
    assertAuditSchema(db);
    return verifyAuditEvents(db);
  } finally {
    db.close();
  }
}

function runStats(options) {
  rejectUnknown(options, ["db"]);
  const db = openAuditDatabase(requirePath(options, "db"), { readOnly: true });
  try {
    assertAuditSchema(db);
    return auditEventStats(db);
  } finally {
    db.close();
  }
}

function runRestoreOperations(options) {
  rejectUnknown(options, ["ledger", "status", "producer", "result-code", "after-started-at", "after-operation", "limit"]);
  const db = openRestoreLedger(requirePath(options, "ledger"), { readOnly: true });
  try {
    const filter = {};
    if (options.status !== undefined) filter.status = options.status;
    if (options.producer !== undefined) filter.producer = options.producer;
    if (options["result-code"] !== undefined) filter.resultCode = options["result-code"];
    if (options["after-started-at"] !== undefined) filter.afterStartedAt = options["after-started-at"];
    if (options["after-operation"] !== undefined) filter.afterOperationId = options["after-operation"];
    if (options.limit !== undefined) filter.limit = toInt(options.limit, "limit");
    return queryRestoreOperations(db, filter);
  } finally {
    db.close();
  }
}

function runRestoreOperation(options) {
  rejectUnknown(options, ["ledger", "operation"]);
  const db = openRestoreLedger(requirePath(options, "ledger"), { readOnly: true });
  try {
    const operationId = options.operation;
    if (operationId === undefined) throw usageError("audit_cli_missing_path", { reason: "operation" });
    return { operation: getRestoreOperation(db, operationId) };
  } finally {
    db.close();
  }
}

function runRestorePending(options) {
  rejectUnknown(options, ["ledger", "limit"]);
  const db = openRestoreLedger(requirePath(options, "ledger"), { readOnly: true });
  try {
    const limit = options.limit === undefined ? 50 : toInt(options.limit, "limit");
    return { operations: listPendingRestoreOperations(db, { limit }) };
  } finally {
    db.close();
  }
}

function runRestoreTransitions(options) {
  rejectUnknown(options, ["ledger", "operation"]);
  const db = openRestoreLedger(requirePath(options, "ledger"), { readOnly: true });
  try {
    const operationId = options.operation;
    if (operationId === undefined) throw usageError("audit_cli_missing_path", { reason: "operation" });
    return { transitions: listRestoreTransitions(db, operationId) };
  } finally {
    db.close();
  }
}

function runRestoreStats(options) {
  rejectUnknown(options, ["ledger"]);
  const db = openRestoreLedger(requirePath(options, "ledger"), { readOnly: true });
  try {
    return {
      component: RESTORE_LEDGER_COMPONENT,
      targetVersion: RESTORE_LEDGER_SCHEMA_VERSION,
      ...restoreLedgerStats(db),
    };
  } finally {
    db.close();
  }
}

function runOperation(options){rejectUnknown(options,['db','operation','instance','attempt']);const db=openAuditDatabase(requirePath(options,'db'),{readOnly:true});try{return queryOperation(db,{databaseInstanceId:options.instance??currentAuditInstanceId(db),operationId:options.operation,attempt:options.attempt===undefined?1:toInt(options.attempt,'attempt')});}finally{db.close();}}
const COMMANDS = new Map([
  ['operation',runOperation],
  ["events", runEvents],
  ["schema", runSchema],
  ["instances", runInstances],
  ["verify", runVerify],
  ["stats", runStats],
  ["restore-operations", runRestoreOperations],
  ["restore-operation", runRestoreOperation],
  ["restore-pending", runRestorePending],
  ["restore-transitions", runRestoreTransitions],
  ["restore-stats", runRestoreStats],
]);

/** 主入口：返回进程退出码（便于测试直接调用）。 */
export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ error: e.code })}\n${USAGE}\n`);
    return EXIT_CODES[e.code] ?? 2;
  }
  const handler = COMMANDS.get(parsed.command);
  if (!handler) {
    process.stderr.write(`${JSON.stringify({ error: "audit_cli_unknown_command" })}\n${USAGE}\n`);
    return 2;
  }
  try {
    const out = handler(parsed.options);
    const payload = out instanceof CliResult ? out.payload : out;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return out instanceof CliResult ? out.exitCode : 0;
  } catch (e) {
    const code = e instanceof AuditError ? e.code : "audit_cli_failed";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    return EXIT_CODES[code] ?? 4;
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  process.exitCode = main();
}
