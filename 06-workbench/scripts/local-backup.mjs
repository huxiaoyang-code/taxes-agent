#!/usr/bin/env node
/**
 * scripts/local-backup.mjs — LOCAL-06 本机备份 CLI（独立子包，不接线后端 / 税局 / 出厂安装）。
 *
 * 用法（PowerShell / cmd / bash 通用，路径按本机实际填写）：
 *   node scripts/local-backup.mjs backup      --db <源库文件> --out <全新的备份目录>
 *   node scripts/local-backup.mjs verify      --backup <备份目录>
 *   node scripts/local-backup.mjs restore-new --backup <备份目录> --target <全新的目标目录> --ledger <独立ledger文件> --operation <技术ID>
 *
 * 行为约定：
 *  - 只处理显式传入的路径；不猜测默认数据目录，不读环境变量里未显式给出的库。
 *  - 标准输出始终是一段 JSON（可直接被上层脚本消费）；只有稳定 code，不回显账务原文 / 原始 SQL / 堆栈。
 *  - 退出码：0 = 成功；1 = 用法错误；2 = 明确拒绝（数据 / 清单 / 目标不合格）；3 = 内部错误。
 */

import { createBackup, verifyBackup, restoreNew, reconcileRestore, backupContract } from "../server/local-backup.mjs";

const USAGE = [
  "node scripts/local-backup.mjs backup --db <源库文件> --out <全新的备份目录>",
  "node scripts/local-backup.mjs verify --backup <备份目录>",
  "node scripts/local-backup.mjs restore-new --backup <备份目录> --target <全新的目标目录> --ledger <独立ledger文件> --operation <技术ID>",
].join("\n");

const COMMANDS = {
  backup: { required: ["db", "out"], run: (options) => createBackup({ dbPath: options.db, outDir: options.out }) },
  reconcile: { required: ["backup","target","ledger","operation"], run: o => reconcileRestore({backupDir:o.backup,targetDir:o.target,ledgerPath:o.ledger,operationId:o.operation}) },
  verify: { required: ["backup"], run: (options) => verifyBackup({ backupDir: options.backup }) },
  "restore-new": { required: ["backup", "target", "ledger", "operation"], run: (options) => restoreNew({ backupDir: options.backup, targetDir: options.target, ledgerPath: options.ledger, operationId: options.operation }) },
};

/** 严格解析：只接受 `--name value`；未知 / 重复 / 缺值 / 多余位置参数一律用法错误。 */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) return { error: { code: "usage_missing_command" } };
  if (command === "--help" || command === "-h" || command === "help") return { help: true };
  const spec = COMMANDS[command];
  if (!spec) return { error: { code: "usage_unknown_command" } };

  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      return { error: { code: "usage_unexpected_argument" } };
    }
    const name = token.slice(2);
    if (!spec.required.includes(name)) return { error: { code: "usage_unknown_option", field: name } };
    if (Object.prototype.hasOwnProperty.call(options, name)) return { error: { code: "usage_duplicate_option", field: name } };
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--") || value === "") {
      return { error: { code: "usage_missing_value", field: name } };
    }
    options[name] = value;
    index += 1;
  }
  for (const name of spec.required) {
    if (!Object.prototype.hasOwnProperty.call(options, name)) return { error: { code: "usage_missing_option", field: name } };
  }
  return { command, spec, options };
}

function emit(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    emit({ command: "help", ok: true, status: "ok", code: null, usage: USAGE, contract: backupContract() }, 0);
    return;
  }
  if (parsed.error) {
    emit({ command: argv[0] ?? null, ok: false, status: "rejected", code: parsed.error.code, details: null, usage: USAGE }, 1);
    return;
  }
  let result;
  try {
    result = parsed.spec.run(parsed.options);
  } catch {
    // 内部异常一律折叠为稳定 code：不把堆栈 / SQL / 账务原文写到终端或日志。
    result = { ok: false, status: "failed", code: "internal_error", details: null };
  }
  const payload = { command: parsed.command, ...result };
  emit(payload, result.ok ? 0 : (result.status === "rejected" ? 2 : 3));
}

main(process.argv.slice(2));
