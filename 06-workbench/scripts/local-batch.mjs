#!/usr/bin/env node
// local-batch.mjs — LOCAL-07 本机持久批量 CLI（可直接运行，无 HTTP / 无 Agent 入口）。
//
// 命令：help | start | status | resume | cancel | retry
// 所有命令都必须显式 --data-dir；start 还必须显式 --manifest 与 --output-dir。
//
// 安全加载顺序（重要）：
//   1) 只解析 / 校验命令行参数；
//   2) 只使用 local-batch-storage.mjs（纯存储，不 import db.mjs）读 manifest、校验数据目录；
//   3) 只有在「数据目录可安全初始化 / 已有目标批量结构」之后，才动态 import
//      local-batch-runner.mjs（它 import db.mjs，会打开并迁移核心库）。
// 因此 help、参数错误、import 本包任一模块、status 缺库都不会创建或打开默认生产库。
//
// 退出码：0 = 全部成功；1 = 仍有失败 / 需复核 / 取消 / 执行中；2 = 参数或冲突错误；
//         3 = 依赖 / 数据目录错误（含缺库、缺少已审备份依赖）。

import { DatabaseSync } from "node:sqlite";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as storage from "../server/local-batch-storage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `本机持久批量 CLI（LOCAL-07）

用法：
  node scripts/local-batch.mjs help
  node scripts/local-batch.mjs start  --data-dir <目录> --manifest <manifest.json> --output-dir <目录> [--job-key <键>]
  node scripts/local-batch.mjs status --data-dir <目录> --job-key <键>
  node scripts/local-batch.mjs resume --data-dir <目录> --job-key <键> [--use-saved-inputs]
  node scripts/local-batch.mjs cancel --data-dir <目录> --job-key <键>
  node scripts/local-batch.mjs retry  --data-dir <目录> --job-key <键> [--item <itemKey>] [--period <YYYY-MM>] [--stage <stageKey>] [--use-saved-inputs]

约定：
  - 每次都必须显式 --data-dir（本机工作台数据目录，内含 workbench.db）；start 必须显式 --manifest。
  - status 使用只读连接：不建表、不升级、不续跑；缺库返回 database_not_found（退出码 3）。
  - stdout 只有受控 JSON；stderr 只输出错误码与简短说明（不含账务文本 / SQL / 堆栈）。
  - 退出码：0 全部成功；1 仍有失败 / 需复核 / 取消 / 执行中；2 参数或冲突；3 依赖或数据目录。
  - 输出文件只写入 --output-dir 之内（受控相对路径），从不覆盖已有无关文件。
