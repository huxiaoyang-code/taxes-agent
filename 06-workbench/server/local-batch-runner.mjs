import { acquireWriteResources, releaseWriteResources, renewWriteResources, withWriteResources, writeResourceLocks, domainResources, withWriteStageFence } from './local-write-lock.mjs';
import { runAuditedBatchStage } from './local-audit-coordinator.mjs';
// local-batch-runner.mjs — LOCAL-07 持久批量任务的编排层：manifest → 计划 → 逐账套执行 →
// 报表快照 → worker 线程并发渲染 → 受控发布 → 状态机 / 取消 / 重试 / 重启恢复。
//
// 重要：本模块静态 import db.mjs（会打开 WORKBENCH_DATA_DIR 下的库），因此只能在 CLI 完成
// 「参数解析 + 数据目录只读检查 + 结构可初始化判定」之后动态 import。status / cancel / retry
// 由 CLI 直接使用 local-batch-storage.mjs，不 import 本文件。
//
// 并发口径：SQLite 写始终在同一连接上短事务串行；只有**报表渲染**在 worker_threads 池中并发，
// 上限 = manifest.concurrency（1..8）。主线程一致只读快照取 DTO 后立即释放读事务。

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import * as storage from "./local-batch-storage.mjs";

// 数据目录守卫：本模块会打开业务库，因此要求调用方（CLI）先显式设置 WORKBENCH_DATA_DIR。
// 未设置时立即失败，**不** import db.mjs，也不会创建 / 打开默认数据目录。
if (!process.env.WORKBENCH_DATA_DIR || !String(process.env.WORKBENCH_DATA_DIR).trim()) {
  const error = new Error("local_batch_data_dir_required");
  error.code = "local_batch_data_dir_required";
  throw error;
}
const [{ db }, actions] = await Promise.all([
  import("./db.mjs"),
  import("./local-batch-actions.mjs"),
]);

// 同一进程内的所有批量事务都在这一个连接上短事务串行；并发 CLI 进程靠 busy_timeout 排队。
db.exec("PRAGMA busy_timeout = 10000");

const WORKER_URL = new URL("./local-batch-report-worker.mjs", import.meta.url);
const {
  MANIFEST_LIMITS, STAGE_KEYS, STAGE_STATUS, batchError, canonicalJson, getArtifactByStage,
  getJob, getJobByKey, getSnapshot, listItems, listPendingStages, listStages,
  listStagesByStatus, newInstanceId, refreshStatuses, safeJson, sha256,
} = storage;

const LEASE_MS = 120000;
const RENDER_TIMEOUT_MS = 180000;

export { MANIFEST_LIMITS } from "./local-batch-storage.mjs";

