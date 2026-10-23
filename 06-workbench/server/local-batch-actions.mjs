// local-batch-actions.mjs — LOCAL-07 固定本地操作的真实领域适配层。
//
// 只允许这 7 类操作：import → post → depreciation → carryforward → period-check → close → reports。
// 本文件不复制任何金额 / 结账 / 折旧算法，只调用既有已审领域接口：
//   - import：import-incremental.mjs（自带 BEGIN IMMEDIATE，禁止外包事务）
//   - post / depreciation / carryforward：accounting.mjs
//    折旧 / 结转 / 封账的应提 / 不适用 / 拒绝一律复用已合入的 LOCAL-02 纯领域规则与事务保存点，
//    不另写金额 / 起提 / 封账算法。
//   - period-check / close：已合入的 LOCAL-02 A.periodEndCheck / setPeriodStatus（只读检查 + 核心重新校验前置）
//   - reports：report-export.mjs 的一致只读 DTO 快照（渲染在 worker 线程，见 runner）
//
// 事务边界：除 import 外，每个阶段的「会计效果 + checkpoint」都在同一个 BEGIN IMMEDIATE 内，
// 并先做 fence 校验（旧 owner / 旧 token 无法提交）。不能在同一事务内 fence 的 import 采用
// 上游自身的批次幂等 + 事后真实核验 + 独立 fence 事务补 checkpoint（commit 后崩溃可安全回放）。

import {
  STAGE_KEYS, STAGE_STATUS, canonicalJson, getInput, getSnapshot, saveSnapshot, sha256,
  withFencedTransaction, withReadSnapshot, writeStageResult,
} from "./local-batch-storage.mjs";
import { assetCardPeriodStatus } from "./period-end-controls.mjs";
import { centsToNumber } from "./money.mjs";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

// 数据目录守卫：本模块会通过 db.mjs 打开业务库，因此必须由调用方先显式设置 WORKBENCH_DATA_DIR。
// 未设置时立即失败，不 import db.mjs，也不会触碰默认数据目录。
if (!process.env.WORKBENCH_DATA_DIR || !String(process.env.WORKBENCH_DATA_DIR).trim()) {
  const error = new Error("local_batch_data_dir_required");
  error.code = "local_batch_data_dir_required";
  throw error;
}
const [A, { db }, importStorage, importIncrementalModule, reportExportModule] = await Promise.all([
  import("./accounting.mjs"),
  import("./db.mjs"),
  import("./import-storage.mjs"),
  import("./import-incremental.mjs"),
  import("./report-export.mjs"),
]);
const {
  getAccountSetEnterprise, getEnterpriseAccountSet, getVoucherSource, persistedVoucherFingerprint,
} = importStorage;
const { getImportBatch, importIncremental } = importIncrementalModule;
const { buildReportExport } = reportExportModule;

const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const EPS = 0.005;

export const IMPORT_STAGE_PREFIX = `${STAGE_KEYS.IMPORT}:`;

function domainError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

/** 只保存结构化错误码，不保存原始账务文本 / 金额 / 堆栈。 */
function sanitizeError(error) {
  const code = error?.code || error?.message || "stage_failed";
  return {
    code: String(code).slice(0, 120),
    message: "阶段执行失败：请查看状态中的错误码与证据摘要",
  };
}

// ---------------------------------------------------------------- 证据指纹
/**
 * 某账套某期间的业务证据摘要。
 *
 * 报表实际读取的范围（见 report-export.mjs）：账套登记、科目定义、全部期初余额、
 * 自启用期间起至该期末的已过账凭证及分录（试算 / 三表 / 明细账都用 `period BETWEEN start AND period`，
 * 现金流量表还要逐月回看），以及该期末及以前期间的期间状态。
 * 因此摘要**必须**覆盖：以前期间（含跨年）、期初、本年累计、科目 / 账套定义变动、期间状态。
 * 只按 `period=?` 取本期凭证会漏掉以前期间被反过账 / 改金额 / 删除（报表内容已变、旧产物却仍被当成功）。
 * 本期之后的数据不在此报表依赖范围内，不进入摘要（避免无意义的失效告警）。
 */
export function businessDigest(db, setId, period) {
  const accountSet = db.prepare(
    `SELECT id, name, start_period, accounting_standard FROM account_sets WHERE id=?`,
  ).get(setId) || null;
  const accounts = db.prepare(
    `SELECT code, name, category, direction, contra, is_leaf FROM accounts WHERE account_set_id=? ORDER BY code`,
  ).all(setId);
  const openings = db.prepare(
    `SELECT code, debit, credit FROM opening_balances WHERE account_set_id=? ORDER BY code`,
  ).all(setId);
  const periodRows = db.prepare(
    `SELECT period, status FROM periods WHERE account_set_id=? AND period<=? ORDER BY period`,
  ).all(setId, period);
  const voucherRows = db.prepare(
    `SELECT id, period, voucher_date, word, number, summary, status, kind FROM vouchers
      WHERE account_set_id=? AND status='posted' AND period<=? ORDER BY period, id`,
  ).all(setId, period);
  const entryRows = db.prepare(
    `SELECT e.voucher_id, e.line_no, e.code, e.summary, e.debit, e.credit
       FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.account_set_id=? AND v.status='posted' AND v.period<=?
      ORDER BY e.voucher_id, e.line_no`,
  ).all(setId, period);
  const entriesByVoucher = new Map();
  for (const entry of entryRows) {
    if (!entriesByVoucher.has(entry.voucher_id)) entriesByVoucher.set(entry.voucher_id, []);
    entriesByVoucher.get(entry.voucher_id).push(entry);
  }
  const vouchers = voucherRows.map((voucher) => ({
    id: voucher.id, period: voucher.period, status: voucher.status, kind: voucher.kind,
    fingerprint: persistedVoucherFingerprint(voucher, entriesByVoucher.get(voucher.id) || []),
  }));
  return sha256(canonicalJson({
    setId, period, accountSet, accounts, openings, periods: periodRows, vouchers,
  }));
}

/**
 * 统一核实「规范企业身份 ↔ 账套」绑定（一家企业一个账套），任何阶段执行前都先过这一关。
 * - 绑定的账套与本次声明的账套不一致：enterprise_binding_mismatch；
 * - 声明的账套已绑定到其它企业：account_set_enterprise_mismatch；
 * - 非首次建账/绑定阶段却找不到该企业绑定：enterprise_binding_missing。
 * 抛错发生在任何写操作之前，因此失败本身不产生业务变化。
 */
