// import-incremental.mjs — 增量导入（首次建账 / 已有账套追加）领域逻辑。
//
// 与旧 `importAccountSet` 的分工：
//   - `importAccountSet(payload, { dryRun })`（accounting.mjs）保持原样：无来源身份、总是新建账套，
//     旧调用方（HTTP /api/import/account-set、Agent legacy_book_import、MCP legacy_book_import）
//     行为与返回结构完全不变。
//   - 本文件新增「有来源 / 企业 / 批次身份」的导入：
//       * mode=create：首次建账，把规范企业身份绑定到新账套；
//       * mode=append：向**已绑定同一企业身份**的既有账套追加期间 / 凭证，不重建账套。
//
// 产品身份口径（2026-10-22 用户澄清）：**一家企业只需要一个账套**；多企业批量处理 = 多个账套。
// 企业身份来自调用方显式、稳定的 canonical `source.enterpriseKey`（如统一社会信用代码），
// 绝不用可改的账套显示名称猜认；同一 enterpriseKey 即使来自另一个 source.system，
// 也必须引导到已有账套（只新增来源证据），不得新建第二本；同一账套不得再绑定另一家企业。
//
// 幂等与冲突语义（全部落在同一事务内，预检只读）：
//   1. 批次：批次 ID 由调用方提供；同批重试（内容指纹一致）直接回放，不新增账套 / 凭证；
//      同一批次 ID 但内容指纹或身份变化 → 结构化冲突，绝不静默覆盖。
//   2. 来源凭证：以 (来源系统, 企业身份, 来源凭证 ID) 为跨批唯一键；
//      内容指纹一致 → 去重跳过；指纹不同 → `source_voucher_content_changed` 冲突。
//      去重 / 回放前还要核验当前本机凭证仍存在、仍属该账套、仍为 posted、内容未被修改，
//      不一致就给结构化冲突，绝不按来源指纹伪报完成。
//       * 跨批去重命中的来源凭证也按本批次留痕（import_batch_vouchers），
//         但只存关联，不伪造第二张来源 / 凭证。
//   3. 业务凭证字号 (期间 + 字号 + 凭证号) 与既有 / 本批其他凭证冲突 → 结构化冲突。
//   4. 自动取号的凭证在**计划阶段就统一预分配**号码（跳过本批显式号与既有号），
//      保证预检所见即正式写入结果，同期间同字号不会出现两张同号凭证。
//   5. 身份不匹配、科目不兼容、已封账期间、期初覆盖 → 结构化冲突。
//
// 严格校验不降低：金额 / 日期 / 科目 / 借贷规则一律复用 accounting.mjs 的
// `normalizeImportPayload`；本文件只做「增量语义」层面的补充校验。
//
// 持久化见 import-storage.mjs（表 / 迁移 / 备份）；完整审计见后续 LOCAL06。

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { db } from "./db.mjs";
import { runDomainOperation,readDomainOperationBinding } from "./local-audit-coordinator.mjs";
import { withAuditSavepoint,hasActiveAuditExecution,deferIncrementalImportFailure } from "./local-audit-storage.mjs";
import { auditCanonicalDigest,auditResultSnapshot,auditError } from "./local-audit.mjs";
import { parseAuxiliaryAppendix, processAuxiliaryAppendix } from "./auxiliary-import.mjs";
import { assertAuxiliaryConnection, auxTransaction } from "./auxiliary-storage.mjs";
import * as A from "./accounting.mjs";
import { canonicalEnterpriseKey, normalizeEnterpriseIdentity, requireSameEnterpriseIdentity } from "./enterprise-identity.mjs";
import { resolveNewAccountingProfile } from "./accounting-profiles.mjs";
import {
  getAccountSetEnterprise, getBatch, getEnterpriseAccountSet, getSourceBinding, getVoucherSource,
  insertBatchVoucher, insertEnterpriseAccountSet, insertSourceBinding, insertVoucherSource,
  listBatchVouchers, listSourceBindingsForEnterprise, markBatchCompleted, markBatchFailed,
  persistedVoucherFingerprint, voucherFingerprint,
} from "./import-storage.mjs";

export { voucherFingerprint } from "./import-storage.mjs";

export const MODE_CREATE = "create";
export const MODE_APPEND = "append";

/** 结果状态：preview（预检通过） / applied（已落库） / idempotent_replay / rejected / conflict。 */
export const STATUS = Object.freeze({
  PREVIEW: "preview",
  APPLIED: "applied",
  REPLAY: "idempotent_replay",
  REJECTED: "rejected",
  CONFLICT: "conflict",
});

/** 已登记来源凭证的当前本机状态（去重 / 回放核验结果）。 */
const VOUCHER_STATE = Object.freeze({
  OK: "ok",
  MISSING: "missing",
  UNPOSTED: "unposted",
  MODIFIED: "modified",
  OTHER_ACCOUNT_SET: "other_account_set",
  UNVERIFIED: "unverified",
});