const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** 稳定目录段：非法字符替换 + 原文指纹后缀（避免不同原文撞同一路径）。 */
export function safeSegment(value, max = 48) {
  const text = String(value ?? "");
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, max) || "x";
  const plain = /^[A-Za-z0-9._-]+$/.test(text) && text.length <= max;
  if (plain) return cleaned;
  return `${cleaned}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}


// ---------------------------------------------------------------- 渲染线程池
export function createRenderPool(size) {
  const slots = [];
  const queue = [];
  let closed = false;
  const makeSlot = () => {
    // execArgv 置空：父进程可能以 --input-type / --eval 启动，而 worker 加载的是文件 URL。
    const worker = new Worker(WORKER_URL, { execArgv: [] });
    const slot = { worker, busy: false, inflight: null };
    worker.on("message", (message) => {
      if (!message || message.type !== "rendered") return;
      const inflight = slot.inflight;
      slot.inflight = null;
      slot.busy = false;
      if (inflight) {
        clearTimeout(inflight.timer);
        if (message.ok) inflight.resolve({ buffer: Buffer.from(message.buffer), threadId: message.threadId, started: message.started, finished: message.finished, meta: message.meta });
        else inflight.reject(batchError(message.code || "render_failed", { message: message.message }));
      }
      dispatch();
    });
    worker.on("error", (error) => {
      const inflight = slot.inflight;
      slot.inflight = null;
      slot.busy = false;
      if (inflight) { clearTimeout(inflight.timer); inflight.reject(batchError("render_worker_error", { message: String(error?.message || error) })); }
      dispatch();
    });
    return slot;
  };
  function dispatch() {
    if (closed) return;
    while (queue.length) {
      const slot = slots.find((entry) => !entry.busy);
      if (!slot) return;
      const task = queue.shift();
      slot.busy = true;
      slot.inflight = {
        resolve: task.resolve,
        reject: task.reject,
        timer: setTimeout(() => {
          const inflight = slot.inflight;
          slot.inflight = null;
          slot.busy = false;
          if (inflight) inflight.reject(batchError("render_timeout", {}));
          dispatch();
        }, RENDER_TIMEOUT_MS),
      };
      slot.worker.postMessage({ type: "render", id: task.id, format: task.format, dto: task.dto });
    }
  }
  for (let index = 0; index < size; index += 1) slots.push(makeSlot());
  return {
    size,
    run(task) {
      return new Promise((resolveTask, rejectTask) => {
        queue.push({ id: randomUUID(), ...task, resolve: resolveTask, reject: rejectTask });
        dispatch();
      });
    },
    async close() {
      closed = true;
      await Promise.all(slots.map((slot) => slot.worker.terminate()));
    },
  };
}

// ---------------------------------------------------------------- 文件发布
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

/**
 * 受控发布：先写任务自己的临时文件并校验字节 hash，再以「不覆盖」的方式发布到 outputDir 内
 * 相对路径。已存在的同名文件只有在内容 hash 完全一致（上次已发布成功、只是 checkpoint 没落）
 * 时才按恢复处理；否则 output_conflict，绝不覆盖用户既有文件。
 */
export function publishFile({ bytes, bytesHash, relativePath, outputDir }) {
  const root = resolve(outputDir);
  const tempDir = join(root, ".local-batch-tmp");
  ensureDir(tempDir);
  const tempPath = join(tempDir, `${process.pid}-${randomUUID()}.part`);
  const fd = openSync(tempPath, "wx");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const writtenHash = hashFile(tempPath);
  if (writtenHash !== bytesHash) {
    try { unlinkSync(tempPath); } catch { /* 临时文件清理失败不改变结果 */ }
    throw batchError("artifact_hash_mismatch", { phase: "temp" });
  }
  const finalPath = resolve(root, relativePath);
  if (finalPath !== root && !finalPath.startsWith(root + sep)) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    throw batchError("artifact_path_escape", { relativePath });
  }
  ensureDir(dirname(finalPath));
  if (existsSync(finalPath)) {
    const existingHash = hashFile(finalPath);
    if (existingHash !== bytesHash) {
      try { unlinkSync(tempPath); } catch { /* ignore */ }
      throw batchError("output_conflict", { relativePath });
    }
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return { published: false, recovered: true, finalPath, bytesHash };
  }
  renameSync(tempPath, finalPath);
  return { published: true, recovered: false, finalPath, bytesHash };
}

function relativeArtifactPath({ jobKey, itemKey, period, kind, code, format }) {
  const filename = `${kind}${code ? `-${safeSegment(code, 32)}` : ""}-${period}.${format}`;
  return `${safeSegment(jobKey, 60)}/${safeSegment(itemKey, 60)}/${period}/${filename}`;
}

// ---------------------------------------------------------------- 锁 / 中断恢复
function acquireItemLocks({ item, instance, pid, parent }) {
 const keys=domainResources(db,{action:'import.create',scope:item.account_set_id?{kind:'account_set',value:item.account_set_id}:{kind:'database',value:null},request:{source:{enterpriseKey:item.enterprise_key}}});
 return acquireWriteResources(db,keys,{instance,pid,parent});
}
function releaseItemLocks(handle) {releaseWriteResources(db,handle);}
function renewItemLocks(handle) {renewWriteResources(db,handle);}

/** 将上一位执行者（已确认死亡）留下的 running / 中断阶段重置为 pending。 */
function recoverInterruptedStages(jobId) {
  const rows = listStagesByStatus(db, jobId, [STAGE_STATUS.RUNNING]);
  const reset = [];
  for (const stage of rows) {
    if(storage.stageAuditNeedsReview(db,stage)){storage.resetStage(db,{stageId:stage.id,status:STAGE_STATUS.NEEDS_REVIEW,errorCode:'audit_operation_pending'});continue;}
    storage.resetStage(db, {
      stageId: stage.id, status: STAGE_STATUS.PENDING,
      errorCode: "interrupted_previous_owner", errorMessage: "上一执行者已结束，阶段重新排队",
    });
    reset.push({ itemKey: stage.item_key, period: stage.period, stageKey: stage.stage_key });
  }
  return reset;
}

// ---------------------------------------------------------------- 执行
const EVIDENCE_CONFLICT_CODES = new Set([
  "source_voucher_voucher_missing", "source_voucher_voucher_unposted", "source_voucher_voucher_modified",
  "source_voucher_content_changed", "source_voucher_account_set_mismatch", "source_voucher_trace_unverified",
  "import_trace_inconsistent", "import_batch_not_completed", "import_voucher_missing",
  "import_voucher_unposted", "import_enterprise_binding_mismatch", "evidence_changed",
  "report_evidence_changed", "report_snapshot_changed", "report_incomplete", "output_conflict", "artifact_hash_mismatch",
  "input_changed", "input_missing", "input_snapshot_missing", "input_payload_invalid",
  "account_set_unresolved", "depreciation_run_inconsistent", "depreciation_due_but_no_action",
  "depreciation_amount_mismatch", "depreciation_run_unposted", "year_end_carry_expected", "close_not_confirmed",
  // LOCAL-02 封账前置 / 计提与结转守卫：业务变化后由核心真实拒绝，统一转人工复核。
  "period_end_check_failed", "period_check_blocked", "period_has_draft_vouchers", "period_unbalanced",
  "period_not_found", "period_before_start", "carryforward_stale", "depreciation_run_stale",
  "depreciation_draft_exists", "depreciation_global_over_depreciable", "asset_ledger_pending",
  "asset_acquired_period_missing", "asset_purchase_voucher_pending",
  // 企业与账套绑定不符：保守转人工复核，不写入任何业务数据。
  "enterprise_binding_mismatch", "enterprise_binding_missing", "account_set_enterprise_mismatch",
]);

function stageFailureStatus(error) {
  const code = error?.code || "";
  if (code.startsWith("audit_")) return STAGE_STATUS.NEEDS_REVIEW;
  if (code === "dependency_unavailable") return STAGE_STATUS.BLOCKED_DEPENDENCY;
  if (code.startsWith("lock_") || code === "owner_active" || code === "fence_lost") return STAGE_STATUS.NEEDS_REVIEW;
  if (EVIDENCE_CONFLICT_CODES.has(code)) return STAGE_STATUS.NEEDS_REVIEW;
  return STAGE_STATUS.FAILED;
}

function failStage({ stage, lock, attempt, error }) {
  const status = stageFailureStatus(error);
  const errorCode = String(error?.code || "stage_failed").slice(0, 120);
  try {
    storage.withFencedTransaction(db, lock, () => {
      storage.writeStageResult(db, {
        stageId: stage.id, instance: lock.instance, token: lock.token, attempt,
        status, errorCode, errorMessage: "阶段执行失败：请查看错误码与证据摘要",
        evidence: { errorCode },
      });
    });
  } catch (markError) {
    // fence 丢失说明本实例已不是合法执行者：不写任何结果，由下一执行者接管。
    if (markError?.code !== "fence_lost") throw markError;
  }
  return { status, errorCode };
}

function jobCancelled(jobId) {
  const row = db.prepare(`SELECT cancel_requested FROM local_batch_jobs WHERE id=?`).get(jobId);
  return Number(row?.cancel_requested || 0) === 1;
}

function markItemPendingCancelled(itemId, reason) {
  let count = 0;
  for (const stage of listStages(db, itemId)) {
    if (stage.status === STAGE_STATUS.PENDING) {
      storage.resetStage(db, { stageId: stage.id, status: STAGE_STATUS.CANCELLED, errorCode: reason });
      count += 1;
    }
  }
  return count;
}

/**
 * 把某个 item 从 fromIndex 起的仍未开始阶段标成 needs_review（不执行）。
 * 用于「前序阶段失败 / 需复核」或「企业与账套绑定无法核实」时停止该 item 的后续阶段，
 * 已提交的会计动作与已成功阶段保持原样，其它企业继续。
 */
function blockPendingStages({ stages, fromIndex = 0, errorCode, errorMessage, evidence }) {
  let marked = 0;
  for (let index = fromIndex; index < stages.length; index += 1) {
    const stage = stages[index];
    if (stage.status !== STAGE_STATUS.PENDING) continue;
    storage.resetStage(db, {
      stageId: stage.id, status: STAGE_STATUS.NEEDS_REVIEW,
      errorCode, errorMessage, evidence,
    });
    marked += 1;
  }
  return marked;
}

/** 该 item 是否有「首次建账 / 显式新绑定」这类允许尚未绑定的阶段。 */
function itemAllowsUnboundSet(stages) {
  return stages.some((stage) => {
    if (!stage.stage_key.startsWith(`${STAGE_KEYS.IMPORT}:`)) return false;
    const spec = safeJson(stage.spec_json);
    return spec.mode === "create" || spec.confirmNewBinding === true;
  });
}

/**
 * 把「绑定推断出的真实账套」写进 item（一家企业只有一个账套）。
 * 只补空值、不改变已声明 / 已落库的账套；调用点必须在 resolveItemBinding 成功之后，
 * 因此错绑定 / 缺绑定仍会在任何写入之前抛错（零写）。
 * 目的：manifest 省略可选 accountSetId 时，推断结果必须是持久事实，
 * 而不是只在锁作用域 / 内存快照里，否则后续阶段、产物证据与恢复核验仍按 null 计算。
 */
function persistResolvedAccountSet(item, bindingInfo) {
  const resolved = bindingInfo?.accountSetId ?? null;
  if (!resolved || (item.account_set_id !== null && item.account_set_id !== undefined)) return item;
  storage.setItemAccountSet(db, { itemId: item.id, accountSetId: resolved, source: "enterprise_binding" });
  return storage.getItem(db, item.id) ?? { ...item, account_set_id: resolved };
}

/**
 * 主执行流程。返回 { status, jobId, jobKey, active, phases }。
 * 只有持有 job 锁的执行实例能推进阶段；第二个同 jobKey 进程会得到 active=true。
 */
export async function executeJob({
  job, instance = newInstanceId(), pid = process.pid, hooks = null, log = () => {},
  allowSnapshotOnly = false,
} = {}) {
  if (!job) throw batchError("job_required", {});
  storage.assertBatchRunnable(db,{jobId:job.id});
  const lock = { resourceKey: `job:${job.id}`, instance };
  let jobResources;
  try {
    jobResources = acquireWriteResources(db,[lock.resourceKey],{instance,pid});
  } catch (error) {
    if (["lock_active", "owner_active", "lock_takeover_race"].includes(error?.code)) {
      const current = getJob(db, job.id);
      return { jobId: job.id, jobKey: current.job_key, status: current.status, active: true, reason: error.code };
    }
    throw error;
  }
  lock.token = writeResourceLocks(db,jobResources)[0].token;
  const report = { jobId: job.id, jobKey: job.job_key, active: false, phases: [], reset: [], items: [] };
  const pool = createRenderPool(Math.max(1, Math.min(Number(job.concurrency) || 1, MANIFEST_LIMITS.concurrencyMax)));
  let jobStatus = job.status;
  try {
    report.reset = recoverInterruptedStages(job.id);
    if (jobCancelled(job.id)) {
      for (const item of listItems(db, job.id)) report.items.push({ itemKey: item.item_key, cancelled: markItemPendingCancelled(item.id, "cancelled_by_operator") });
      jobStatus = refreshStatuses(db, job.id);
      report.status = jobStatus;
      return report;
    }
    // ---------------- Phase 1：同步会计写 + 报表 DTO 快照 ----------------
    for (const item of listItems(db, job.id)) {
      const itemReport = { itemKey: item.item_key, itemId: item.id, stages: [] };
      report.items.push(itemReport);
      const stages = listStages(db, item.id);
      // 每个 item 的**任何**动作（含无 import 的过账 / 计提 / 结转 / 检查 / 结账 / 报表 / 恢复核验）之前，
      // 先统一核实「规范企业身份 ↔ 账套」绑定：一家企业只有一个账套。
      // 核实失败直接在本 item 内停止，零业务写入，其它企业继续。
      let itemLocks;
      try {itemLocks=acquireItemLocks({item,instance,pid,parent:jobResources});}
      catch(error){itemReport.lockBlocked=error?.code??'lock_error';blockPendingStages({stages,errorCode:itemReport.lockBlocked});continue;}
      let bindingItem=item;
      const verifyCompleted=()=>withWriteResources(db,itemLocks,()=>storage.withFencedTransaction(db,lock,()=>verifySucceededStages(bindingItem,stages,job.output_dir,{allowSnapshotOnly})));
      try {
        try {
          withWriteResources(db,itemLocks,()=>storage.withFencedTransaction(db,lock,()=>{
            const bindingInfo=actions.resolveItemBinding({db,item,allowUnboundSet:itemAllowsUnboundSet(stages)});
            bindingItem=persistResolvedAccountSet(item,bindingInfo);
          }));
        }catch(error){
          const code=String(error?.code??'enterprise_binding_error').slice(0,120);itemReport.bindingBlocked=code;
          // A binding failure cannot bypass verification of completed effects.
          // Keep their evidence, mark drift for review, and never replay finance.
          itemReport.verified=verifyCompleted();
          itemReport.blockedStages=blockPendingStages({stages,errorCode:code});continue;
        }
        const hasWork=stages.some(s=>s.status===STAGE_STATUS.PENDING);
        if(!hasWork){itemReport.verified=verifyCompleted();continue;}
        renewWriteResources(db,jobResources);
        const verified = verifyCompleted();
        itemReport.verified = verified;
        if (verified.blocked) {
          for (const stage of stages.filter((entry) => entry.status === STAGE_STATUS.PENDING)) {
            storage.resetStage(db, { stageId: stage.id, status: STAGE_STATUS.NEEDS_REVIEW, errorCode: "evidence_changed" });
          }
          continue;
        }
        // 线性按「期间 → 阶段顺序」推进：任何前序 failed / needs_review 都不得被越过去执行后序阶段
        // （例如 post 失败后绝不能直接补做计提），同一次执行里产生 needs_review 也同样停住该 item。
        let stop = null;
        for (let index = 0; index < stages.length; index += 1) {
          const stage = stages[index];
          if (stage.stage_key.startsWith(`${STAGE_KEYS.REPORT}:`)) continue;
          if ([STAGE_STATUS.FAILED, STAGE_STATUS.NEEDS_REVIEW].includes(stage.status)) {
            stop = { index, stage, errorCode: stage.error_code || "prior_stage_unresolved" };
            break;
          }
          if (stage.status !== STAGE_STATUS.PENDING) continue;
          if (jobCancelled(job.id)) {
            itemReport.cancelled = markItemPendingCancelled(item.id, "cancelled_by_operator");
            break;
          }
          // 输入源证据：首次执行与普通续跑都核验源文件；显式 --use-saved-inputs 才允许沿用快照，
          // 且把选择与原因写进阶段证据（不静默改用旧内容）。
          let inputPolicy = null;
          if (stage.stage_key.startsWith(`${STAGE_KEYS.IMPORT}:`)) {
            const importSpec = safeJson(stage.spec_json);
            const input = storage.getInput(db, { jobId: job.id, itemId: item.id, batchId: importSpec.batchId });
            const check = storage.checkInputEvidence(input);
            itemReport.inputEvidence = [...(itemReport.inputEvidence || []), {
              period: stage.period, batchId: importSpec.batchId, ok: check.ok === true,
              problem: check.problem ?? null, external: check.external === true,
            }];
            if (!check.ok) {
              const code = String(check.problem || "input_changed").slice(0, 120);
              if (!allowSnapshotOnly||check.savedValid===false) {
                storage.resetStage(db, {
                  stageId: stage.id, status: STAGE_STATUS.NEEDS_REVIEW, errorCode: code,
                  errorMessage: "源资料证据已变化 / 丢失：拒绝静默沿用已保存快照",
                  evidence: { inputEvidence: { problem: code, batchId: importSpec.batchId, period: stage.period } },
                });
                itemReport.inputBlocked = code;
                stop = { index, stage: { ...stage, error_code: code }, errorCode: code };
                break;
              }
              inputPolicy = { mode: "saved_snapshot", problem: code };
            }
          }
          renewWriteResources(db,jobResources);
          renewItemLocks(itemLocks);
          const currentItem = storage.getItem(db, item.id);
          const claim = storage.claimStage(db, { stageId: stage.id, instance, token: lock.token, inputHash: stage.input_hash });
          if (!claim.claimed) continue;
          const ctx = {
            db, stage: claim.stage, item: currentItem, spec: safeJson(stage.spec_json),
            lock, resources:itemLocks, attempt: claim.attempt, hooks, inputPolicy,
          };
          let result;
          try {
            result = actions.executeStage(ctx);
            if (result?.accountSetId && !currentItem.account_set_id) {
              // The audited outer already persisted the resolved set and its lock.
              bindingItem=storage.getItem(db,item.id);
            }
            itemReport.stages.push({ stageKey: stage.stage_key, period: stage.period, status: result?.status ?? STAGE_STATUS.SUCCEEDED, attempt: claim.attempt });
          } catch (error) {
            if (hooks?.onStageError) hooks.onStageError({ stage: claim.stage, error });
            const failure = failStage({ stage: claim.stage, lock, attempt: claim.attempt, error });
            itemReport.stages.push({ stageKey: stage.stage_key, period: stage.period, ...failure, attempt: claim.attempt });
            stop = { index, stage: claim.stage, errorCode: failure.errorCode };
            break;
          }
          if (hooks?.afterStageCommit) hooks.afterStageCommit({ stage: claim.stage, item: currentItem, result });
          if ([STAGE_STATUS.FAILED, STAGE_STATUS.NEEDS_REVIEW].includes(result?.status)) {
            // 阶段自身登记了 failed / needs_review（如计提应提未提）：同样停止该 item 的后续阶段。
            stop = { index, stage: claim.stage, errorCode: result.errorCode ?? result.status };
            break;
          }
          if (jobCancelled(job.id)) {
            itemReport.cancelled = markItemPendingCancelled(item.id, "cancelled_by_operator");
            break;
          }
        }
        if (stop) {
          itemReport.stopped = {
            stageKey: stop.stage.stage_key, period: stop.stage.period, errorCode: stop.errorCode,
          };
          itemReport.blockedStages = blockPendingStages({
            stages, fromIndex: stop.index + 1, errorCode: "prior_stage_unresolved",
            errorMessage: "前序阶段失败 / 需复核：本阶段未执行，待显式 retry 修复后再续跑",
            evidence: {
              blockedBy: {
                period: stop.stage.period, stageKey: stop.stage.stage_key, errorCode: stop.errorCode,
              },
            },
          });
        }
        // 报表快照：仍持有该 item 的锁，保证快照对应的业务证据不被同账套其它执行者改动。
        const pendingReports = listPendingStages(db, item.id).filter((stage) => stage.stage_key.startsWith(`${STAGE_KEYS.REPORT}:`));
        if (pendingReports.length && !jobCancelled(job.id)) {
          // 只有真实失败 / 需复核会阻止报表；依赖未就绪（blocked_dependency）不阻止独立内部报表。
          const stillBlocked = listStages(db, item.id).some((stage) => (
            [STAGE_STATUS.FAILED, STAGE_STATUS.NEEDS_REVIEW].includes(stage.status)
            && !stage.stage_key.startsWith(`${STAGE_KEYS.REPORT}:`)
          ));
          if (!stillBlocked) {
            const finalItem = storage.getItem(db, item.id);
            const byPeriod = new Map();
            for (const stage of pendingReports) {
              const spec = safeJson(stage.spec_json);
              const key = stage.period;
              if (!byPeriod.has(key)) byPeriod.set(key, new Map());
              const kindKey = `${spec.kind}|${spec.code ?? ""}`;
              byPeriod.get(key).set(kindKey, { kind: spec.kind, code: spec.code ?? null });
            }
            try {
              for (const [period, kinds] of byPeriod) {
                const snapshots = withWriteResources(db,itemLocks,()=>actions.buildReportSnapshots({
                  item: finalItem, period, reports: [...kinds.values()],
                }));
                for (const snapshot of snapshots.reports) {
                  actions.persistSnapshot({ jobId: job.id, itemId: item.id, snapshot });
                }
                itemReport.snapshots = [...(itemReport.snapshots || []), { period, kinds: [...kinds.values()].map((entry) => entry.kind) }];
              }
            } catch (error) {
              // 快照 / 参数 / 账套异常只影响本 item 的报表阶段，不把整个 job 变成不可恢复的基础设施错误，
              // 也不影响其它企业继续执行。
              const status = stageFailureStatus(error);
              const code = String(error?.code || "report_snapshot_failed").slice(0, 120);
              itemReport.snapshotError = { errorCode: code, status };
              for (const stage of listPendingStages(db, item.id).filter((entry) => entry.stage_key.startsWith(`${STAGE_KEYS.REPORT}:`))) {
                storage.resetStage(db, {
                  stageId: stage.id, status, errorCode: code,
                  errorMessage: "报表快照生成失败：请查看错误码后修复并显式 retry",
                  evidence: { errorCode: code, phase: "report_snapshot", period: stage.period },
                });
              }
            }
          }
        }
      } finally {
        releaseItemLocks(itemLocks);
      }
    }
    // ---------------- Phase 2：worker 并发渲染 + 受控发布 ----------------
    const renderTasks = [];
    const pendingReportStages = listStagesByStatus(db, job.id, [STAGE_STATUS.PENDING])
      .filter((stage) => stage.stage_key.startsWith(`${STAGE_KEYS.REPORT}:`));
    for (const stage of pendingReportStages) {
      const spec = safeJson(stage.spec_json);
      const snapshot = getSnapshot(db, { itemId: stage.item_id, period: stage.period, kind: spec.kind });
      if (!snapshot) {
        storage.resetStage(db, {
          stageId: stage.id, status: STAGE_STATUS.NEEDS_REVIEW, errorCode: "report_snapshot_missing",
          errorMessage: "报表快照缺失：请先补齐上游阶段或显式 retry",
        });
        continue;
      }
      renderTasks.push({ stage, spec, snapshot, allowSnapshotOnly, item: storage.getItem(db, stage.item_id) });
    }
    // Round-robin by item so independent enterprises enter the first worker wave.
    // Preserve each item's original report order and all existing claim/publish fences.
    const itemQueues=new Map();
    for(const task of renderTasks){const queue=itemQueues.get(task.stage.item_id)??[];queue.push(task);itemQueues.set(task.stage.item_id,queue);}
    const fairTasks=[];let offset=0;
    while(fairTasks.length<renderTasks.length){for(const queue of itemQueues.values())if(offset<queue.length)fairTasks.push(queue[offset]);offset++;}
    renderTasks.splice(0,renderTasks.length,...fairTasks);
    report.renderConcurrency = pool.size;
    const results = [];
    const runOne = async (task) => {
      if (jobCancelled(job.id)) {
        storage.resetStage(db, { stageId: task.stage.id, status: STAGE_STATUS.CANCELLED, errorCode: "cancelled_by_operator" });
        return { stageId: task.stage.id, cancelled: true };
      }
      const inputHash = actions.reportInputHash(task.snapshot, task.spec.format, task.spec.code);
      const claim = storage.claimStage(db, {
        stageId: task.stage.id, instance, token: lock.token, inputHash,
      });
      if (!claim.claimed) return { stageId: task.stage.id, skipped: true };
      try {
        const outcome = await renderAndPublish({
          task, job, lock, jobResources, attempt: claim.attempt, instance, pid, hooks, pool,
        });
        return { stageId: task.stage.id, stageKey: task.stage.stage_key, ...outcome };
      } catch (error) {
        if (hooks?.onStageError) hooks.onStageError({ stage: claim.stage, error });
        const failure = failStage({ stage: claim.stage, lock, attempt: claim.attempt, error });
        return { stageId: task.stage.id, stageKey: task.stage.stage_key, ...failure, errorCode: error?.code ?? failure.errorCode };
      }
    };
    // 真实并发：同一时刻最多 concurrency 个渲染任务被认领并在池内执行（取消 / 崩溃不会预先占用全部阶段）。
    renewWriteResources(db,jobResources);
    const settled = await mapLimit(renderTasks, pool.size, async (task) => {
      const value = await runOne(task);
      renewWriteResources(db,jobResources);
      if (hooks?.afterReportStage) await hooks.afterReportStage({ value, task });
      return value;
    });
    for (const value of settled) results.push(value);
    report.results = results;
    report.renders = renderTasks.length;
    jobStatus = refreshStatuses(db, job.id);
    report.status = jobStatus;
    if (jobCancelled(job.id)) {
      for (const item of listItems(db, job.id)) markItemPendingCancelled(item.id, "cancelled_by_operator");
      jobStatus = refreshStatuses(db, job.id);
      report.status = jobStatus;
    }
    return report;
  } finally {
    await pool.close();
    releaseWriteResources(db,jobResources);
    report.finalStatus = (() => {
      try { return getJob(db, job.id)?.status ?? jobStatus; } catch { return jobStatus; }
    })();
  }
}

// ---------------------------------------------------------------- 并发上限工具
/** 以固定并发度执行任务（保持提交顺序），保证「已认领阶段数」不超过渲染池大小。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// 已成功阶段的上游证据核验：任何被反过账 / 改动 / 删除都停下并转 needs_review。
function verifySucceededStages(item, stages, outputDir, {allowSnapshotOnly=false}={}) {
  const problems = [];
  for (const stage of stages) {
    if (![STAGE_STATUS.SUCCEEDED, STAGE_STATUS.NOT_APPLICABLE].includes(stage.status)) continue;
    const check = actions.verifyStageEvidence({ stage, item, outputDir, allowSnapshotOnly });
    if (!check.ok) problems.push({ stageKey: stage.stage_key, period: stage.period, reason: check.reason });
  }
  if (!problems.length) return { ok: true };
  // 上游证据变化：已成功阶段本身与后续阶段都要停下等待人工复核（不盲目续跑）。
  for (const problem of problems) {
    const stage = stages.find((entry) => entry.stage_key === problem.stageKey && entry.period === problem.period);
    if (!stage) continue;
    db.prepare(`UPDATE local_batch_stages SET status=?, error_code=?, error_message=?, evidence_json=?, updated_at=?
        WHERE id=?`)
      .run(STAGE_STATUS.NEEDS_REVIEW, "evidence_changed", `上游业务证据已变化：${problem.reason}`,
        canonicalJson({ ...safeJson(stage.evidence_json), verificationFailure: problem.reason }),
        storage.nowIso(), stage.id);
  }
  return { ok: false, blocked: true, problems };
}

async function renderAndPublish({ task, job, lock, jobResources, attempt, instance, pid, hooks, pool }) {
  const { stage, spec, snapshot, item } = task;
  const outputDir = job.output_dir;
  const relativePath = relativeArtifactPath({
    jobKey: job.job_key, itemKey: item.item_key, period: stage.period,
    kind: spec.kind, code: spec.code, format: spec.format,
  });
  const snapshotHash = actions.reportInputHash(snapshot, spec.format, spec.code);
  const accountSetId = item.account_set_id;
  const existing = getArtifactByStage(db, { itemId: item.id, period: stage.period, stageKey: stage.stage_key });
  const finalPath = resolve(outputDir, relativePath);

  const assertCurrentEvidence=()=>{
    const binding=actions.resolveItemBinding({db,item});
    if(binding.accountSetId!==accountSetId||actions.reportBusinessDigest(db,accountSetId,stage.period)!==snapshot.business_hash)throw batchError('report_evidence_changed');
    const saved=getSnapshot(db,{itemId:item.id,period:stage.period,kind:spec.kind});
    if(!saved||['dto_hash','dto_json','business_hash','csv_hash','csv_text'].some(k=>saved[k]!==snapshot[k]))throw batchError('report_snapshot_changed');
    const source=actions.verifyReportSourceEvidence({item,period:stage.period});if(!source.ok)throw batchError('report_evidence_changed',{reason:source.reason});
    const input=actions.verifyReportInputEvidence({item,period:stage.period,allowSnapshotOnly:task.allowSnapshotOnly});if(!input.ok)throw batchError(input.reason);
  };
  const publishLocked=fn=>{
    const resources=acquireItemLocks({item,instance,pid,parent:jobResources});
    try{return withWriteResources(db,resources,()=>{
      storage.withReadSnapshot(db,assertCurrentEvidence);
      return withWriteStageFence(db,{stageId:stage.id,instance:lock.instance,token:lock.token,attempt},fn);
    });}finally{releaseItemLocks(resources);}
  };
  // 恢复协议：文件已完整发布（含 publish 后、checkpoint 前崩溃）、只是阶段没落 → hash 一致则补记，不重渲染。
  if (existing && ["published", "publishing"].includes(existing.status) && existing.snapshot_hash === snapshotHash
      && existsSync(finalPath) && hashFile(finalPath) === existing.bytes_hash) {
    return publishLocked(()=>{auditedReportStep({db,job,item,stage,lock,attempt,phase:'recover'},()=>{
      assertCurrentEvidence();
      db.prepare(`UPDATE local_batch_artifacts SET status=?, updated_at=? WHERE id=?`)
        .run("published", storage.nowIso(), existing.id);
      const ok = storage.writeStageResult(db, {
        stageId: stage.id, instance, token: lock.token, attempt,
        status: STAGE_STATUS.SUCCEEDED, outcomeHash: existing.bytes_hash,
        evidence: {
          artifactKey: existing.artifact_key, kind: spec.kind, format: spec.format, code: spec.code,
          bytes: existing.bytes, bytesHash: existing.bytes_hash, relativePath: existing.relative_path,
          snapshotHash: existing.snapshot_hash, accountSetId,
          businessHash: snapshot.business_hash, recovered: true,
          workerThreadId: existing.worker_thread_id, renderStarted: existing.render_started,
          renderFinished: existing.render_finished,
        },
      });
      if (!ok) throw batchError("stage_result_rejected", {});
      assertCurrentEvidence();
    });
    return { status: STAGE_STATUS.SUCCEEDED, recovered: true, artifactKey: existing.artifact_key };});
  }
  if (existing && existsSync(finalPath) && hashFile(finalPath) !== existing.bytes_hash) {
    // 文件被改 / 损坏：标失效，只重做该报表。
    db.prepare(`UPDATE local_batch_artifacts SET status=?, updated_at=? WHERE id=?`)
      .run("invalid", storage.nowIso(), existing.id);
  }
  const artifactKey = `${job.job_key}#${item.item_key}#${stage.period}#${stage.stage_key}`;
  let bytes;
  let contentType;
  let workerThreadId = null;
  let renderStarted = null;
  let renderFinished = null;
  if (spec.format === "csv") {
    bytes = Buffer.from(snapshot.csv_text ?? "", "utf8");
    if (sha256(bytes) !== snapshot.csv_hash) throw batchError("report_snapshot_changed", { kind: spec.kind });
    contentType = "text/csv; charset=utf-8";
    renderStarted = performance.timeOrigin + performance.now();
  } else {
    const dto = JSON.parse(snapshot.dto_json);
    const rendered = await pool.run({ dto, format: spec.format });
    bytes = rendered.buffer;
    workerThreadId = rendered.threadId;
    renderStarted = rendered.started;
    renderFinished = rendered.finished;
    contentType = spec.format === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/pdf";
  }
  if (!bytes?.length) throw batchError("report_render_empty", { format: spec.format });
  const bytesHash = sha256(bytes);
  if (hooks?.beforeArtifactPublish) hooks.beforeArtifactPublish({ stage, item, relativePath });

  return publishLocked(()=>{
  // 先登记 publishing（含预期 hash），再发布文件；崩溃后可按 hash 确认并补记。
  auditedReportStep({db,job,item,stage,lock,attempt,phase:'publishing'},()=>{
    assertCurrentEvidence();
    const row = db.prepare(`SELECT id FROM local_batch_artifacts WHERE artifact_key=?`).get(artifactKey);
    if (row) {
      db.prepare(`UPDATE local_batch_artifacts
          SET snapshot_hash=?, bytes_hash=?, bytes=?, mime=?, relative_path=?, status=?, attempt=?,
              worker_thread_id=?, render_started=?, render_finished=?, updated_at=?
          WHERE id=?`)
        .run(snapshotHash, bytesHash, bytes.length, contentType, relativePath, "publishing", attempt,
          workerThreadId, renderStarted, renderFinished, storage.nowIso(), row.id);
    } else {
      db.prepare(`INSERT INTO local_batch_artifacts
          (artifact_key, job_id, item_id, period, stage_key, kind, format, account_code, snapshot_hash,
           bytes_hash, bytes, mime, relative_path, status, attempt, worker_thread_id, render_started,
           render_finished, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(artifactKey, job.id, item.id, stage.period, stage.stage_key, spec.kind, spec.format,
          spec.code ?? null, snapshotHash, bytesHash, bytes.length, contentType, relativePath, "publishing",
          attempt, workerThreadId, renderStarted, renderFinished, storage.nowIso(), storage.nowIso());
    }
  });
  const published = publishFile({ bytes, bytesHash, relativePath, outputDir });
  if (hooks?.afterArtifactPublish) hooks.afterArtifactPublish({ stage, item, relativePath, published });
  auditedReportStep({db,job,item,stage,lock,attempt,phase:'published'},()=>{
    if(!existsSync(finalPath)||hashFile(finalPath)!==bytesHash)throw batchError('artifact_hash_mismatch');
    assertCurrentEvidence();
    db.prepare(`UPDATE local_batch_artifacts SET status=?, updated_at=? WHERE artifact_key=?`)
      .run("published", storage.nowIso(), artifactKey);
    const ok = storage.writeStageResult(db, {
      stageId: stage.id, instance, token: lock.token, attempt,
      status: STAGE_STATUS.SUCCEEDED, outcomeHash: bytesHash,
      evidence: {
        artifactKey, kind: spec.kind, format: spec.format, code: spec.code,
        bytes: bytes.length, bytesHash, relativePath, snapshotHash,
        accountSetId,
        businessHash: snapshot.business_hash, workerThreadId, renderStarted, renderFinished,
        recovered: published.recovered === true,
      },
    });
    if (!ok) throw batchError("stage_result_rejected", {});
    assertCurrentEvidence();
  });
  return { status: STAGE_STATUS.SUCCEEDED, artifactKey, bytesHash, bytes: bytes.length, workerThreadId, renderStarted, renderFinished };
  });
}

// ---------------------------------------------------------------- 对外命令实现
/** 依据已在 DB 之外验证 / 展开的 manifest 计划创建（或幂等返回）job 并执行。 */
export async function createAndRun({
  manifest, manifestHash, manifestJson, plans, inputs, outputDir, hooks = null, instance = newInstanceId(),
  allowSnapshotOnly = false,
}) {
  storage.assertBatchRunnable(db);
  const resolvedOutput = resolve(outputDir);
  ensureDir(resolvedOutput);
  const { job, created } = storage.createJob(db, {
    manifest, manifestHash, manifestJson, outputDir: resolvedOutput, plans, inputs,
  });
  const result = await executeJob({ job: getJob(db, job.id), instance, hooks, allowSnapshotOnly });
  return { ...result, created, manifestHash };
}

export async function resumeJob({ jobKey, hooks = null, instance = newInstanceId(), allowSnapshotOnly = false } = {}) {
  storage.assertBatchRunnable(db);
  const job = getJobByKey(db, jobKey);
  if (!job) throw batchError("job_not_found", { jobKey });
  // 即使 job 已 succeeded 也要真正执行一次：恢复必须先重新核验已成功阶段的上游证据。
  const result = await executeJob({ job, instance, hooks, allowSnapshotOnly });
  return result;
}

export { refreshStatuses, getJobByKey };
/** 业务库连接（CLI 在动态 import 本模块后用于建立 / 校验批量结构）。 */
export const database = db;

// File rendering/publication stays outside SQLite. Only verified metadata steps
// own short synchronous audit transactions; this does not claim cross-media atomicity.
function auditedReportStep({db,job,item,stage,lock,attempt,phase},fn) {
 return runAuditedBatchStage(db,{action:'batch.stage',operationId:storage.stageAuditOperationId({...stage,attempt})+'.report-'+phase,scope:{kind:'account_set',value:item.account_set_id},context:{jobId:String(job.id),itemId:String(item.id),stageId:String(stage.id),period:stage.period},request:{stageId:stage.id,attempt,phase,inputHash:stage.input_hash}},[],()=>storage.withFencedTransaction(db,lock,()=>{storage.assertClaimedStage(db,{stageId:stage.id,instance:lock.instance,token:lock.token,attempt});fn();const owner=db.prepare('SELECT owner_instance,fencing_token,attempt FROM local_batch_stages WHERE id=?').get(stage.id);if(!owner||owner.owner_instance!==lock.instance||owner.fencing_token!==lock.token||owner.attempt!==attempt)throw batchError('fence_lost');return {phase};}));
}