export function resolveItemBinding({ db, item, stage = null, allowUnboundSet = false }) {
  const declared = item.account_set_id === undefined || item.account_set_id === null
    ? null : Number(item.account_set_id);
  const binding = getEnterpriseAccountSet(db, item.enterprise_key);
  const boundSetId = binding ? Number(binding.account_set_id) : null;
  const resolved = declared ?? boundSetId;
  const unboundAllowed = allowUnboundSet || (stage ? stageAllowsUnboundSet(stage) : false);
  if (boundSetId !== null && resolved !== null && boundSetId !== resolved) {
    throw domainError("enterprise_binding_mismatch", "企业身份已绑定其它账套：一家企业只有一个账套", {
      boundAccountSetId: boundSetId, declaredAccountSetId: resolved,
    });
  }
  if (resolved === null) {
    if (unboundAllowed) return { accountSetId: null, binding, bound: false };
    throw domainError("account_set_unresolved", "本 item 未声明账套，且该企业身份尚未绑定账套");
  }
  const setBinding = getAccountSetEnterprise(db, resolved);
  if (setBinding && setBinding.enterprise_key !== item.enterprise_key) {
    throw domainError("account_set_enterprise_mismatch", "该账套已绑定其它企业身份：一个账套只能属于一家企业", {
      declaredAccountSetId: resolved,
    });
  }
  if (boundSetId === null && !unboundAllowed) {
    throw domainError("enterprise_binding_missing", "该企业身份尚未绑定任何账套：拒绝在未建立绑定时执行", {
      declaredAccountSetId: resolved,
    });
  }
  return { accountSetId: resolved, binding, bound: boundSetId !== null };
}

/** 首次建账或显式确认新绑定允许「还未绑定 / 未建账」的状态。 */
function stageAllowsUnboundSet(stage) {
  if (!String(stage.stage_key).startsWith(IMPORT_STAGE_PREFIX)) return false;
  const spec = safeParse(stage.spec_json);
  return spec.mode === "create" || spec.confirmNewBinding === true;
}

function voucherEvidence(voucher) {
  const entries = db.prepare(
    `SELECT code, summary, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`,
  ).all(voucher.id);
  return {
    voucherId: voucher.id, status: voucher.status, period: voucher.period, kind: voucher.kind,
    totalDebit: r2(entries.reduce((sum, entry) => sum + entry.debit, 0)),
    totalCredit: r2(entries.reduce((sum, entry) => sum + entry.credit, 0)),
    entriesHash: persistedVoucherFingerprint(voucher, entries),
    entryCount: entries.length,
  };
}

// ---------------------------------------------------------------- import
/**
 * 执行一条 import 规格（item 内一个时期的一条 batch）。
 * 校验顺序：输入快照指纹 → 领域严格校验 / 幂等 → 批次与逐张来源凭证真实核验 → fence 事务补 checkpoint。
 */
export function executeImportStage(ctx) {
  const { db, stage, item, spec, lock, hooks } = ctx;
  const input = getInput(db, { jobId: item.job_id, itemId: item.id, batchId: spec.batchId });
  if (!input) throw domainError("input_snapshot_missing", "缺少该批次的输入快照");
  const bytes = Buffer.from(input.content);
  const bytesHash = sha256(bytes);
  if (bytesHash !== input.source_hash) throw domainError("input_changed", "已保存的输入快照指纹与登记不一致");
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw domainError("input_payload_invalid", "输入快照不是合法 JSON");
  }
  const setId = item.account_set_id;
  if (spec.mode === "append" && !setId) {
    throw domainError("account_set_unresolved", "追加导入没有已确认账套（必须有 item.accountSetId 或本 item 前一 create 的真实结果）");
  }
  const options = {
    batchId: spec.batchId,
    source: {
      system: item.source_system,
      enterpriseKey: item.enterprise_key,
      enterpriseName: item.enterprise_name || "",
    },
    mode: spec.mode,
    payload,
    confirmNewBinding: spec.confirmNewBinding === true,
    dryRun: false,
  };
  if (spec.mode === "append") options.accountSetId = setId;
  const result = importIncremental(options);
  if (!result || result.ok !== true) {
    const conflicts = Array.isArray(result?.conflicts) ? result.conflicts.map((c) => c.code) : [];
    const errors = Array.isArray(result?.errors) ? result.errors.length : 0;
    const code = conflicts[0] || (errors ? "import_validation_rejected" : "import_rejected");
    throw domainError(code, "增量导入被拒绝：结构化冲突或严格校验失败", { conflicts, errorCount: errors });
  }
  if (![ "applied", "idempotent_replay" ].includes(result.status)) {
    throw domainError("import_status_unexpected", "增量导入返回了非落库状态", { status: result.status });
  }
  // commit 之后、checkpoint 之前的崩溃点（测试可注入）。
  const afterCommit = () => { if (hooks?.afterImportCommit) hooks.afterImportCommit({ stage, item, result }); };
  afterCommit();

  // 真实核验：批次必须 completed，逐张来源凭证状态必须 ok（不是看到 completed 字段就成功）。
  const batch = getImportBatch(spec.batchId);
  if (!batch?.batch || batch.batch.status !== "completed") {
    throw domainError("import_batch_not_completed", "批次未标记完成", { status: batch?.batch?.status ?? null });
  }
  const trace = Array.isArray(batch.sourceTrace) ? batch.sourceTrace : [];
  const bad = trace.filter((entry) => entry.state !== "ok");
  if (bad.length) {
    throw domainError("import_trace_inconsistent", "逐张来源凭证核验不是全部 ok", {
      bad: bad.slice(0, 5).map((entry) => ({ sourceVoucherId: entry.sourceVoucherId, state: entry.state })),
    });
  }
  const accountSetId = result.accountSetId ?? result.created?.accountSetId ?? batch.batch.accountSetId;
  if (!Number.isInteger(accountSetId) || accountSetId <= 0) {
    throw domainError("import_account_set_missing", "导入未返回真实账套 ID");
  }
  const binding = getEnterpriseAccountSet(db, item.enterprise_key);
  if (!binding || binding.account_set_id !== accountSetId) {
    throw domainError("import_enterprise_binding_mismatch", "账套未绑定该规范企业身份");
  }
  const voucherRows = trace.map((entry) => {
    const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(entry.voucherId);
    if (!voucher) throw domainError("import_voucher_missing", "来源追踪指向的本机凭证不存在");
    if (voucher.account_set_id !== accountSetId) throw domainError("import_voucher_account_set_mismatch", "凭证账套与批次不一致");
    if (voucher.status !== "posted") throw domainError("import_voucher_unposted", "导入凭证不是已过账状态");
    const evidence = voucherEvidence(voucher);
    return { sourceVoucherId: entry.sourceVoucherId, action: entry.action, ...evidence };
  });
  const evidence = {
    batchId: spec.batchId,
    mode: spec.mode,
    status: result.status,
    // 源证据留痕：默认要求本次执行前源文件指纹一致；只有操作者显式 --use-saved-inputs
    // （或 retry 显式选择快照）才允许沿用快照，且必须记录选择与原因。
    inputEvidence: ctx.inputPolicy
      ? { mode: "saved_snapshot", reason: ctx.inputPolicy.problem ?? "explicit_use_saved_inputs", sourceHash: bytesHash }
      : { mode: "source_file_verified", sourceHash: bytesHash },
    accountSetId,
    accountSetCreated: result.created?.accountSetCreated === true,
    vouchersCreated: Number(result.created?.vouchersCreated ?? 0),
    vouchersDeduplicated: Number(result.created?.vouchersDeduplicated ?? 0),
    contentFingerprint: batch.batch.contentFingerprint ?? null,
    inputHash: bytesHash,
    sourceTrace: trace.map((entry) => ({
      sourceVoucherId: entry.sourceVoucherId, voucherId: entry.voucherId,
      action: entry.action, state: entry.state,
    })),
    vouchers: voucherRows,
    businessHash: businessDigest(db, accountSetId, stage.period),
  };
  const outcomeHash = sha256(canonicalJson(evidence));
  withFencedTransaction(db, lock, () => {
    const ok = writeStageResult(db, {
      stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
      status: STAGE_STATUS.SUCCEEDED, outcomeHash, evidence,
    });
    if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
  });
  return { status: STAGE_STATUS.SUCCEEDED, evidence, accountSetId };
}