/** 显式来源凭证 ID 的保留前缀：内部推导 ID 使用 `derived:`，避免两种来源混淆。 */
const DERIVED_PREFIX = "derived:";
/** 字号分组键分隔符：期间与字号都可能含普通分隔符，用 NUL 避免拼接歧义。 */
const NUMBER_GROUP_SEP = "\u0000";
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (v) => {
  if (v === undefined || v === null || v === "") return "(空)";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return "[对象]"; } }
  return String(v);
};
const normKey = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_\u3000]/g, "");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** 文本字段：undefined/null → ""；string → trim；有限 number → 十进制文本；其他类型 → null（非法）。 */
function textField(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

/**
 * 规范企业身份：只做 Unicode NFKC + trim，不做大小写 / 名称猜测。
 * 调用方必须提供稳定规范形式（例如统一社会信用代码大写）；服务端不会把显示名称当成身份。
 */
// ---------------------------------------------------------------- 批次内容指纹
/**
 * 批次内容指纹（导出供迁移 / 兼容回归构造真实旧批次）；不改变指纹字段与排序规则。
 * 只包含确定性业务字段；profile 不参与指纹（同一 payload 在迁移前后可原样重放）。
 */
export function batchFingerprint({ mode, targetAccountSetId, source, meta, normalized, vouchers }) {
  return sha256(JSON.stringify({
    mode,
    targetAccountSetId: mode === MODE_APPEND ? targetAccountSetId : null,
    source: { system: source.system, enterpriseKey: source.enterpriseKey },
    meta: {
      name: meta.name ?? "",
      taxpayer_type: meta.taxpayer_type ?? "",
      accounting_standard: meta.accounting_standard ?? "",
      start_period: meta.start_period ?? "",
    },
    accounts: normalized.accounts
      .map((a) => [String(a.code), a.name ?? "", a.category ?? "", a.direction ?? ""])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
    opening_balances: normalized.opening_balances
      .map((o) => [String(o.code), r2(o.debit), r2(o.credit)])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
    vouchers: vouchers
      .map((v) => ({ sourceVoucherId: v.sourceVoucherId, fingerprint: v.fingerprint }))
      .sort((x, y) => (x.sourceVoucherId < y.sourceVoucherId ? -1 : x.sourceVoucherId > y.sourceVoucherId ? 1 : 0)),
  }));
}

// ---------------------------------------------------------------- 结果构造
function baseResult(request) {
  return {
    dryRun: request.dryRun,
    mode: request.mode,
    batchId: request.batchId || null,
    source: request.source ?? null,
    accountSetId: null,
    status: STATUS.REJECTED,
    ok: false,
    validation: null,
    conflicts: [],
    errors: [],
    notes: [],
    planned: null,
    created: null,
    batch: null,
    replayed: false,
    sourceTrace: [],
  };
}

const conflict = (code, message, extra = {}) => ({ code, message, ...extra });

function rejected(request, errors, extra = {}) {
  return {
    ...baseResult(request),
    ...extra,
    status: STATUS.REJECTED,
    ok: false,
    errors,
    conflicts: extra.conflicts ?? [],
  };
}

function conflicted(request, conflicts, extra = {}) {
  return {
    ...baseResult(request),
    ...extra,
    status: STATUS.CONFLICT,
    ok: false,
    errors: extra.errors ?? [],
    conflicts,
  };
}

// ---------------------------------------------------------------- 请求解析
function parseSource(raw) {
  const errors = [];
  if (raw === undefined || raw === null) {
    return { errors: ["缺少来源身份 source（需要 { system, enterpriseKey, enterpriseName? }）"], value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: [`来源身份 source 格式非法（应为对象）：${fmt(raw)}`], value: null };
  }
  const system = textField(raw.system ?? raw.sourceSystem ?? raw.source_system);
  const enterpriseKey = canonicalEnterpriseKey(raw.enterpriseKey ?? raw.enterprise_key);
  const enterpriseName = textField(raw.enterpriseName ?? raw.enterprise_name ?? "");
  if (system === null) errors.push(`来源系统 source.system 类型非法：${fmt(raw.system)}`);
  else if (!system) errors.push("缺少来源系统 source.system（例如本机旧账来源标识）");
  else if (system.length > 64) errors.push("来源系统 source.system 过长（上限 64 字符）");
  else if (CONTROL_CHARS_RE.test(system)) errors.push("来源系统 source.system 含控制字符");
  if (enterpriseKey === null) errors.push(`企业身份 source.enterpriseKey 类型非法：${fmt(raw.enterpriseKey)}`);
  else if (!enterpriseKey) errors.push("缺少稳定企业身份 source.enterpriseKey（不得用可改的账套名称代替）");
  else if (enterpriseKey.length > 128) errors.push("企业身份 source.enterpriseKey 过长（上限 128 字符）");
  else if (CONTROL_CHARS_RE.test(enterpriseKey)) errors.push("企业身份 source.enterpriseKey 含控制字符");
  if (enterpriseName === null) errors.push(`企业名称 source.enterpriseName 类型非法：${fmt(raw.enterpriseName)}`);
  else if (enterpriseName.length > 200) errors.push("企业名称 source.enterpriseName 过长（上限 200 字符）");
  return { errors, value: { system, enterpriseKey, enterpriseName } };
}

/**
 * 核验「已登记的来源凭证」与当前本机凭证是否仍一致。
 * 只读：预检与正式导入都调用同一逻辑，不写任何表。
 */
function registeredVoucherState(row) {
  const voucher = db.prepare(`SELECT * FROM vouchers WHERE id=?`).get(row.voucher_id);
  if (!voucher) return { state: VOUCHER_STATE.MISSING, voucherId: row.voucher_id };
  if (voucher.account_set_id !== row.account_set_id) {
    return {
      state: VOUCHER_STATE.OTHER_ACCOUNT_SET,
      voucherId: row.voucher_id,
      registeredAccountSetId: row.account_set_id,
      currentAccountSetId: voucher.account_set_id,
    };
  }
  if (voucher.status !== "posted") {
    return { state: VOUCHER_STATE.UNPOSTED, voucherId: row.voucher_id, voucherStatus: voucher.status };
  }
  if (!row.voucher_fingerprint) {
    // 历史登记（v1 候选库）在凭证已被删除时无法回填指纹：明确要求人工核对，不按来源指纹伪报完成。
    return { state: VOUCHER_STATE.UNVERIFIED, voucherId: row.voucher_id };
  }
  const entries = db
    .prepare(`SELECT code, summary, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`)
    .all(voucher.id);
  if (persistedVoucherFingerprint(voucher, entries) !== row.voucher_fingerprint) {
    return { state: VOUCHER_STATE.MODIFIED, voucherId: row.voucher_id };
  }
  return { state: VOUCHER_STATE.OK, voucherId: row.voucher_id };
}

function registeredStateConflict(label, sourceVoucherId, row, current) {
  const base = {
    sourceVoucherId,
    registeredVoucherId: row.voucher_id,
    registeredBatchId: row.batch_id,
    voucherState: current.state,
  };
  switch (current.state) {
    case VOUCHER_STATE.MISSING:
      return conflict("source_voucher_voucher_missing",
        `${label}来源登记存在，但对应本机凭证 #${row.voucher_id} 已不存在（可能被删除）：不静默重新入账，请人工核对来源关联`,
        base);
    case VOUCHER_STATE.UNPOSTED:
      return conflict("source_voucher_voucher_unposted",
        `${label}对应本机凭证 #${row.voucher_id} 当前状态为 ${current.voucherStatus}（非 posted）：去重 / 回放不视为完成`,
        { ...base, voucherStatus: current.voucherStatus });
    case VOUCHER_STATE.MODIFIED:
      return conflict("source_voucher_voucher_modified",
        `${label}对应本机凭证 #${row.voucher_id} 的内容已与本机导入登记不一致：拒绝按来源指纹伪报完成`,
        base);
    case VOUCHER_STATE.OTHER_ACCOUNT_SET:
      return conflict("source_voucher_account_set_mismatch",
        `${label}对应本机凭证 #${row.voucher_id} 的账套与登记不一致（登记 ${current.registeredAccountSetId} / 当前 ${current.currentAccountSetId}）`,
        { ...base, registeredAccountSetId: current.registeredAccountSetId, currentAccountSetId: current.currentAccountSetId });
    default:
      return conflict("source_voucher_trace_unverified",
        `${label}来源登记缺少可核验的落库指纹：要求人工核对，不按来源指纹伪报完成`,
        base);
  }
}

/**
 * 增量导入主入口。**默认 dryRun=true（只预检，不写入任何表）**，与既有导入入口约定一致。
 *
 * options:
 *   payload      必填：{ account_set, accounts, opening_balances, vouchers }
 *   batchId      必填：调用方稳定批次 ID
 *   source       必填：{ system, enterpriseKey, enterpriseName? }
 *   mode         create | append（给了 accountSetId 时缺省 append）
 *   accountSetId append 目标账套
 *   confirmNewBinding  append 时为本来源新增「来源证据」绑定（必须与既有企业身份一致）
 *   dryRun       缺省 true
 */
const AUXILIARY_IMPORT_ERRORS = new Set(["aux_import_busy","aux_import_failed","account_set_not_found","accounting_profile_unknown","aux_allocation_exceeds_entry","aux_allocation_invalid","aux_allocations_invalid","aux_amount_invalid","aux_code_invalid","aux_commit_unknown","aux_connection_quarantined","aux_dimension_invalid","aux_dimension_required","aux_entry_not_found","aux_id_invalid","aux_import_actual_entry_required","aux_import_allocation_exists","aux_import_entity_conflict","aux_import_entry_identity_required","aux_import_explicit_identity_required","aux_import_identity_duplicate","aux_import_invalid","aux_import_mapping_conflict","aux_import_receipt_invalid","aux_import_ref_invalid","aux_import_replay_state_conflict","aux_import_request_conflict","aux_import_source_conflict","aux_import_transaction_required","aux_import_version_invalid","aux_kind_invalid","aux_name_invalid","aux_not_installed","aux_opening_code_required","aux_opening_not_found","aux_period_closed","aux_reason_required","aux_replay_state_conflict","aux_request_conflict","aux_request_id_required","aux_side_invalid","aux_structure_invalid","aux_target_invalid","aux_tuple_duplicate","later_period_closed","later_year_end_carryforward_depends_on_period"]);
function auxiliaryImportError(error) {
  const code = AUXILIARY_IMPORT_ERRORS.has(error?.code) ? error.code
    : error?.errcode === 5 || error?.errcode === 6 ? "aux_import_busy" : "aux_import_failed";
  return Object.assign(new Error(code), { code });
}
function importIncrementalBody(options = {}) {
  try { return runIncrementalImport(options); }
  catch (error) { if (options?.auxiliaryAppendix !== undefined) throw auxiliaryImportError(error); throw error; }
}
const ADMITTED=Symbol('import-admitted');
function runIncrementalImport(options = {}, {admissionOnly=false}={}) {
  const args = options ?? {};
  assertAuxiliaryConnection(db);
  const appendix = parseAuxiliaryAppendix(args.auxiliaryAppendix);
  const request = {
    dryRun: args.dryRun !== false,
    mode: null,
    batchId: "",
    source: null,
  };

  // ---------- 1. 参数形状 ----------
  const argErrors = [];
  const rawBatchId = args.batchId ?? args.batch_id;
  const batchId = textField(rawBatchId);
  if (batchId === null) argErrors.push(`批次标识 batchId 类型非法：${fmt(rawBatchId)}`);
  else if (!batchId) argErrors.push("缺少批次标识 batchId（调用方提供的稳定批次 ID，用于重启后幂等）");
  else if (batchId.length > 128) argErrors.push("批次标识 batchId 过长（上限 128 字符）");
  else if (!BATCH_ID_RE.test(batchId)) argErrors.push(`批次标识 batchId 含非法字符：${batchId}`);
  request.batchId = batchId || "";

  const source = parseSource(args.source);
  let identityFailure = null;
  try { requireSameEnterpriseIdentity(normalizeEnterpriseIdentity(args.source), args.enterprise); }
  catch (e) { identityFailure = e.code; }
  argErrors.push(...source.errors, ...(identityFailure ? [identityFailure] : []));
  request.source = source.value;

  let targetAccountSetId = null;
  const rawAccountSetId = args.accountSetId ?? args.account_set_id;
  if (rawAccountSetId !== undefined && rawAccountSetId !== null && rawAccountSetId !== "") {
    const n = Number(rawAccountSetId);
    if (!Number.isInteger(n) || n <= 0) argErrors.push(`accountSetId 必须是正整数，收到：${fmt(rawAccountSetId)}`);
    else targetAccountSetId = n;
  }
  const rawMode = typeof args.mode === "string" ? args.mode.trim() : "";
  const mode = rawMode || (targetAccountSetId ? MODE_APPEND : MODE_CREATE);
  request.mode = mode;
  if (![MODE_CREATE, MODE_APPEND].includes(mode)) {
    argErrors.push(`mode 只能是 ${MODE_CREATE} / ${MODE_APPEND}，收到：${fmt(args.mode)}`);
  } else if (mode === MODE_APPEND && !targetAccountSetId) {
    argErrors.push("追加模式（append）必须显式提供 accountSetId（不猜选账套）");
  } else if (mode === MODE_CREATE && targetAccountSetId) {
    argErrors.push("首次建账模式（create）不得提供 accountSetId；向已有账套追加请显式 mode=append");
  }
  const confirmNewBinding = args.confirmNewBinding === true || args.confirm_new_binding === true;

  const payload = args.payload;
  if (payload === undefined || payload === null) {
    argErrors.push("缺少导入数据 payload（{ account_set, accounts, opening_balances, vouchers }）");
  }

  // ---------- 2. 最小目标读取：append 目标 / 已完成 create 批次的目标账套 ----------
  // 严格 normalize 必须在定位目标之后：口径要用目标**实际** profile 与科目表，
  // 否则旧 create 批次重放可能被新企业模板提前拒绝（例如企业模板下 5001 不是收入）。
  const batchRecord = getBatch(db, batchId);
  let targetSet = null;
  let targetContext = null;
  let creationProfile = null;
  const targetErrors = [];
  if (mode === MODE_APPEND && targetAccountSetId) {
    try {
      targetSet = A.getAccountSet(targetAccountSetId);
    } catch (e) {
      if (e?.code === "accounting_profile_unknown") {
        targetErrors.push(`${e.code}: 目标账套持久会计 profile 未知或已损坏`);
      } else {
        const err = new Error("account_set_not_found");
        err.code = "account_set_not_found";
        err.details = { accountSetId: targetAccountSetId };
        throw err;
      }
    }
    if (targetSet) {
      targetContext = { profileId: targetSet.accounting_profile_id, accounts: A.listAccounts(targetAccountSetId) };
      request.accountSetId = targetAccountSetId;
    }
  } else if (mode === MODE_CREATE) {
    request.accountSetId = null;
    if (batchRecord && batchRecord.status === "completed" && batchRecord.mode === MODE_CREATE
      && batchRecord.account_set_id != null) {
      try {
        targetSet = A.getAccountSet(batchRecord.account_set_id);
        targetContext = { profileId: targetSet.accounting_profile_id, accounts: A.listAccounts(targetSet.id) };
      } catch (e) {
        if (e?.code === "accounting_profile_unknown") {
          targetErrors.push(`${e.code}: 已完成批次的目标账套持久会计 profile 未知或已损坏`);
        } else {
          targetErrors.push(`batch_replay_state_incomplete: 已完成批次的目标账套无法读取（${e?.message || "account_set_not_found"}）`);
        }
      }
    }
  }
  if (targetErrors.length) {
    const validation = { ok: false, errors: targetErrors, warnings: [], summary: null, profile: null, profileError: null };
    return rejected(request, targetErrors, { validation });
  }

  // 新 create（无目标）：按 payload 准则选择合法新 profile；payload 不能提供内部上下文。
  if (mode === MODE_CREATE && !targetContext) {
    const rawMeta = payload && typeof payload === "object" && !Array.isArray(payload)
      && payload.account_set && typeof payload.account_set === "object" && !Array.isArray(payload.account_set)
      ? payload.account_set : {};
    const rawStandard = rawMeta.accounting_standard;
    const requestedProfileId = args.profileId !== undefined ? args.profileId : args.profile_id;
    try {
      if (rawStandard !== undefined && rawStandard !== null && typeof rawStandard !== "string") {
        throw Object.assign(new Error("accounting_standard_invalid"), { code: "accounting_standard_invalid" });
      }
      if (typeof rawStandard === "string" && rawStandard !== "" && rawStandard !== rawStandard.trim()) {
        throw Object.assign(new Error("accounting_standard_invalid"), { code: "accounting_standard_invalid" });
      }
      // Explicit invalid aliases must never be treated as an omitted default.
      for (const raw of [args.profileId, args.profile_id]) {
        if (raw !== undefined && (typeof raw !== "string" || raw.trim() === "")) {
          throw Object.assign(new Error("accounting_profile_unknown"), { code: "accounting_profile_unknown" });
        }
      }
      if (args.profileId !== undefined && args.profile_id !== undefined && args.profileId !== args.profile_id) {
        throw Object.assign(new Error("accounting_profile_unknown"), { code: "accounting_profile_unknown" });
      }
      creationProfile = resolveNewAccountingProfile({
        ...(typeof rawStandard === "string" && rawStandard.trim() ? { accounting_standard: rawStandard } : {}),
        ...(requestedProfileId !== undefined ? { profileId: requestedProfileId } : {}),
      });
    } catch (e) {
      const code = e?.code || "accounting_standard_invalid";
      const message = e?.message || "会计准则不受支持";
      const errors = [`${code}: ${message}`];
      const validation = {
        ok: false, errors, warnings: [], summary: null,
        profile: null, profileError: { code, message },
      };
      return rejected(request, errors, { validation });
    }
    targetContext = { profileId: creationProfile.id, accounts: creationProfile.coa };
  }

  // ---------- 3. 严格归一化（与旧导入同一套约束，不降低任何规则） ----------
  const strict = payload === undefined || payload === null
    ? null
    : A.normalizeImportPayload(payload, targetContext || undefined);
  const validation = strict
    ? {
      ok: strict.ok, errors: strict.errors, warnings: strict.warnings, summary: strict.summary,
      profile: strict.profile, profileError: strict.profileError,
    }
    : { ok: false, errors: [], warnings: [], summary: null, profile: null, profileError: null };

  if (argErrors.length || !strict) {
    validation.ok = false;
    validation.identityError = identityFailure ? { code: identityFailure } : null;
    return rejected(request, [...argErrors, ...(strict ? strict.errors : [])], { validation });
  }
  const normalized = strict.normalized;
  const meta = normalized.account_set;
  if (!strict.ok) {
    // 严格校验失败：预检与正式都一样拒绝，且不写任何表。
    return rejected(request, strict.errors, { validation });
  }

  const identityConflicts = [];
  const notes = [];
  const enterpriseKey = source.value.enterpriseKey;
  const canonical = getEnterpriseAccountSet(db, enterpriseKey);
  const canonicalForSet = mode === MODE_APPEND ? getAccountSetEnterprise(db, targetAccountSetId) : null;
  const sourceBinding = getSourceBinding(db, source.value.system, enterpriseKey);
  let bindingToCreate = false;
  let canonicalToCreate = false;

  if (mode === MODE_CREATE) {
    // 首次建账：规范企业身份已存在账套时绝不新建第二本，而是明确引导到已有账套。
    // 唯一例外是「已完成批次的同批重试」——其绑定账套正是该批次创建的账套，允许回放。
    if (canonical) {
      const replaySetId = batchRecord && batchRecord.status === "completed" && batchRecord.mode === MODE_CREATE
        ? batchRecord.account_set_id : null;
      if (replaySetId === null || replaySetId !== canonical.account_set_id) {
        const sources = listSourceBindingsForEnterprise(db, enterpriseKey).map((b) => b.source_system);
        identityConflicts.push(conflict(
          "enterprise_already_bound",
          `该企业身份已绑定本机账套 #${canonical.account_set_id}`
          + `（已登记来源：${sources.length ? sources.join("、") : "未登记"}）：一家企业只有一个账套，不得重复建账；`
          + `请改用 mode=append 且显式 accountSetId=${canonical.account_set_id}`,
          {
            accountSetId: canonical.account_set_id,
            boundSources: sources,
            requestedSource: source.value.system,
            guidance: "mode=append",
          },
        ));
      }
    } else {
      bindingToCreate = true;
      canonicalToCreate = true;
    }
  } else {
    // 追加：目标账套必须已属同一家规范企业（可来自其它来源，但身份必须一致）。
    if (canonical) {
      if (canonical.account_set_id !== targetAccountSetId) {
        identityConflicts.push(conflict(
          "enterprise_bound_to_other_account_set",
          "该企业身份已绑定其他账套：一家企业只有一个账套，请改用该账套追加",
          {
            accountSetId: targetAccountSetId,
            boundAccountSetId: canonical.account_set_id,
            guidance: "mode=append + accountSetId=已有账套",
          },
        ));
      } else if (sourceBinding) {
        // 该来源此前已登记同一企业：直接使用，无需再次确认。
      } else if (!confirmNewBinding) {
        identityConflicts.push(conflict(
          "account_set_binding_confirmation_required",
          "该账套已属此企业身份，但当前来源尚未登记来源证据；确认后请显式传 confirmNewBinding=true（绑定不得改变企业身份）",
          { accountSetId: targetAccountSetId, enterpriseKey, sourceSystem: source.value.system },
        ));
      } else {
        bindingToCreate = true;
      }
    } else if (canonicalForSet) {
      identityConflicts.push(conflict(
        "account_set_bound_to_other_enterprise",
        "该账套已绑定其他企业身份：一个账套只能属于一家企业，不能写入本企业",
        { accountSetId: targetAccountSetId, boundEnterpriseKey: canonicalForSet.enterprise_key },
      ));
    } else if (!confirmNewBinding) {
      identityConflicts.push(conflict(
        "account_set_binding_confirmation_required",
        "该账套尚未绑定企业身份；确认后请显式传 confirmNewBinding=true 完成一次可核验的绑定",
        { accountSetId: targetAccountSetId, enterpriseKey },
      ));
    } else {
      bindingToCreate = true;
      canonicalToCreate = true;
    }
  }

  // ---------- 4. 账套信息兼容性（append） ----------
  if (mode === MODE_APPEND) {
    if (meta.start_period && meta.start_period !== targetSet.start_period) {
      identityConflicts.push(conflict(
        "account_set_start_period_mismatch",
        "启用期间与目标账套不一致：追加不得改变账套启用期间",
        { accountSetId: targetSet.id, existing: targetSet.start_period, incoming: meta.start_period },
      ));
    }
    if (meta.accounting_standard && meta.accounting_standard !== targetSet.accounting_standard) {
      identityConflicts.push(conflict(
        "accounting_standard_mismatch",
        "会计准则与目标账套不一致",
        { accountSetId: targetSet.id, existing: targetSet.accounting_standard, incoming: meta.accounting_standard },
      ));
    }
    if (meta.name && normKey(meta.name) !== normKey(targetSet.name)) {
      notes.push("payload 中的账套名称与目标账套不同：名称不是身份，已忽略（不做重命名）");
    }
    if (meta.taxpayer_type && meta.taxpayer_type !== targetSet.taxpayer_type) {
      notes.push("payload 中的纳税人性质与目标账套不同：已忽略（追加不改账套属性）");
    }
  }

  // ---------- 5. 科目兼容性 ----------
  // create / append / create 重放统一以目标实际 profile 的科目表为基准（targetContext.accounts：
  // append / 重放为账套真实科目，新建为所选新 profile 的科目表）。
  const existingAccounts = new Map(
    (targetContext?.accounts ?? []).map((a) => [String(a.code), a]),
  );
  const accountConflicts = [];
  const accountsToAdd = [];
  for (const a of normalized.accounts) {
    const code = String(a.code);
    const current = existingAccounts.get(code);
    if (!current) {
      accountsToAdd.push(a);
      continue;
    }
    if (a.category && a.category !== current.category) {
      accountConflicts.push(conflict("account_incompatible", `科目 ${code} 类别与账套既有科目不一致`, {
        accountCode: code, field: "category", existing: current.category, incoming: a.category,
      }));
    }
    if (a.direction && a.direction !== current.direction) {
      accountConflicts.push(conflict("account_incompatible", `科目 ${code} 方向与账套既有科目不一致`, {
        accountCode: code, field: "direction", existing: current.direction, incoming: a.direction,
      }));
    }
    if (a.name && a.name !== current.name) {
      notes.push(`科目 ${code} 名称与账套既有科目不同：保留既有名称（不重命名）`);
    }
  }

  // ---------- 6. 逐张来源凭证：稳定 ID / 指纹 / 去重 / 状态核验 / 冲突 ----------
  const expectedSetId = mode === MODE_APPEND ? targetAccountSetId : (batchRecord?.account_set_id ?? null);
  const rawVouchers = Array.isArray(payload.vouchers) ? payload.vouchers : [];
  const planErrors = [];
  const voucherConflicts = [];
  if (normalized.vouchers.length && rawVouchers.length !== normalized.vouchers.length) {
    planErrors.push("无法对齐来源凭证 ID：payload.vouchers 结构非法（每张凭证必须是对象）");
  }
  const vouchers = [];
  const seenSourceIds = new Map();
  const fingerprintBySid = new Map();
  const seenNumbers = new Map();
  const startPeriodForCheck = mode === MODE_APPEND
    ? targetSet.start_period
    : (targetSet?.start_period ?? meta.start_period);

  normalized.vouchers.forEach((v, i) => {
    if (planErrors.length) return;
    const raw = rawVouchers[i] ?? {};
    const explicit = textField(raw.sourceVoucherId ?? raw.source_voucher_id);
    let sourceVoucherId = "";
    if (explicit === null) {
      planErrors.push(`凭证第 ${i + 1} 张来源凭证 ID（sourceVoucherId）类型非法：${fmt(raw.sourceVoucherId ?? raw.source_voucher_id)}`);
      return;
    }
    if (explicit) {
      if (explicit.startsWith(DERIVED_PREFIX)) {
        planErrors.push(`凭证第 ${i + 1} 张来源凭证 ID 不得使用保留前缀 ${DERIVED_PREFIX}`);
        return;
      }
      if (explicit.length > 128) {
        planErrors.push(`凭证第 ${i + 1} 张来源凭证 ID 过长（上限 128 字符）`);
        return;
      }
      sourceVoucherId = explicit;
    } else if (typeof v.number === "number" && v.number > 0) {
      // 无显式 ID 时按业务凭证字号推导稳定身份（同字号内容修订 → 同 ID → 冲突而非新增）。
      sourceVoucherId = `${DERIVED_PREFIX}${v.period}/${v.word}/${v.number}`;
    } else {
      planErrors.push(`凭证第 ${i + 1} 张缺少 sourceVoucherId（无凭证号时无法推导稳定来源身份）`);
      return;
    }
    if (startPeriodForCheck && v.period && v.period < startPeriodForCheck) {
      planErrors.push(`凭证第 ${i + 1} 张期间 ${v.period} 早于账套启用期间 ${startPeriodForCheck}`);
      return;
    }

    const fingerprint = voucherFingerprint(v);
    fingerprintBySid.set(sourceVoucherId, fingerprint);
    const label = `凭证第 ${i + 1} 张（${v.period} ${v.word}-${v.number ?? "自动"}）`;
    if (seenSourceIds.has(sourceVoucherId)) {
      voucherConflicts.push(conflict("source_voucher_duplicate_in_batch",
        `${label}来源凭证 ID 在本批次内重复：${sourceVoucherId}`,
        { sourceVoucherId, firstIndex: seenSourceIds.get(sourceVoucherId), index: i }));
      return;
    }
    seenSourceIds.set(sourceVoucherId, i);
    if (typeof v.number === "number") {
      const numKey = `${v.period}|${v.word}|${v.number}`;
      if (seenNumbers.has(numKey)) {
        voucherConflicts.push(conflict("voucher_number_duplicate_in_batch",
          `${label}业务凭证字号在本批次内重复：${v.word}-${v.number}`,
          { period: v.period, word: v.word, number: v.number, firstIndex: seenNumbers.get(numKey), index: i }));
        return;
      }
      seenNumbers.set(numKey, i);
    }

    const existingSource = getVoucherSource(db, source.value.system, enterpriseKey, sourceVoucherId);
    if (existingSource) {
      if (expectedSetId === null || existingSource.account_set_id !== expectedSetId) {
        voucherConflicts.push(conflict("source_voucher_account_set_mismatch",
          `${label}来源凭证已登记在其它账套，拒绝写入本账套`,
          { sourceVoucherId, registeredAccountSetId: existingSource.account_set_id, targetAccountSetId: expectedSetId }));
        return;
      }
      if (existingSource.content_fingerprint !== fingerprint) {
        voucherConflicts.push(conflict("source_voucher_content_changed",
          `${label}同一来源凭证内容已修订：拒绝静默覆盖，请作为新凭证或先人工核对`,
          { sourceVoucherId, registeredFingerprint: existingSource.content_fingerprint, incomingFingerprint: fingerprint }));
        return;
      }
      // 来源指纹一致还不够：核验当前本机凭证仍存在 / 仍 posted / 内容未改。
      const current = registeredVoucherState(existingSource);
      if (current.state !== VOUCHER_STATE.OK) {
        voucherConflicts.push(registeredStateConflict(label, sourceVoucherId, existingSource, current));
        return;
      }
      vouchers.push({
        index: i, sourceVoucherId, fingerprint, action: "dedupe",
        voucherId: existingSource.voucher_id, voucherAccountSetId: existingSource.account_set_id, voucher: v,
      });
      return;
    }

    // 新建前的业务凭证字号冲突（既有账套中已被别的凭证占用）。
    if (mode === MODE_APPEND && typeof v.number === "number") {
      const dup = db.prepare(
        `SELECT id, period, word, number FROM vouchers
          WHERE account_set_id=? AND period=? AND word=? AND number=?`,
      ).get(targetAccountSetId, v.period, v.word, v.number);
      if (dup) {
        voucherConflicts.push(conflict("voucher_number_conflict",
          `${label}业务凭证字号已被既有凭证占用（voucher #${dup.id}）：拒绝覆盖`,
          { period: v.period, word: v.word, number: v.number, existingVoucherId: dup.id }));
        return;
      }
    }

    // 已封账期间不得新增凭证（去重命中的凭证不写入，因此不在此拒绝）。
    if (mode === MODE_APPEND && A.periodStatus(targetAccountSetId, v.period) === "closed") {
      voucherConflicts.push(conflict("period_closed",
        `${label}期间 ${v.period} 已封账：不得新增凭证`,
        { period: v.period, sourceVoucherId }));
      return;
    }

    vouchers.push({ index: i, sourceVoucherId, fingerprint, action: "create", voucherId: null, voucher: v });
  });

  // ---------- 7.1 自动取号统一预分配（预检所见 = 正式写入） ----------
  // 同一批里「显式编号」与「自动取号」混用时，若各自独立取号，正式写入可能落出两张同字号凭证
  // （自动取号取到本批显式号）。这里在计划阶段按 (期间, 字号) 分组统一预分配：
  //   起点 = max(既有账套该组最大号, 0) + 1，并跳过本批所有显式号与已分配号。
  // 因此反序 / 多个自动号 / 不同字或期间 / 已存在号都能得到确定性结果，且预检就能看到最终号码。
  const numberingGroups = new Map();
  if (!planErrors.length) {
    for (const item of vouchers) {
      const v = item.voucher;
      const key = `${v.period || ""}${NUMBER_GROUP_SEP}${v.word || "记"}`;
      let group = numberingGroups.get(key);
      if (!group) {
        group = { period: v.period, word: v.word || "记", explicit: new Set(), autos: [], next: 1 };
        numberingGroups.set(key, group);
      }
      if (typeof v.number === "number") group.explicit.add(v.number);
      else if (item.action === "create") group.autos.push(item);
    }
    for (const group of numberingGroups.values()) {
      if (!group.autos.length) continue;
      const existingMax = mode === MODE_APPEND
        ? Number(db.prepare(
          `SELECT COALESCE(MAX(number),0) AS n FROM vouchers WHERE account_set_id=? AND period=? AND word=?`,
        ).get(targetAccountSetId, group.period, group.word)?.n || 0)
        : 0;
      group.next = Math.max(existingMax, 0) + 1;
      for (const item of group.autos) {
        while (group.explicit.has(group.next)) group.next += 1;
        item.assignedNumber = group.next;
        group.next += 1;
      }
    }
  }
  /** 该凭证计划写入的业务凭证号（显式号原样保留；自动取号用预分配值）。 */
  const plannedNumber = (item) => (typeof item.voucher.number === "number"
    ? item.voucher.number
    : (item.assignedNumber ?? null));

  // ---------- 8. 批次记录：同批重试 / 内容变化 / 回放状态 ----------
  const fingerprint = batchFingerprint({
    mode, targetAccountSetId, source: source.value, meta, normalized,
    vouchers: [...seenSourceIds.keys()].map((sid) => ({ sourceVoucherId: sid, fingerprint: fingerprintBySid.get(sid) })),
  });
  let replayIntent = false;
  const batchConflicts = [];
  if (batchRecord) {
    if (batchRecord.source_system !== source.value.system || batchRecord.enterprise_key !== enterpriseKey) {
      batchConflicts.push(conflict("batch_identity_mismatch",
        "批次 ID 已用于其它来源 / 企业身份：拒绝复用",
        { batchId, registeredSource: batchRecord.source_system, registeredEnterpriseKey: batchRecord.enterprise_key }));
    } else if (batchRecord.mode !== mode) {
      batchConflicts.push(conflict("batch_mode_mismatch",
        "批次 ID 已用于其它导入模式（create / append）", { batchId, registeredMode: batchRecord.mode }));
    } else if (mode === MODE_APPEND && batchRecord.account_set_id && batchRecord.account_set_id !== targetAccountSetId) {
      batchConflicts.push(conflict("batch_account_set_mismatch",
        "批次 ID 已用于其它账套", { batchId, registeredAccountSetId: batchRecord.account_set_id, targetAccountSetId }));
    } else if (batchRecord.content_fingerprint !== fingerprint) {
      batchConflicts.push(conflict("batch_content_changed",
        "同一批次 ID 的导入内容已变化：拒绝静默覆盖，请使用新的 batchId",
        { batchId, registeredFingerprint: batchRecord.content_fingerprint, incomingFingerprint: fingerprint }));
    } else if (batchRecord.status === "completed") {
      if (batchRecord.account_set_id == null || !sourceBinding || getAccountSetEnterprise(db, batchRecord.account_set_id)?.enterprise_key !== enterpriseKey) {
        batchConflicts.push(conflict("batch_replay_state_incomplete",
          "批次已标记完成，但账套的企业身份绑定缺失：库内状态与批次记录不一致，已拒绝写入",
          { batchId, accountSetId: batchRecord.account_set_id, reason: "binding_missing" }));
      } else if (vouchers.some((v) => v.action === "create")) {
        batchConflicts.push(conflict("batch_replay_state_incomplete",
          "批次已标记完成，但存在未登记的来源凭证：库内状态与批次记录不一致，已拒绝写入",
          { batchId }));
      } else {
        const links = listBatchVouchers(db, batchId);
        const expected = new Map(vouchers.map(v => [v.sourceVoucherId, v]));
        const valid = links.length === expected.size && links.every(l => {
          const v = expected.get(l.source_voucher_id);
          return v && l.source_system === source.value.system && l.enterprise_key === enterpriseKey
            && l.account_set_id === batchRecord.account_set_id && l.voucher_id === v.voucherId
            && l.content_fingerprint === v.fingerprint;
        });
        if (!valid) batchConflicts.push(conflict("batch_replay_state_incomplete", "批次来源关联不完整", { batchId }));
        else replayIntent = true;
      }
    }
  }

  // ---------- 9. 期初保护 / 回放一致性（create / append） ----------
  // 期初保护要去掉「本批次自己写入的期初」这层误报：同批身份 / 内容 / 落库状态一致时只读回放，
  // 但**不豁免**真正的期初覆盖或内容变化——回放前必须核验库内实际期初与本批请求完全一致。
  // create 与 append 同理：create 的账套 ID 来自批次记录（首次正式执行仍会新建账套，不受既有期初限制）。
  // 没有期初的批次不进入本段：不能凭空要求从未导入过的字段快照。
  const openingConflicts = [];
  if (normalized.opening_balances.length) {
    if (replayIntent) {
      // 批次内容指纹已核对一致，因此 normalized.opening_balances 就是该批当初导入的期初。
      const replaySetId = mode === MODE_APPEND ? targetAccountSetId : batchRecord.account_set_id;
      let currentRows = null;
      if (replaySetId != null) {
        try { currentRows = A.getOpeningBalances(replaySetId); } catch { currentRows = null; }
      }
      if (currentRows === null) {
        openingConflicts.push(conflict("batch_replay_state_incomplete",
          "批次已标记完成，但无法读取其账套的期初：库内状态与批次记录不一致，拒绝只读回放",
          { batchId, accountSetId: replaySetId, reason: "account_set_missing" }));
      } else {
        const current = new Map(
          currentRows.map((o) => [String(o.code), { debit: r2(o.debit), credit: r2(o.credit) }]),
        );
        const mismatched = [];
        for (const o of normalized.opening_balances) {
          const code = String(o.code);
          const cur = current.get(code);
          if (!cur || cur.debit !== r2(o.debit) || cur.credit !== r2(o.credit)) {
            mismatched.push({
              code,
              expectedDebit: r2(o.debit), expectedCredit: r2(o.credit),
              currentDebit: cur ? cur.debit : null, currentCredit: cur ? cur.credit : null,
            });
          }
        }
        const unexpectedCodes = [...current.keys()]
          .filter((code) => !normalized.opening_balances.some((o) => String(o.code) === code));
        if (mismatched.length || unexpectedCodes.length) {
          openingConflicts.push(conflict("batch_replay_state_incomplete",
            "批次已标记完成，但账套的实际期初余额与本批请求不一致：库内状态与批次记录不一致，拒绝只读回放",
            { batchId, accountSetId: replaySetId, reason: "opening_balances_mismatch", mismatched, unexpectedCodes }));
        }
      }
    } else if (mode === MODE_APPEND) {
      const existingOpenings = A.getOpeningBalances(targetAccountSetId).length;
      const posted = db
        .prepare(`SELECT COUNT(*) AS n FROM vouchers WHERE account_set_id=? AND status='posted'`)
        .get(targetAccountSetId).n;
      const closed = db
        .prepare(`SELECT COUNT(*) AS n FROM periods WHERE account_set_id=? AND status='closed'`)
        .get(targetAccountSetId).n;
      if (existingOpenings > 0) {
        openingConflicts.push(conflict("opening_balance_overwrite_refused",
          "目标账套已有期初余额：增量导入不得覆盖既有期初", { accountSetId: targetAccountSetId }));
      } else if (posted > 0) {
        openingConflicts.push(conflict("opening_rewrite_after_posting",
          "目标账套已有已过账凭证：不得再写入期初", { accountSetId: targetAccountSetId, posted }));
      } else if (closed > 0) {
        openingConflicts.push(conflict("opening_rewrite_period_closed",
          "目标账套已有封账期间：不得再写入期初", { accountSetId: targetAccountSetId, closed }));
      }
    }
  }

  const allConflicts = [
    ...identityConflicts, ...accountConflicts, ...openingConflicts, ...voucherConflicts, ...batchConflicts,
  ];
  if (planErrors.length) return rejected(request, planErrors, { validation, conflicts: allConflicts });
  if (allConflicts.length) {
    return conflicted(request, allConflicts, { validation, notes, accountSetId: mode === MODE_APPEND ? targetAccountSetId : null });
  }

  const planned = {
    accountSetCreated: mode === MODE_CREATE,
    accountSetId: mode === MODE_APPEND ? targetAccountSetId : null,
    bindingAction: mode === MODE_CREATE ? "create" : bindingToCreate ? "append_confirm" : "existing",
    accountsToAdd: accountsToAdd.map((a) => String(a.code)),
    openingBalances: normalized.opening_balances.length,
    vouchersToCreate: vouchers.filter((v) => v.action === "create").map((v) => v.sourceVoucherId),
    vouchersDeduplicated: vouchers.filter((v) => v.action === "dedupe").map((v) => v.sourceVoucherId),
    // 预检就公布最终业务凭证号：自动取号在计划阶段已预分配，预览与正式写入一致。
    voucherNumbers: vouchers.map((v) => ({
      sourceVoucherId: v.sourceVoucherId, period: v.voucher.period, word: v.voucher.word,
      action: v.action === "create" ? "create" : "dedupe",
      number: v.action === "create" ? plannedNumber(v) : (typeof v.voucher.number === "number" ? v.voucher.number : null),
      autoNumbered: v.action === "create" && typeof v.voucher.number !== "number",
    })),
  };

  const appendixContext = (accountSetId, createdVoucherIds = new Set()) => ({
    accountSetId, source: source.value, batchId, coreFingerprint: fingerprint,
    payload, normalized, vouchers, createdVoucherIds,
  });
  const appendixSetId = mode === MODE_APPEND ? targetAccountSetId : batchRecord?.status === "completed" ? batchRecord.account_set_id : null;
  if (appendix) processAuxiliaryAppendix(db, appendix, appendixContext(appendixSetId));

  // ---------- 10. 幂等回放：已完成批次的重试不写入任何东西 ----------
  if (replayIntent) {
    const stored = safeJson(batchRecord.result_json);
    // 逐张关联持久在 import_batch_vouchers：回放与查询看到的是同一份数据（含去重命中项），
    // 不会因「本批没新建凭证」而丢掉批次追踪。
    const links = batchLinks(batchRecord);
    const trace = links.map((link) => linkTraceItem(link));
    const brokenIndex = trace.findIndex((t) => t.state !== VOUCHER_STATE.OK);
    if (brokenIndex >= 0) {
      const link = links[brokenIndex];
      const registered = getVoucherSource(db, link.source_system, link.enterprise_key, link.source_voucher_id);
      return conflicted(request, [
        registered
          ? registeredStateConflict("", link.source_voucher_id, registered, registeredVoucherState(registered))
          : conflict("source_voucher_trace_unverified",
            `来源凭证 ${link.source_voucher_id} 的登记缺失：库内状态与批次记录不一致，拒绝只读回放`,
            { sourceVoucherId: link.source_voucher_id, batchId }),
      ], { validation, notes });
    }
    const replayResult = {
      ...baseResult(request),
      accountSetId: batchRecord.account_set_id,
      status: STATUS.REPLAY,
      ok: true,
      validation,
      notes: [...notes, "同一批次 ID 与相同内容的重试：回放既有结果，未新增账套 / 凭证"],
      planned: null,
      replayed: true,
      batch: batchSummary(batchRecord),
      created: {
        accountSetId: batchRecord.account_set_id,
        accountSetCreated: false,
        accountsAdded: 0,
        openingBalancesApplied: 0,
        vouchersCreated: 0,
        vouchersDeduplicated: vouchers.length,
        previouslyCreated: Number(stored.vouchersCreated ?? links.filter((l) => l.action === "created").length),
      },
      sourceTrace: trace,
    };
    if(admissionOnly)return {marker:ADMITTED,mode,targetAccountSetId};
    if (appendix) {
      if (request.dryRun) return { ...replayResult, auxiliary: processAuxiliaryAppendix(db, appendix, appendixContext(batchRecord.account_set_id)) };
      const auxiliary = auxTransaction(db, () => {
        const currentBatch = getBatch(db, batchId);
        if (!currentBatch || currentBatch.status !== "completed" || currentBatch.content_fingerprint !== fingerprint
          || currentBatch.account_set_id !== batchRecord.account_set_id
          || currentBatch.source_system !== source.value.system || currentBatch.enterprise_key !== enterpriseKey) {
          throw Object.assign(new Error("aux_import_source_conflict"), { code: "aux_import_source_conflict" });
        }
        for (const item of vouchers) {
          const registered = getVoucherSource(db, source.value.system, enterpriseKey, item.sourceVoucherId);
          if (!registered || registered.content_fingerprint !== item.fingerprint
            || registered.account_set_id !== batchRecord.account_set_id
            || registeredVoucherState(registered).state !== VOUCHER_STATE.OK) {
            throw Object.assign(new Error("aux_import_source_conflict"), { code: "aux_import_source_conflict" });
          }
        }
        return processAuxiliaryAppendix(db, appendix, appendixContext(batchRecord.account_set_id), { apply: true });
      });
      return { ...replayResult, ...(auxiliary.durability === "pending_outer_commit" && auxiliary.status === "staged" ? { status: "staged" } : {}), auxiliary: { ...auxiliary, status: auxiliary.status === "staged" && auxiliary.durability === "committed" ? "applied" : auxiliary.status }, durability: auxiliary.durability };
    }
    return replayResult;
  }

  if(admissionOnly)return {marker:ADMITTED,mode,targetAccountSetId};

  // ---------- 11. 预检（不写入） ----------
  if (request.dryRun) {
    return {
      ...baseResult(request),
      accountSetId: mode === MODE_APPEND ? targetAccountSetId : null,
      status: STATUS.PREVIEW,
      ok: true,
      validation,
      notes: [...notes, "dryRun 预检：未写入任何表（含企业绑定 / 来源证据 / 批次 / 凭证）"],
      planned,
      ...(appendix ? { auxiliary: processAuxiliaryAppendix(db, appendix, appendixContext(appendixSetId)) } : {}),
      batch: batchRecord ? batchSummary(batchRecord) : null,
      sourceTrace: vouchers.map((v) => ({
        sourceVoucherId: v.sourceVoucherId,
        voucherId: v.voucherId,
        contentFingerprint: v.fingerprint,
        status: v.action === "create" ? "would_create" : "deduplicated",
        state: VOUCHER_STATE.OK,
        action: v.action,
        voucherNumber: v.action === "create" ? plannedNumber(v) : (typeof v.voucher.number === "number" ? v.voucher.number : null),
      })),
      created: null,
    };
  }

  // ---------- 12. 正式落库：单事务覆盖企业绑定 / 来源证据 / 批次 / 凭证 / 期间 / 科目 ----------
  const outcome = {
    accountSetId: mode === MODE_APPEND ? targetAccountSetId : null,
    accountSetCreated: false,
    accountsAdded: 0,
    openingBalancesApplied: 0,
    vouchersCreated: 0,
    vouchersDeduplicated: vouchers.filter((v) => v.action === "dedupe").length,
    sourceTrace: [],
  };
  const createdVoucherIds = new Set();
  const writeCore = () => {
    // Existing source state is rechecked under the write reservation.
    if (appendix) processAuxiliaryAppendix(db, appendix, appendixContext(appendixSetId));
    for (const item of vouchers) if (item.action === "dedupe") {
      const registered = getVoucherSource(db, source.value.system, enterpriseKey, item.sourceVoucherId);
      if (!registered || registered.content_fingerprint !== item.fingerprint || registered.account_set_id !== item.voucherAccountSetId || registeredVoucherState(registered).state !== VOUCHER_STATE.OK) {
        throw Object.assign(new Error("aux_import_source_conflict"), { code: "aux_import_source_conflict" });
      }
    }
    let accountSetId = targetAccountSetId;
    if (mode === MODE_CREATE) {
      const set = A.createAccountSet({
        enterprise: source.value,
        name: meta.name,
        taxpayer_type: meta.taxpayer_type || "小规模纳税人",
        accounting_standard: meta.accounting_standard || undefined,
        start_period: meta.start_period,
        ...(creationProfile ? { profileId: creationProfile.id } : {}),
      });
      accountSetId = set.id;
      outcome.accountSetId = set.id;
      outcome.accountSetCreated = true;
      insertSourceBinding(db, {
        sourceSystem: source.value.system,
        enterpriseKey,
        enterpriseName: source.value.enterpriseName,
        boundBy: "import",
      });
    } else if (bindingToCreate) {
      if (canonicalToCreate) {
        insertEnterpriseAccountSet(db, {
          enterpriseKey,
          enterpriseName: source.value.enterpriseName,
          accountSetId,
          boundBy: "append_confirm",
        });
      }
      insertSourceBinding(db, {
        sourceSystem: source.value.system,
        enterpriseKey,
        enterpriseName: source.value.enterpriseName,
        boundBy: "append_confirm",
      });
    }

    const have = new Set(A.listAccounts(accountSetId).map((a) => String(a.code)));
    for (const a of accountsToAdd) {
      const code = String(a.code);
      if (have.has(code)) continue;
      A.addAccount(accountSetId, { code, name: a.name, category: a.category, direction: a.direction });
      have.add(code);
      outcome.accountsAdded += 1;
    }

    if (normalized.opening_balances.length) {
      A.setOpeningBalances(accountSetId, normalized.opening_balances);
      outcome.openingBalancesApplied = normalized.opening_balances.length;
    }

    for (const item of vouchers) {
      if (item.action === "dedupe") {
        // 去重命中也要按「本批次」留痕：指向既有来源凭证 / 既有凭证，不伪造第二张。
        insertBatchVoucher(db, {
          batchId,
          sourceSystem: source.value.system,
          enterpriseKey,
          sourceVoucherId: item.sourceVoucherId,
          accountSetId: item.voucherAccountSetId,
          voucherId: item.voucherId,
          contentFingerprint: item.fingerprint,
          action: "deduplicated",
        });
        outcome.sourceTrace.push({
          sourceVoucherId: item.sourceVoucherId,
          voucherId: item.voucherId,
          accountSetId: item.voucherAccountSetId,
          contentFingerprint: item.fingerprint,
          action: "deduplicated",
          status: "deduplicated",
          state: VOUCHER_STATE.OK,
        });
        continue;
      }
      const v = item.voucher;
      const number = plannedNumber(item);
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
        // 计划阶段已预分配；这里只做防御：绝不静默退化成自动取号。
        throw Object.assign(new Error("voucher_number_unplanned"), {
          code: "voucher_number_unplanned",
          details: { sourceVoucherId: item.sourceVoucherId },
        });
      }
      // 事务内再核一次本账套该期间 / 字号 / 号码是否已被占用（防止预检后又被其它写入占用）。
      const clash = db.prepare(
        `SELECT id FROM vouchers WHERE account_set_id=? AND period=? AND word=? AND number=?`,
      ).get(accountSetId, v.period, v.word || "记", number);
      if (clash) {
        throw Object.assign(new Error("voucher_number_conflict"), {
          code: "voucher_number_conflict",
          details: {
            period: v.period, word: v.word || "记", number,
            sourceVoucherId: item.sourceVoucherId, existingVoucherId: clash.id,
          },
        });
      }
      const created = A.createVoucher(accountSetId, {
        period: v.period,
        voucher_date: v.date || `${v.period}-01`,
        word: v.word,
        number,
        summary: v.summary,
        kind: "normal",
        status: "posted",
        entries: v.entries,
      });
      insertVoucherSource(db, {
        sourceSystem: source.value.system,
        enterpriseKey,
        sourceVoucherId: item.sourceVoucherId,
        accountSetId,
        voucherId: created.id,
        contentFingerprint: item.fingerprint,
        voucherFingerprint: persistedVoucherFingerprint(created, created.entries),
        batchId,
      });
      insertBatchVoucher(db, {
        batchId,
        sourceSystem: source.value.system,
        enterpriseKey,
        sourceVoucherId: item.sourceVoucherId,
        accountSetId,
        voucherId: created.id,
        contentFingerprint: item.fingerprint,
        action: "created",
      });
      createdVoucherIds.add(item.sourceVoucherId);
      outcome.vouchersCreated += 1;
      outcome.sourceTrace.push({
        sourceVoucherId: item.sourceVoucherId,
        voucherId: created.id,
        accountSetId,
        contentFingerprint: item.fingerprint,
        action: "created",
        status: "created",
        state: VOUCHER_STATE.OK,
      });
    }

    if (appendix) outcome.auxiliary = processAuxiliaryAppendix(db, appendix, appendixContext(accountSetId, createdVoucherIds), { apply: true });

    markBatchCompleted(db, {
      batchId,
      sourceSystem: source.value.system,
      enterpriseKey,
      mode,
      accountSetId,
      contentFingerprint: fingerprint,
      result: {
        accountSetCreated: outcome.accountSetCreated,
        accountsAdded: outcome.accountsAdded,
        openingBalancesApplied: outcome.openingBalancesApplied,
        vouchersCreated: outcome.vouchersCreated,
        vouchersDeduplicated: outcome.vouchersDeduplicated,
      },
    });
  };
  let durability;
  try {
    if (appendix) {
      const result = auxTransaction(db, () => { writeCore(); return { status: "applied" }; });
      durability = result.durability;
      outcome.auxiliary = { ...outcome.auxiliary, status: outcome.auxiliary.status === "staged" && durability === "committed" ? "applied" : outcome.auxiliary.status, durability };
    } else {
      withAuditSavepoint(db,writeCore);
    }
  } catch (e) {
    // Caller/aux unknown transactions never authorize failure metadata. A live private
    // audit outer owns final rollback; its fixed queue is consumed only after proof.
    if (appendix && (e?.code === "aux_commit_unknown" || e?.code === "aux_connection_quarantined" || (db.isTransaction&&!hasActiveAuditExecution(db)))) throw e;
    if (appendix) e = auxiliaryImportError(e);
    // 已完成的批次永远不能被失败审计覆写；只有未完成的批次才写失败记录。
    const completed = (() => {
      try { return getBatch(db, batchId)?.status === "completed"; } catch { return false; }
    })();
    if(!completed&&hasActiveAuditExecution(db))deferIncrementalImportFailure(db,e,{batchId,sourceSystem:source.value.system,enterpriseKey,mode,accountSetId:mode===MODE_APPEND?targetAccountSetId:null,contentFingerprint:fingerprint,errorCode:e?.code||e?.message||'import_failed',errorMessage:e?.message||String(e)});
    if (!completed && !hasActiveAuditExecution(db)) {
      try {
        // 失败批次只写审计（不含业务状态），随后仍然抛出原始错误，绝不吞错当成功。
        markBatchFailed(db, {
          batchId,
          sourceSystem: source.value.system,
          enterpriseKey,
          mode,
          accountSetId: mode === MODE_APPEND ? targetAccountSetId : null,
          contentFingerprint: fingerprint,
          errorCode: e?.code || e?.message || "import_failed",
          errorMessage: e?.message || String(e),
        });
      } catch { /* 审计写入失败不覆盖原始错误 */ }
    }
    throw e;
  }

  return {
    ...baseResult(request),
    accountSetId: outcome.accountSetId,
    status: durability === "pending_outer_commit" ? "staged" : STATUS.APPLIED,
    ...(appendix ? { durability, auxiliary: outcome.auxiliary } : {}),
    ok: true,
    validation,
    notes,
    planned,
    created: outcome,
    batch: {
      id: batchId,
      status: "completed",
      mode,
      accountSetId: outcome.accountSetId,
      contentFingerprint: fingerprint,
    },
    sourceTrace: outcome.sourceTrace,
  };
}