`;

const COMMANDS = new Set(["help", "start", "status", "resume", "cancel", "retry"]);
const FLAGS = new Set([
  "--data-dir", "--manifest", "--output-dir", "--job-key", "--item", "--period", "--stage",
]);

class CliError extends Error {
  constructor(code, exitCode, message, details) {
    super(message || code);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details || {};
  }
}

function parseArgs(argv) {
  const args = argv.slice();
  const command = args.shift();
  if (!command) throw new CliError("command_required", 2, "缺少命令");
  if (!COMMANDS.has(command)) throw new CliError("command_unknown", 2, `未知命令：${command}`);
  const options = { flags: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new CliError("argument_unexpected", 2, `多余参数：${token}`);
    if (token === "--help") { options.help = true; continue; }
    if (token === "--use-saved-inputs") { options.flags.add(token); continue; }
    if (!FLAGS.has(token)) throw new CliError("flag_unknown", 2, `未知参数：${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError("flag_value_required", 2, `参数缺少取值：${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (options[key] !== undefined) throw new CliError("flag_duplicated", 2, `参数重复：${token}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(code, exitCode, message, details = {}) {
  return new CliError(code, exitCode, message, details);
}

function requireDataDir(options) {
  const value = options.dataDir;
  if (!value || !String(value).trim()) throw fail("data_dir_required", 2, "必须显式提供 --data-dir");
  const resolved = resolve(String(value));
  if (resolved === sep) throw fail("data_dir_invalid", 2, "--data-dir 不能是文件系统根目录");
  return resolved;
}

function requireJobKey(options) {
  if (!options.jobKey || !String(options.jobKey).trim()) throw fail("job_key_required", 2, "必须显式提供 --job-key");
  return String(options.jobKey).trim();
}

function openDirect(dbPath, { readOnly }) {
  const db = new DatabaseSync(dbPath, { readOnly });
  try { db.exec("PRAGMA busy_timeout = 10000"); } catch { /* 只读连接可能不允许，忽略 */ }
  return db;
}

const DB_FILE = "workbench.db";

/**
 * 启动期短连接（不写任何业务数据）：并发 CLI 同时打开同一个库时，共享的 `db.mjs` 初始化会
 * 执行建表 / 建索引语句；若另一个执行者此时正在写、或刚关闭连接并清理 `-wal` / `-shm`，
 * 该共享初始化会瞬时拿到 `database is locked`（栈在 `db.mjs` 创建表处）。
 * 这里先用本包自己的连接（带 busy_timeout）读一次 schema，再在整个「import runner +
 * ensureBatchSchema」期间保持连接存活，把并发窗口降到最小；结束后立即关闭，不延长 WAL。
 * 预热打开失败时 soft-fail（不写任何内容），随后仍由真实步骤报错，不掩盖问题。
 */
async function withStartupDatabase(dataDir, fn) {
  const state = storage.inspectDataDir(dataDir);
  let warm = null;
  if (state.exists && state.bytes) {
    try { warm = openDirect(resolve(dataDir, DB_FILE), { readOnly: false }); } catch { warm = null; }
    if (warm) {
      try { warm.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get(); } catch { /* 预热失败不阻止真实流程 */ }
    }
  }
  try {
    return await fn();
  } finally {
    try { warm?.close(); } catch { /* 关闭失败不影响结果 */ }
  }
}

/** status / cancel / retry：只使用存储层，绝不 import 会打开业务库的 runner。 */
function withBatchDatabase(dataDir, { readOnly }, fn) {
  const state = storage.inspectDataDir(dataDir);
  if (!state.exists) throw fail("database_not_found", 3, "数据目录中没有 workbench.db（不会被当成新库）");
  if (!state.readable) throw fail("database_unreadable", 3, "workbench.db 无法打开");
  if (state.batchVersion !== storage.LOCAL_BATCH_SCHEMA_VERSION) {
    throw fail("batch_schema_unavailable", 3, "数据库缺少本包批量结构（或结构版本不匹配）", {
      batchVersion: state.batchVersion, supported: storage.LOCAL_BATCH_SCHEMA_VERSION,
      dependency: "LOCAL-06 createBackup/verifyBackup",
    });
  }
  const db = openDirect(resolve(dataDir, DB_FILE), { readOnly });
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch { /* 连接关闭失败不影响结果 */ }
  }
}

function summarize(jobStatus) {
  const counts = {};
  let stages = 0;
  for (const item of jobStatus.items || []) {
    for (const stage of item.stages || []) {
      stages += 1;
      counts[stage.status] = (counts[stage.status] || 0) + 1;
    }
  }
  return { items: (jobStatus.items || []).length, stages, stageStatusCounts: counts };
}

function normalizeStatusReport(report) {
  return {
    ok: report.status === storage.JOB_STATUS.SUCCEEDED,
    command: "status",
    jobKey: report.jobKey,
    jobId: report.jobId,
    status: report.status,
    concurrency: report.concurrency,
    cancelRequested: report.cancelRequested,
    manifestHash: report.manifestHash,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    summary: summarize(report),
    items: (report.items || []).map((item) => ({
      itemKey: item.itemKey,
      enterpriseKey: item.enterpriseKey,
      accountSetId: item.accountSetId,
      status: item.status,
      errorCode: item.errorCode,
      stages: item.stages.map((stage) => ({
        period: stage.period, stageKey: stage.stageKey, status: stage.status,
        attempt: stage.attempt, errorCode: stage.errorCode,
        inputHash: stage.inputHash, outcomeHash: stage.outcomeHash,
      })),
      artifacts: item.artifacts,
    })),
  };
}

async function dispatch({ command, options }) {
  if (command === "help" || options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dataDir = requireDataDir(options);
  if (command === "start") {
    if (!options.manifest) throw fail("manifest_required", 2, "start 必须显式提供 --manifest");
    const outputDir = options.outputDir ? resolve(options.outputDir) : null;
    if (!outputDir) throw fail("output_dir_required", 2, "start 必须显式提供 --output-dir");
    // 1) manifest 形状 / 上限 / 白名单（不打开数据库）。
    const file = storage.readManifestFile(resolve(options.manifest));
    const validated = storage.validateManifest(file.manifest);
    if (!validated.ok) {
      throw fail("manifest_invalid", 2, "manifest 校验失败（schemaVersion=1 严格白名单）", { errors: validated.errors });
    }
    if (options.jobKey && options.jobKey !== validated.manifest.jobKey) {
      throw fail("job_key_mismatch", 2, "--job-key 与 manifest.jobKey 不一致");
    }
    // 2) 展开阶段计划 + 一次读取全部输入快照（仍在数据库之外）。
    const { plans, inputs } = storage.buildPlan({
      manifest: validated.manifest, manifestDir: dirname(resolve(options.manifest)),
    });
    const manifestJson = storage.canonicalJson(validated.manifest);
    const manifestHash = storage.sha256(manifestJson);
    // 3) 数据目录只读检查：只有「显式新目录」或「已有目标批量结构」才允许继续。
    const init = storage.assertInitializable(dataDir);
    process.env.WORKBENCH_DATA_DIR = dataDir;
    const runner = await withStartupDatabase(dataDir, async () => {
      const loaded = await import("../server/local-batch-runner.mjs");
      storage.ensureBatchSchema(loaded.database, { freshDatabase: init.fresh });
      return loaded;
    });
    const result = await runner.createAndRun({
      manifest: validated.manifest, manifestHash, manifestJson, plans, inputs, outputDir,
    });
    const status = result.finalStatus ?? result.status;
    emit({
      ok: status === storage.JOB_STATUS.SUCCEEDED,
      command: "start",
      jobKey: result.jobKey,
      jobId: result.jobId,
      status,
      active: result.active === true,
      created: result.created === true,
      manifestHash,
      renders: result.renders ?? 0,
      reset: result.reset ?? [],
      items: (result.items || []).map((item) => ({
        itemKey: item.itemKey,
        cancelled: item.cancelled ?? 0,
        lockBlocked: item.lockBlocked ?? null,
        bindingBlocked: item.bindingBlocked ?? null,
        inputBlocked: item.inputBlocked ?? null,
        inputEvidence: item.inputEvidence ?? [],
        stopped: item.stopped ?? null,
        blockedStages: item.blockedStages ?? 0,
        snapshotError: item.snapshotError ?? null,
        stages: item.stages ?? [],
        snapshots: item.snapshots ?? [],
      })),
      results: result.results ?? [],
      limits: [
        "period-check / close 依赖 LOCAL-02 已审 A.periodEndCheck；未合并时如实报 dependency_unavailable，不用旧试算平衡冒充期末检查",
        "既有库新增批量结构依赖 LOCAL-06 createBackup/verifyBackup；未合并时拒绝自动建表 / 升级",
        "本 CLI 只保证批量 runner 之间按账套互斥，未接线手工 HTTP / Agent 入口",
      ],
    });
    return status === storage.JOB_STATUS.SUCCEEDED ? 0 : 1;
  }
  if (command === "status") {
    const jobKey = requireJobKey(options);
    return withBatchDatabase(dataDir, { readOnly: true }, (db) => {
      const report = storage.readJobStatus(db, jobKey);
      emit(normalizeStatusReport(report));
      return report.status === storage.JOB_STATUS.SUCCEEDED ? 0 : 1;
    });
  }
  if (command === "cancel") {
    const jobKey = requireJobKey(options);
    return withBatchDatabase(dataDir, { readOnly: false }, (db) => {
      const result = storage.requestCancel(db, jobKey);
      emit({ ok: result.status === storage.JOB_STATUS.SUCCEEDED, command: "cancel", ...result });
      return 0;
    });
  }
  if (command === "retry") {
    const jobKey = requireJobKey(options);
    const allowSnapshotOnly = options.flags.has("--use-saved-inputs");
    return withBatchDatabase(dataDir, { readOnly: false }, (db) => {
      const result = storage.resetStagesForRetry(db, {
        jobKey, itemKey: options.item ?? null, period: options.period ?? null,
        stageKey: options.stage ?? null, allowSnapshotOnly,
      });
      emit({
        ok: result.status === storage.JOB_STATUS.SUCCEEDED,
        command: "retry",
        ...result,
        note: "retry 只重开选定未完成阶段；succeeded / not_applicable 不重跑。随后请用 resume 继续。",
      });
      return 0;
    });
  }
  // resume
  const jobKey = requireJobKey(options);
  const state = storage.inspectDataDir(dataDir);
  if (!state.exists) throw fail("database_not_found", 3, "数据目录中没有 workbench.db");
  if (state.batchVersion !== storage.LOCAL_BATCH_SCHEMA_VERSION) {
    throw fail("batch_schema_unavailable", 3, "数据库缺少本包批量结构（或结构版本不匹配）", {
      batchVersion: state.batchVersion, supported: storage.LOCAL_BATCH_SCHEMA_VERSION,
    });
  }
  process.env.WORKBENCH_DATA_DIR = dataDir;
  const runner = await withStartupDatabase(dataDir, async () => {
    const loaded = await import("../server/local-batch-runner.mjs");
    storage.ensureBatchSchema(loaded.database, { freshDatabase: false });
    return loaded;
  });
  const allowSnapshotOnly = options.flags.has("--use-saved-inputs");
  if (allowSnapshotOnly) {
    // 显式选择「仅用已保存快照续跑」：先核验快照存在 / 源文件状态，再继续执行（选择与原因会写进阶段证据）。
    storage.resetStagesForRetry(runner.database, { jobKey, allowSnapshotOnly: true });
  }
  // 普通 resume 同样先核验源证据：源文件被改 / 丢失且未显式选择快照时拒绝静默沿用旧内容。
  // 这里额外给出一份执行前的 job 级源证据摘要（不代替逐阶段核验，也不写任何账务）。
  const resumeJobRow = storage.getJobByKey(runner.database, jobKey);
  const inputEvidence = resumeJobRow ? storage.verifyInputEvidence(runner.database, { jobId: resumeJobRow.id }) : null;
  const result = await runner.resumeJob({ jobKey, allowSnapshotOnly });
  const status = result.finalStatus ?? result.status;
  emit({
    ok: status === storage.JOB_STATUS.SUCCEEDED,
    command: "resume",
    jobKey: result.jobKey,
    jobId: result.jobId,
    status,
    active: result.active === true,
    alreadyComplete: result.alreadyComplete === true,
    allowSnapshotOnly,
    inputEvidence,
    renders: result.renders ?? 0,
    reset: result.reset ?? [],
    items: result.items ?? [],
    results: result.results ?? [],
  });
  return status === storage.JOB_STATUS.SUCCEEDED ? 0 : 1;
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  const code = error instanceof CliError ? error.code : "cli_parse_failed";
  process.stderr.write(`[local-batch] ${code}\n`);
  emit({ ok: false, command: null, error: { code, message: error.message } });
  process.exit(error instanceof CliError ? error.exitCode : 2);
}

try {
  const code = await dispatch(parsed);
  process.exit(code);
} catch (error) {
  const rawCode = error?.code || "cli_failed";
  // 并发竞争下的瞬时锁冲突（共享库初始化 / 事务窗口）不是参数错误：归一成稳定错误码 + 依赖类退出码，
  // 并提示稍后重试；已经进行的阶段仍可 resume，不做任何隐式重写。
  const transientBusy = String(rawCode).startsWith("ERR_SQLITE")
    && /database is locked|database table is locked/i.test(String(error?.message || ""));
  const code = transientBusy ? "database_busy" : rawCode;
  const exitCode = error instanceof CliError ? error.exitCode
    : (["migration_requires_backup", "dependency_unavailable", "database_not_found", "database_unreadable",
      "database_busy", "schema_future_version", "batch_schema_unavailable"].includes(code) ? 3 : 2);
  process.stderr.write(`[local-batch] ${String(code).slice(0, 120)}\n`);
  emit({
    ok: false,
    command: parsed?.command ?? null,
    error: {
      code,
      message: error instanceof CliError ? error.message
        : (transientBusy ? "数据目录正被其它执行者占用：请稍后重试（阶段可 resume）" : "命令执行失败：请查看错误码"),
      details: sanitizeDetails(error?.details),
    },
  });
  process.exit(exitCode);
}

/** 错误详情只保留结构化字段，绝不外泄 SQL / 堆栈 / 账务原值。 */
function sanitizeDetails(details) {
  if (!details || typeof details !== "object") return undefined;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (["errors", "batchVersion", "supported", "coreVersion", "dependency", "status", "jobKey", "jobId", "reason", "count"].includes(key)) {
      if (Array.isArray(value)) out[key] = value.map((entry) => String(entry).slice(0, 200));
      else if (value !== null && typeof value === "object") out[key] = undefined;
      else out[key] = value;
    } else if (["dataDir", "manifestPath", "payloadFile"].includes(key)) {
      out[key] = String(value).split(sep).slice(-1)[0];
    }
  }
  return Object.keys(out).length ? out : undefined;
}