// ---------------------------------------------------------------- post
function resolveVoucherRef(db, setId, ref, enterpriseKey, sourceSystem) {
  if (ref.voucherId) {
    const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(ref.voucherId);
    if (!voucher) throw domainError("voucher_not_found", "显式 voucherId 对应的凭证不存在", { voucherId: ref.voucherId });
    if (voucher.account_set_id !== setId) throw domainError("voucher_account_set_mismatch", "凭证不属于该账套");
    return voucher;
  }
  const source = getVoucherSource(db, sourceSystem, enterpriseKey, ref.sourceVoucherId);
  if (!source) throw domainError("source_voucher_not_found", "来源凭证未在本账套登记", { sourceVoucherId: ref.sourceVoucherId });
  if (source.account_set_id !== setId) throw domainError("source_voucher_account_set_mismatch", "来源凭证登记在其它账套");
  const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(source.voucher_id);
  if (!voucher) throw domainError("source_voucher_voucher_missing", "来源登记对应的凭证已被删除");
  return voucher;
}

/** 对 manifest 显式清单逐张过账；effect 与 checkpoint 同一事务。 */
export function executePostStage(ctx) {
  const { db, stage, item, spec, lock } = ctx;
  const setId = item.account_set_id;
  if (!setId) throw domainError("account_set_unresolved", "过账阶段缺少账套");
  return withFencedTransaction(db, lock, () => {
    const evidence = [];
    for (const ref of spec.vouchers) {
      const voucher = resolveVoucherRef(db, setId, ref, item.enterprise_key, item.source_system);
      const before = voucher.status;
      const posted = A.postVoucher(setId, voucher.id);
      if (posted.status !== "posted") throw domainError("voucher_post_not_confirmed", "过账后状态仍不是 posted");
      evidence.push({ ref: ref.voucherId ? { voucherId: ref.voucherId } : { sourceVoucherId: ref.sourceVoucherId }, before, ...voucherEvidence(posted) });
    }
    const outcome = {
      accountSetId: setId,
      businessHash: businessDigest(db, setId, stage.period),
      vouchers: evidence,
      postedCount: evidence.filter((entry) => entry.before !== "posted").length,
      alreadyPostedCount: evidence.filter((entry) => entry.before === "posted").length,
    };
    const outcomeHash = sha256(canonicalJson(outcome));
    const ok = writeStageResult(db, {
      stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
      status: STAGE_STATUS.SUCCEEDED, outcomeHash, evidence: outcome,
    });
    if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
    if (ctx.hooks?.inPostTransaction) ctx.hooks.inPostTransaction({ stage, item });
    return { status: STAGE_STATUS.SUCCEEDED, evidence: outcome };
  });
}

// ---------------------------------------------------------------- depreciation
/**
 * 卡片「与当期适用性相关的事实」快照（持久化到阶段证据，resume 时逐项重算比对）。
 * 只用已合入的 LOCAL-02 `assetCardPeriodStatus`（期间口径），不自算应提额；不含资产 / 企业名称等自由文本。
 */
const DEPRECIATION_CARD_FIELDS = Object.freeze([
  "assetId", "kind", "startPeriod", "acquiredPeriod", "acquiredPeriodRaw", "acquiredPeriodMissing",
  "ledgerStatus", "usefulLifeMonths", "originalCost", "residualRate", "openingAccumulated",
  "assetAccount", "accumAccount", "expenseAccount",
  "periodIndex", "depreciable", "accumulated", "remaining", "status", "dueAmount", "recordedAmount",
  "expectedAmount",
]);