function safeJson(text) {
  try { return JSON.parse(text || "{}") ?? {}; } catch { return {}; }
}

function batchSummary(record) {
  if (!record) return null;
  return {
    id: record.batch_id,
    status: record.status,
    mode: record.mode,
    accountSetId: record.account_set_id,
    contentFingerprint: record.content_fingerprint,
    attempts: record.attempts,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    errorCode: record.error_code ?? null,
    result: safeJson(record.result_json),
  };
}

/** 只读：某批次的逐张关联（并校对批次自身的来源 / 企业范围，防跨作用域串数据）。 */
function batchLinks(record) {
  return listBatchVouchers(db, record.batch_id).filter(
    (l) => l.source_system === record.source_system && l.enterprise_key === record.enterprise_key,
  );
}

/**
 * 只读：把一条「批次→来源凭证」关联映射为追踪项。
 * 始终指向既有来源凭证 / 既有凭证（去重命中项也如此），status 保留首次处理的 created / deduplicated 含义，
 * state 是**当前**凭证核验结果；非 ok 时 status 记为 inconsistent。
 */
function linkTraceItem(link) {
  const registered = getVoucherSource(db, link.source_system, link.enterprise_key, link.source_voucher_id);
  const current = registered ? registeredVoucherState(registered) : { state: VOUCHER_STATE.UNVERIFIED };
  return {
    sourceVoucherId: link.source_voucher_id,
    voucherId: link.voucher_id,
    accountSetId: link.account_set_id,
    contentFingerprint: link.content_fingerprint,
    action: link.action,
    status: current.state === VOUCHER_STATE.OK
      ? (link.action === "deduplicated" ? "deduplicated" : "created")
      : "inconsistent",
    state: current.state,
  };
}