function depreciationCardSnapshot(db, card, period) {
  const state = assetCardPeriodStatus(db, card, period);
  return {
    assetId: Number(card.id),
    kind: card.kind,
    startPeriod: card.start_period,
    acquiredPeriod: state.acquiredPeriod ?? null,
    acquiredPeriodRaw: card.acquired_period ?? null,
    acquiredPeriodMissing: state.acquiredPeriodMissing === true,
    ledgerStatus: state.ledgerStatus ?? null,
    usefulLifeMonths: Number(card.useful_life_months),
    originalCost: r2(Number(card.original_cost)),
    residualRate: Number(card.residual_rate),
    openingAccumulated: r2(Number(card.opening_accumulated ?? 0)),
    assetAccount: card.asset_account ?? null,
    accumAccount: card.accum_account ?? null,
    expenseAccount: card.expense_account ?? null,
    periodIndex: state.periodIndex ?? null,
    depreciable: centsToNumber(state.depreciableCents),
    accumulated: centsToNumber(state.accumulatedCents),
    remaining: centsToNumber(state.remainingCents),
    status: state.status,
    dueAmount: state.status === "due" || state.status === "posted_stale" ? centsToNumber(state.amountCents) : null,
    recordedAmount: state.amountCents === undefined ? null : centsToNumber(state.amountCents),
    expectedAmount: state.expectedCents === undefined ? null : centsToNumber(state.expectedCents),
  };
}

/**
 * 该期间**全部**已有计提记录（含本次之前已过账 / 残留草稿）及其关联凭证 / 分录指纹。
 * 旧实现只记录本次新生成的 runs（no_action 时恒为空），resume 会因此错误通过。
 */
function depreciationRunSnapshot(db, setId, period) {
  const rows = db.prepare(
    `SELECT r.id, r.asset_id, r.amount, r.voucher_id, r.period, v.status AS voucher_status
       FROM asset_depreciation_runs r LEFT JOIN vouchers v ON v.id = r.voucher_id
      WHERE r.account_set_id=? AND r.period=? ORDER BY r.asset_id`,
  ).all(setId, period);
  return rows.map((row) => {
    let entriesHash = null;
    if (row.voucher_id !== null && row.voucher_id !== undefined) {
      const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(row.voucher_id);
      if (voucher) entriesHash = voucherEvidence(voucher).entriesHash;
    }
    return {
      assetId: Number(row.asset_id), amount: r2(Number(row.amount)), voucherId: row.voucher_id ?? null,
      voucherStatus: row.voucher_status ?? null, period: row.period, entriesHash,
    };
  });
}

/** 计提 / 摊销：调用统一入口 generateDepreciation；证据必须覆盖卡片事实与当期已有 runs / 凭证。 */
export function executeDepreciationStage(ctx) {
  const { db, stage, item, lock } = ctx;
  const setId = item.account_set_id;
  if (!setId) throw domainError("account_set_unresolved", "计提阶段缺少账套");
  const period = stage.period;
  return withFencedTransaction(db, lock, () => {
    // 应提 / 不适用必须复用 LOCAL-02 的纯领域规则，不能自写「start_period <= period && remaining > 0」。
    const rawCards = db.prepare(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`).all(setId);
    // 动作前的卡片状态（用于「是否本期应提却无凭证」的判定，也是随证据保存的「当时结论」）。
    const preCardStates = rawCards.map((card) => depreciationCardSnapshot(db, card, period));
    const dueCards = preCardStates.filter((card) => card.status === "due");
    const result = A.generateDepreciation(setId, period);
    let status = STAGE_STATUS.SUCCEEDED;
    let errorCode = null;
    // 动作后的卡片事实（持久证据必须记录「本次动作完成后的真实状态」，否则 posted 会被自己误判）。
    const cardStates = rawCards.map((card) => depreciationCardSnapshot(db, card, period));
    // 该期间真实存在的全部 runs（含本次生成的），不是「本次新生成」的子集。
    const runs = depreciationRunSnapshot(db, setId, period);
    let voucherEvidenceValue = null;
    if (result.voucher) {
      if (result.voucher.status !== "posted") throw domainError("depreciation_voucher_unposted", "计提凭证不是已过账状态");
      voucherEvidenceValue = voucherEvidence(result.voucher);
      if (!runs.length) throw domainError("depreciation_run_inconsistent", "本期计提凭证没有任何计提记录");
      for (const run of runs) {
        if (run.voucherId !== result.voucher.id || run.voucherStatus !== "posted") {
          throw domainError("depreciation_run_inconsistent", "计提记录与凭证 / 状态不一致");
        }
      }
      const amount = r2(runs.reduce((sum, run) => sum + run.amount, 0));
      if (Math.abs(amount - voucherEvidenceValue.totalDebit) > EPS) {
        throw domainError("depreciation_amount_mismatch", "计提合计与凭证借方金额不一致", { runs: amount, voucherDebit: voucherEvidenceValue.totalDebit });
      }
      if (Math.abs(amount - voucherEvidenceValue.totalCredit) > EPS) {
        throw domainError("depreciation_amount_mismatch", "计提合计与凭证贷方金额不一致", { runs: amount, voucherCredit: voucherEvidenceValue.totalCredit });
      }
    } else if (dueCards.length) {
      // 核心认定本期应提但本次没有任何计提凭证：不能无条件报成功，也不能静默补提。
      status = STAGE_STATUS.NEEDS_REVIEW;
      errorCode = "depreciation_due_but_no_action";
    } else if (runs.some((run) => run.voucherStatus !== "posted")) {
      // 本期已有 run 但关联凭证不是已过账（残留草稿 / 被反过账）：不得当作「不适用」放行。
      status = STAGE_STATUS.NEEDS_REVIEW;
      errorCode = "depreciation_run_unposted";
    } else {
      // 无卡片 / 未取得 / 未到起提期 / 已提足 / 按分取整为 0 / 本期已有合法已过账计提：真实领域结论是「不适用」。
      status = STAGE_STATUS.NOT_APPLICABLE;
    }
    const evidence = {
      accountSetId: setId,
      period,
      action: result.voucher ? "generated" : "no_action",
      reason: result.voucher ? null
        : (rawCards.length === 0 ? "no_asset_cards"
          : (dueCards.length ? "due_but_no_action"
            : (runs.length ? "already_posted_this_period" : "no_card_due_this_period"))),
      cards: cardStates,
      dueCards: dueCards.map((card) => card.assetId),
      preAction: preCardStates,
      skipped: (Array.isArray(result.skipped) ? result.skipped : []).map((entry) => ({
        assetId: entry.assetId, status: entry.status ?? null,
      })),
      runs,
      voucher: voucherEvidenceValue,
      businessHash: businessDigest(db, setId, period),
    };
    const outcomeHash = sha256(canonicalJson(evidence));
    const ok = writeStageResult(db, {
      stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
      status, outcomeHash, evidence, errorCode,
    });
    if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
    if (ctx.hooks?.inDepreciationTransaction) ctx.hooks.inDepreciationTransaction({ stage, item });
    return { status, evidence };
  });
}

// ---------------------------------------------------------------- carryforward
/** 结转本期损益（yearEnd 只按 manifest 明确选择）；effect 与 checkpoint 同一事务。 */
export function executeCarryForwardStage(ctx) {
  const { db, stage, item, spec, lock } = ctx;
  const setId = item.account_set_id;
  if (!setId) throw domainError("account_set_unresolved", "结转阶段缺少账套");
  const period = stage.period;
  return withFencedTransaction(db, lock, () => {
    let result = null;
    let already = null;
    try {
      result = A.carryForwardProfit(setId, period, { yearEnd: spec.yearEnd === true });
    } catch (error) {
      if (error?.message === "already_carried_forward" || error?.code === "already_carried_forward") already = "already_carried_forward";
      else if (error?.message === "already_year_end_carried" || error?.code === "already_year_end_carried") already = "already_year_end_carried";
      else throw error;
    }
    // 无论本次生成还是已有，都必须用真实凭证 / 余额证据核验，不能只看一个布尔或异常名。
    const carryVouchers = db.prepare(
      `SELECT * FROM vouchers WHERE account_set_id=? AND period=? AND kind='carryforward' AND status='posted' ORDER BY id`,
    ).all(setId, period);
    const plCodes = new Set(A.listAccounts(setId).filter((account) => account.category === "损益").map((account) => account.code));
    const classify = (voucher) => {
      const codes = db.prepare(`SELECT code FROM voucher_entries WHERE voucher_id=?`).all(voucher.id).map((row) => row.code);
      return codes.some((code) => plCodes.has(code)) ? "profit" : "year_end";
    };
    const profitCarries = carryVouchers.filter((voucher) => classify(voucher) === "profit");
    const yearEndCarries = carryVouchers.filter((voucher) => classify(voucher) === "year_end");
    const expected = spec.yearEnd === true ? yearEndCarries : profitCarries;
    if (spec.yearEnd === true && !yearEndCarries.length) {
      const balance3103 = [...A.accountBalances(setId, period).entries()]
        .filter(([code]) => code === "3103" || code.startsWith("3103"))
        .map(([code, balance]) => ({ code, natural: balance.natural }));
      const nonzero = balance3103.filter((row) => Math.abs(row.natural) >= EPS);
      if (nonzero.length) {
        throw domainError("year_end_carry_expected", "年末结转应有凭证但库内没有已过账结转凭证");
      }
    }
    const evidence = {
      accountSetId: setId,
      period,
      yearEnd: spec.yearEnd === true,
      already: already,
      generated: result ? {
        voucherId: result.voucher?.id ?? null,
        yearEndVoucherId: result.yearEndVoucher?.id ?? null,
        revenue: result.revenue, expense: result.expense, profit: result.profit,
      } : null,
      existing: [
        ...profitCarries.map((voucher) => voucherEvidence(voucher)),
        ...yearEndCarries.map((voucher) => voucherEvidence(voucher)),
      ],
      expectedCarryCount: expected.length,
      businessHash: businessDigest(db, setId, period),
    };
    const outcomeHash = sha256(canonicalJson(evidence));
    const ok = writeStageResult(db, {
      stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
      status: STAGE_STATUS.SUCCEEDED, outcomeHash, evidence,
    });
    if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
    if (ctx.hooks?.inCarryForwardTransaction) ctx.hooks.inCarryForwardTransaction({ stage, item });
    return { status: STAGE_STATUS.SUCCEEDED, evidence };
  });
}

// ---------------------------------------------------------------- period-check
/**
 * 期末完整性检查：只使用已合入的 LOCAL-02 `A.periodEndCheck`。
 * 真实返回是 `{ accountSetId, period, ready, steps, blocking, missing, rules }`：
 * 必须按 `ready` / `steps` / `blocking` 判定，不能读不存在的 `ok` / `status` / `checks`。
 * 检查本身只读，不写业务；证据只保留步骤 id / 状态与阻断码，不落企业 / 资产自由文本。
 */
export function executePeriodCheckStage(ctx) {
  const { db, stage, item, lock } = ctx;
  const setId = item.account_set_id;
  if (!setId) throw domainError("account_set_unresolved", "期末检查阶段缺少账套");
  if (typeof A.periodEndCheck !== "function") {
    const evidence = {
      accountSetId: setId, period: stage.period,
      dependency: "LOCAL-02 A.periodEndCheck", dependencyUnavailable: true,
      note: "LOCAL-02 期末完整性检查接口不可用：本阶段不执行，也不以旧试算平衡替代期末检查",
    };
    withFencedTransaction(db, lock, () => {
      const ok = writeStageResult(db, {
        stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
        status: STAGE_STATUS.BLOCKED_DEPENDENCY, outcomeHash: sha256(canonicalJson(evidence)),
        evidence, errorCode: "dependency_unavailable",
      });
      if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
    });
    return { status: STAGE_STATUS.BLOCKED_DEPENDENCY, evidence };
  }
  return withFencedTransaction(db, lock, () => {
    const result = A.periodEndCheck(setId, stage.period);
    const steps = (Array.isArray(result?.steps) ? result.steps : []).map((step) => ({
      id: step.id, status: step.status,
    }));
    const blocking = (Array.isArray(result?.blocking) ? result.blocking : []).map((entry) => ({
      step: entry.step, code: entry.code,
    }));
    const ready = result?.ready === true && steps.length > 0 && blocking.length === 0;
    const evidence = {
      accountSetId: setId, period: stage.period, dependency: "LOCAL-02 A.periodEndCheck",
      ready, steps, blocking,
      businessHash: businessDigest(db, setId, stage.period),
    };
    const status = ready ? STAGE_STATUS.SUCCEEDED : STAGE_STATUS.NEEDS_REVIEW;
    const ok = writeStageResult(db, {
      stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
      status, outcomeHash: sha256(canonicalJson(evidence)), evidence,
      errorCode: ready ? null : "period_check_blocked",
    });
    if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
    return { status, evidence };
  });
}

// ---------------------------------------------------------------- close
/**
 * 封账：必须同一期间已有成功的期末检查；真实调用 `A.setPeriodStatus(setId, period, 'closed')`，
 * 由核心在业务变化后重新拒绝（草稿 / 不平 / 计提 / 卡片总账 / 结转 / 连续期间）。
 * 旧 check 成功只作为阶段门禁，**不代替**核心的前置校验；close 效果与 checkpoint 同一事务。
 */
export function executeCloseStage(ctx) {
  const { db, stage, item, lock } = ctx;
  const setId = item.account_set_id;
  if (!setId) throw domainError("account_set_unresolved", "封账阶段缺少账套");
  const period = stage.period;
  const check = db.prepare(
    `SELECT status, outcome_hash FROM local_batch_stages WHERE item_id=? AND period=? AND stage_key=?`,
  ).get(item.id, period, STAGE_KEYS.PERIOD_CHECK);
  if (!check || check.status !== STAGE_STATUS.SUCCEEDED) {
    const evidence = {
      accountSetId: setId, period,
      priorCheckStatus: check?.status ?? null,
      note: "未取得同期间成功的期末检查：拒绝封账（不实现更宽松的替代规则）",
    };
    withFencedTransaction(db, lock, () => {
      const ok = writeStageResult(db, {
        stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
        status: STAGE_STATUS.BLOCKED_DEPENDENCY, outcomeHash: sha256(canonicalJson(evidence)),
        evidence, errorCode: check ? "period_check_not_passed" : "dependency_unavailable",
      });
      if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
    });
    return { status: STAGE_STATUS.BLOCKED_DEPENDENCY, evidence };
  }
  return withFencedTransaction(db, lock, () => {
    // 核心会重新校验草稿 / 试算平衡 / 期末检查全部前置；旧 check 成功不能绕过它。
    const closed = A.setPeriodStatus(setId, period, "closed");
    if (closed?.status !== "closed") throw domainError("close_not_confirmed", "封账后期间状态不是 closed");
    const row = db.prepare(`SELECT status FROM periods WHERE account_set_id=? AND period=?`).get(setId, period);
    if (row?.status !== "closed") throw domainError("close_not_confirmed", "封账后期间状态不是 closed");
    const evidence = {
      accountSetId: setId, period, periodStatus: row.status,
      priorCheckOutcomeHash: check.outcome_hash ?? null,
      recheckedByCore: true,
      businessHash: businessDigest(db, setId, period),
    };
    const ok = writeStageResult(db, {
      stageId: stage.id, instance: lock.instance, token: lock.token, attempt: ctx.attempt,
      status: STAGE_STATUS.SUCCEEDED, outcomeHash: sha256(canonicalJson(evidence)), evidence,
    });
    if (!ok) throw domainError("stage_result_rejected", "阶段结果未能落库（owner / token / attempt 不匹配）");
    if (ctx.hooks?.nearCloseCommit) ctx.hooks.nearCloseCommit({ stage, item });
    return { status: STAGE_STATUS.SUCCEEDED, evidence };
  });
}

// ---------------------------------------------------------------- reports（DTO 快照）
/**
 * 在**一个只读事务**内为某 item + period 生成全部请求的 DTO / CSV，并绑定当时业务证据 hash，
 * 立即释放事务。渲染（XLSX / PDF）随后在 worker 线程完成，主线程不持有数据库写事务。
 */
export function buildReportSnapshots({ item, period, reports }) {
  return withReadSnapshot(db, () => {
    // 报表同样先核实企业与账套绑定（无 import / 无写阶段的任务也能被检出）。
    const binding = resolveItemBinding({ db, item });
    const setId = binding.accountSetId;
    if (!setId) throw domainError("account_set_unresolved", "报表面向的账套未确定");
    const businessHash = businessDigest(db, setId, period);
    const list = [];
    for (const report of reports) {
      const options = { kind: report.kind, period, format: "csv" };
      if (report.kind === "ledger") options.code = report.code;
      const built = buildReportExport(setId, options);
      const dtoJson = JSON.stringify(built.report);
      list.push({
        period,
        kind: report.kind,
        code: report.code ?? null,
        dtoHash: sha256(dtoJson),
        dtoJson,
        csvText: built.body,
        csvHash: sha256(built.body),
        businessHash,
        filename: built.filename,
        contentType: built.contentType,
      });
    }
    return { accountSetId: setId, period, businessHash, reports: list };
  });
}

export function persistSnapshot({ jobId, itemId, snapshot }) {
  saveSnapshot(db, {
    jobId, itemId, period: snapshot.period, kind: snapshot.kind,
    dtoHash: snapshot.dtoHash, businessHash: snapshot.businessHash,
    dtoJson: snapshot.dtoJson, csvText: snapshot.csvText, csvHash: snapshot.csvHash,
  });
}

/** 报表阶段：确认快照仍然对应当前业务证据（账务证据变化则旧报表过期）。 */
export function reportInputHash(snapshot, format, code) {
  return sha256(canonicalJson({
    dtoHash: snapshot.dto_hash ?? snapshot.dtoHash,
    businessHash: snapshot.business_hash ?? snapshot.businessHash,
    format, code: code ?? null,
  }));
}

/**
 * 折旧 / 摊销阶段的恢复核验：卡片集合、与当期适用性相关的事实、当期 runs、关联凭证 / 分录全部重算。
 * 任何变化都返回 { ok:false, reason }（调用方转 needs_review）；这里**不**补提、不改写业务、不把
 * 「没有新生成的 runs」当成通过依据。期间口径复用 assetCardPeriodStatus：后续期间的合法计提不会
 * 错误地让历史期间失效（历史应提额 / 累计只算到该期间）。
 */
function verifyDepreciationEvidence(evidence, stage, expectedSetId) {
  if (expectedSetId === null || expectedSetId === undefined) return { ok: false, reason: "depreciation_scope_missing" };
  const period = evidence.period ?? stage.period;
  const recordedCards = Array.isArray(evidence.cards) ? evidence.cards : null;
  const recordedRuns = Array.isArray(evidence.runs) ? evidence.runs : null;
  if (!recordedCards || !recordedRuns) return { ok: false, reason: "depreciation_evidence_incomplete" };
  const cards = db.prepare(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`).all(expectedSetId);
  const currentCards = cards.map((card) => depreciationCardSnapshot(db, card, period));
  const recordedIds = new Set(recordedCards.map((card) => Number(card.assetId)));
  const currentIds = new Set(currentCards.map((card) => Number(card.assetId)));
  if (recordedIds.size !== currentIds.size) {
    return { ok: false, reason: "depreciation_cards_changed", details: { recorded: recordedIds.size, current: currentIds.size } };
  }
  for (const assetId of currentIds) {
    if (!recordedIds.has(assetId)) return { ok: false, reason: "depreciation_cards_changed", details: { assetId } };
  }
  for (const current of currentCards) {
    const recorded = recordedCards.find((card) => Number(card.assetId) === Number(current.assetId));
    if (recorded.status !== current.status) {
      if (current.status === "due") return { ok: false, reason: "depreciation_card_became_due", details: { assetId: current.assetId } };
      if (current.status === "draft_pending") return { ok: false, reason: "depreciation_card_draft_pending", details: { assetId: current.assetId } };
      if (current.status === "posted_stale") return { ok: false, reason: "depreciation_card_posted_stale", details: { assetId: current.assetId } };
      return {
        ok: false, reason: "depreciation_card_status_changed",
        details: { assetId: current.assetId, from: recorded.status, to: current.status },
      };
    }
    for (const field of DEPRECIATION_CARD_FIELDS) {
      if (String(recorded[field] ?? "") !== String(current[field] ?? "")) {
        return { ok: false, reason: "depreciation_card_changed", details: { assetId: current.assetId, field } };
      }
    }
  }
  const currentRuns = depreciationRunSnapshot(db, expectedSetId, period);
  const recordedRunsById = new Map(recordedRuns.map((run) => [Number(run.assetId), run]));
  if (currentRuns.length !== recordedRunsById.size) {
    return {
      ok: false,
      reason: currentRuns.length > recordedRunsById.size ? "depreciation_runs_added" : "depreciation_run_removed",
      details: { recorded: recordedRunsById.size, current: currentRuns.length },
    };
  }
  for (const current of currentRuns) {
    const recorded = recordedRunsById.get(Number(current.assetId));
    if (!recorded) return { ok: false, reason: "depreciation_runs_added", details: { assetId: current.assetId } };
    if (Number(recorded.voucherId) !== Number(current.voucherId)) {
      return { ok: false, reason: "depreciation_run_changed", details: { assetId: current.assetId } };
    }
    if (current.voucherStatus !== "posted") {
      return { ok: false, reason: "depreciation_voucher_unposted", details: { assetId: current.assetId } };
    }
    if (String(recorded.amount) !== String(current.amount)) {
      return { ok: false, reason: "depreciation_amount_changed", details: { assetId: current.assetId } };
    }
    if ((recorded.entriesHash ?? null) !== (current.entriesHash ?? null)) {
      return { ok: false, reason: "depreciation_run_voucher_modified", details: { assetId: current.assetId } };
    }
  }
  if (evidence.voucher) {
    const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(evidence.voucher.voucherId);
    if (!voucher) return { ok: false, reason: "depreciation_voucher_missing" };
    if (Number(voucher.account_set_id) !== Number(expectedSetId)) return { ok: false, reason: "depreciation_voucher_changed" };
    if (voucher.status !== "posted") return { ok: false, reason: "depreciation_voucher_unposted" };
    if (voucherEvidence(voucher).entriesHash !== evidence.voucher.entriesHash) {
      return { ok: false, reason: "depreciation_voucher_modified" };
    }
  }
  return { ok: true };
}

/**
 * 恢复时重新核验已成功阶段的上游证据是否仍然成立。
 * 任何被反过账 / 改金额 / 删除 / 状态回退 / 文件损坏都会返回 ok:false（调用方转 needs_review）。
 */
export function verifyStageEvidence({ stage, item, outputDir = null }) {
  const evidence = safeParse(stage.evidence_json);
  const key = stage.stage_key;
  try {
    // 任何已成功阶段的恢复核验都先确认企业 / 账套绑定未被改到别的账套（一企一账套）。
    const evidenceSetId = evidence.accountSetId === undefined || evidence.accountSetId === null
      ? null : Number(evidence.accountSetId);
    const binding = getEnterpriseAccountSet(db, item.enterprise_key);
    const boundSetId = binding ? Number(binding.account_set_id) : null;
    // 账套作用域统一用「证据记录的账套，否则 item 已落库的账套」：
    // 省略可选 accountSetId 的任务可能没把账套写进早期证据，但绑定核验已把它落库，
    // 不能再用 null 去重算摘要（否则数据未变也会误报证据失效）。
    const expectedSetId = evidenceSetId ?? (item.account_set_id === null || item.account_set_id === undefined
      ? null : Number(item.account_set_id));
    if (expectedSetId !== null && boundSetId !== null && boundSetId !== expectedSetId) {
      return { ok: false, reason: "enterprise_binding_changed" };
    }
    if (expectedSetId !== null && boundSetId === null) {
      const setBinding = getAccountSetEnterprise(db, expectedSetId);
      if (setBinding && setBinding.enterprise_key !== item.enterprise_key) {
        return { ok: false, reason: "account_set_enterprise_changed" };
      }
      return { ok: false, reason: "enterprise_binding_missing" };
    }
    if (key.startsWith(IMPORT_STAGE_PREFIX)) {
      const batch = getImportBatch(evidence.batchId);
      if (!batch?.batch || batch.batch.status !== "completed") return { ok: false, reason: "import_batch_state_changed" };
      const bad = (batch.sourceTrace || []).filter((entry) => entry.state !== "ok");
      if (bad.length) return { ok: false, reason: "import_source_trace_changed", details: { count: bad.length } };
      for (const entry of evidence.vouchers || []) {
        const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(entry.voucherId);
        if (!voucher) return { ok: false, reason: "voucher_missing", details: { voucherId: entry.voucherId } };
        if (voucher.status !== "posted") return { ok: false, reason: "voucher_unposted", details: { voucherId: entry.voucherId } };
        if (voucherEvidence(voucher).entriesHash !== entry.entriesHash) {
          return { ok: false, reason: "voucher_modified", details: { voucherId: entry.voucherId } };
        }
      }
      return { ok: true };
    }
    if (key === STAGE_KEYS.POST) {
      for (const entry of evidence.vouchers || []) {
        const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(entry.voucherId);
        if (!voucher) return { ok: false, reason: "voucher_missing", details: { voucherId: entry.voucherId } };
        if (voucher.status !== "posted") return { ok: false, reason: "voucher_unposted", details: { voucherId: entry.voucherId } };
        if (voucherEvidence(voucher).entriesHash !== entry.entriesHash) {
          return { ok: false, reason: "voucher_modified", details: { voucherId: entry.voucherId } };
        }
      }
      return { ok: true };
    }
    if (key === STAGE_KEYS.DEPRECIATION) {
      return verifyDepreciationEvidence(evidence, stage, expectedSetId);
    }
    if (key === STAGE_KEYS.CARRYFORWARD) {
      for (const entry of evidence.existing || []) {
        const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(entry.voucherId);
        if (!voucher) return { ok: false, reason: "carryforward_voucher_missing", details: { voucherId: entry.voucherId } };
        if (voucher.status !== "posted") return { ok: false, reason: "carryforward_voucher_unposted", details: { voucherId: entry.voucherId } };
        if (voucherEvidence(voucher).entriesHash !== entry.entriesHash) {
          return { ok: false, reason: "carryforward_voucher_modified", details: { voucherId: entry.voucherId } };
        }
      }
      return { ok: true };
    }
    if (key === STAGE_KEYS.PERIOD_CHECK) {
      if (evidence.dependencyUnavailable === true) return { ok: true };
      if (typeof A.periodEndCheck !== "function" || expectedSetId === null) {
        return { ok: false, reason: "period_check_dependency_missing" };
      }
      const check = A.periodEndCheck(expectedSetId, stage.period);
      if (check?.ready === true) return { ok: true };
      const codes = (Array.isArray(check?.blocking) ? check.blocking : []).map((entry) => entry.code);
      // 合法后续效果：本任务已成功封账的**更晚**期间会让早前期间的顺序检查报 later_period_closed。
      // 这不是早前 check 失效；只有目标期间仍为 closed 且阻断全部是该合法后续效果时才继续认成功。
      if (codes.length && codes.every((code) => code === "later_period_closed")) {
        const target = db.prepare(`SELECT status FROM periods WHERE account_set_id=? AND period=?`)
          .get(expectedSetId, stage.period);
        if (target?.status === "closed") return { ok: true };
      }
      return { ok: false, reason: "period_check_regressed", details: { counting: codes.length, codes: codes.slice(0, 8) } };
    }
    if (key === STAGE_KEYS.CLOSE) {
      const row = db.prepare(`SELECT status FROM periods WHERE account_set_id=? AND period=?`)
        .get(expectedSetId, evidence.period);
      if (row?.status !== "closed") return { ok: false, reason: "period_reopened" };
      return { ok: true };
    }
    if (key.startsWith(`${STAGE_KEYS.REPORT}:`)) {
      const snapshot = getSnapshot(db, { itemId: item.id, period: stage.period, kind: evidence.kind });
      if (!snapshot) return { ok: false, reason: "report_snapshot_missing" };
      if (snapshot.business_hash !== evidence.businessHash) return { ok: false, reason: "report_evidence_changed" };
      if (businessDigest(db, expectedSetId, stage.period) !== snapshot.business_hash) {
        return { ok: false, reason: "report_evidence_changed" };
      }
      // 产物文件核验：丢失 / 被改必须标失效（只重做报表，不重做会计）。
      const artifact = db.prepare(
        `SELECT * FROM local_batch_artifacts WHERE item_id=? AND period=? AND stage_key=? ORDER BY id DESC LIMIT 1`,
      ).get(item.id, stage.period, stage.stage_key);
      if (!artifact) return { ok: false, reason: "artifact_missing" };
      if (artifact.status !== "published") return { ok: false, reason: "artifact_not_published" };
      if (artifact.bytes_hash !== evidence.bytesHash) return { ok: false, reason: "artifact_record_changed" };
      if (!outputDir) return { ok: true };
      const absolute = resolve(outputDir, artifact.relative_path);
      const root = resolve(outputDir);
      if (absolute !== root && !absolute.startsWith(root + sep)) return { ok: false, reason: "artifact_path_escape" };
      if (!existsSync(absolute)) return { ok: false, reason: "artifact_file_missing" };
      if (sha256(readFileSync(absolute)) !== artifact.bytes_hash) return { ok: false, reason: "artifact_file_corrupted" };
      return { ok: true };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: sanitizeError(error).code };
  }
}

function safeParse(text) {
  try { return JSON.parse(text || "{}") ?? {}; } catch { return {}; }
}

/** 统一执行入口（runner 只按 stageKey 派发，没有任意代码入口）。 */
export function executeStage(ctx) {
  const key = ctx.stage.stage_key;
  try {
    // 任何阶段（含无 import 的过账 / 计提 / 结转 / 检查 / 结账）开始前统一核实企业↔账套绑定，
    // 抛错发生在任何写操作之前，且异常码会被 runner 归到 needs_review（失败隔离、其它企业继续）。
    const binding = resolveItemBinding({ db: ctx.db, item: ctx.item, stage: ctx.stage });
    const scoped = binding.accountSetId !== null && binding.accountSetId !== ctx.item.account_set_id
      ? { ...ctx, item: { ...ctx.item, account_set_id: binding.accountSetId } }
      : ctx;
    if (key.startsWith(IMPORT_STAGE_PREFIX)) return executeImportStage(scoped);
    if (key === STAGE_KEYS.POST) return executePostStage(scoped);
    if (key === STAGE_KEYS.DEPRECIATION) return executeDepreciationStage(scoped);
    if (key === STAGE_KEYS.CARRYFORWARD) return executeCarryForwardStage(scoped);
    if (key === STAGE_KEYS.PERIOD_CHECK) return executePeriodCheckStage(scoped);
    if (key === STAGE_KEYS.CLOSE) return executeCloseStage(scoped);
    throw domainError("stage_key_unsupported", "阶段类型不在固定白名单内", { stageKey: key });
  } catch (error) {
    if (error?.code) throw error;
    const sanitized = sanitizeError(error);
    throw domainError(sanitized.code, sanitized.message);
  }
}

export { businessDigest as __businessDigest };