/** 只读：查询批次结果与逐张来源追踪（审计入口，预检 / 正式都不改数据）。 */
export function getImportBatch(batchId) {
  const id = textField(batchId);
  if (!id) throw Object.assign(new Error("batchId_required"), { code: "batchId_required" });
  const record = getBatch(db, id);
  if (!record) throw Object.assign(new Error("batch_not_found"), { code: "batch_not_found" });
  const links = batchLinks(record);
  return {
    batch: batchSummary(record),
    source: { system: record.source_system, enterpriseKey: record.enterprise_key },
    sourceTrace: links.map((link) => linkTraceItem(link)),
    voucherCount: links.length,
  };
}

/** 只读：批次 / 企业绑定 / 来源证据的当前状态（来源追踪用）。 */
export function importBatchState() {
  return {
    batches: db.prepare(`SELECT batch_id, status, attempts, updated_at FROM import_batches ORDER BY updated_at DESC`).all(),
    enterpriseAccountSets: db
      .prepare(`SELECT enterprise_key, enterprise_name, account_set_id, bound_by FROM import_enterprise_account_sets ORDER BY enterprise_key`)
      .all(),
    sourceBindings: db
      .prepare(`SELECT source_system, enterprise_key, bound_by FROM import_source_bindings ORDER BY id`)
      .all(),
  };
}

export function importIncremental(options={}) {
 if(options&&typeof options==='object'&&!nodeTypes.isProxy(options)&&!Array.isArray(options)&&[Object.prototype,null].includes(Object.getPrototypeOf(options))){const appendix=Object.getOwnPropertyDescriptor(options,'auxiliaryAppendix');if(appendix&&Object.hasOwn(appendix,'value')&&appendix.value!==undefined)parseAuxiliaryAppendix(appendix.value);}
 auditResultSnapshot(options);
 if(options.dryRun!==false)return importIncrementalBody(options);
 const prior=readDomainOperationBinding(db);
 if(prior&&!['import.create','import.append'].includes(prior.action))throw auditError('audit_operation_conflict');
 let admitted;try{admitted=prior?{marker:ADMITTED,mode:prior.action==='import.append'?'append':'create',targetAccountSetId:prior.scope.value}:runIncrementalImport(options,{admissionOnly:true});}catch(error){if(options?.auxiliaryAppendix!==undefined)throw auxiliaryImportError(error);throw error;}
 if(admitted?.marker!==ADMITTED)return admitted;
 const {mode,targetAccountSetId}=admitted;
 const scope=prior?.scope??(mode==='append'?{kind:'account_set',value:targetAccountSetId}:{kind:'database',value:null});
 return runDomainOperation(db,{action:prior?.action??(mode==='append'?'import.append':'import.create'),scope,request:options,
 refs:v=>[...(v?.created?.accountSetId?[{type:'account_set',id:v.created.accountSetId}]:[]),...(typeof options.batchId==='string'?[{type:'import_batch_key',keyDigest:auditCanonicalDigest([options.batchId])}]:[])],
 targets:v=>v?.created?.accountSetId?{accountSetId:v.created.accountSetId}:{}},()=>importIncrementalBody(options));
}
