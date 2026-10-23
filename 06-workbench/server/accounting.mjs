// accounting.mjs — 复式记账领域逻辑 + 报表
//
// 金额规则（LOCAL-02）：所有金额以「整数分」计算（money.mjs），落库 / 出参统一两位小数；
// 舍入唯一 ROUND_HALF_UP；合计在分上累加后再转换，禁止把两位小数用浮点求和。
import { db } from "./db.mjs";
import {
  getAccountingProfile,
  resolveNewAccountingProfile,
} from "./accounting-profiles.mjs";
import {
  classifyAccountingCashCounterpart,
  evaluateAccountingStatement,
  getAccountingReportRules,
  resolveAccountingAccountRule,
} from "./accounting-report-rules.mjs";
import {
  MAX_ABSOLUTE_CENTS,
  MAX_SCHEDULE_PERIODS,
  MONEY_MAX_CENTS,
  MONEY_MAX_TEXT,
  centsToNumber,
  formatCents,
  mulCentsByRatio,
  mulDivCents,
  parseMoney,
  storedCents,
  sumCents,
} from "./money.mjs";
import {
  accountProfileSemantics,
  assetCardPeriodStatus,
  assertAssetCardWriteAllowed,
  assertPeriodCloseable,
  assertPeriodMutable,
  buildPeriodEndCheck,
  cardMoney,
  carryForwardSemanticsConflicts,
  expectedDepreciationCents,
  postedEntryRows,
  sumNaturalByPrefix,
} from "./period-end-controls.mjs";

import { normalizeEnterpriseIdentity, identityError } from "./enterprise-identity.mjs";
import { getEnterpriseAccountSet, getAccountSetEnterprise, insertEnterpriseAccountSet } from "./import-storage.mjs";

const now = () => new Date().toISOString();
const EPS = 0.005;

const row = (sql, ...args) => db.prepare(sql).get(...args);
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

// 期间校验：YYYY-MM 且月份 01-12；createAccountSet/ensurePeriod/createVoucher 共用。
const PERIOD_RE = /^(\d{4})-(\d{2})$/;
function parsePeriod(period) {
  const m = PERIOD_RE.exec(String(period ?? ""));
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}`;
}
function requirePeriod(period, code = "period_invalid") {
  const p = parsePeriod(period);
  if (!p) throw new Error(code);
  return p;
}

// 嵌套安全的事务保存点：可在外层 BEGIN 内使用，失败时回滚到保存点。
let savepointSeq = 0;
function withSavepoint(fn) {
  const sp = `sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* ignore */ }
    throw e;
  }
}

// ---------------------------------------------------------------- 会计 profile
/**
 * 结构化 profile 错误：只用受控字段，不回显未知原始输入 / SQL / 堆栈 / 路径。
 * 错误码与阶段 A 一致：accounting_profile_unknown / accounting_standard_invalid /
 * accounting_profile_standard_mismatch / accounting_profile_legacy_not_creatable。
 */
function profileError(code, message, details = null) {
  const err = new Error(message || code);
  err.code = code;
  if (details) err.details = details;
  return err;
}

/** 账套原始行（不解析 profile，供内部与只读恢复核对使用）。 */
function accountSetRow(id) {
  return row(`SELECT * FROM account_sets WHERE id=?`, id);
}

/**
 * 解析账套的持久 profile。未知 / 损坏 profile **不 fallback 到新小企**：
 * 正常业务得到结构化 accounting_profile_unknown；只读恢复核对仍可直接读原始行 / 备份。
 */
export function accountSetProfile(setId) {
  const set = accountSetRow(setId);
  if (!set) throw new Error("account_set_not_found");
  const profileId = set.accounting_profile_id;
  let profile;
  try {
    profile = getAccountingProfile(profileId);
  } catch (e) {
    throw profileError("accounting_profile_unknown", "账套持久会计 profile 未知或已损坏", {
      field: "accounting_profile_id",
      reason: e?.code === "accounting_profile_unknown" ? "profile-not-registered" : "profile-unreadable",
    });
  }
  const context = {
    declaredStandard: set.accounting_standard ?? null,
    profileId: profile.id,
    coaVersion: profile.coaVersion,
    reportMappingVersion: profile.reportMappingVersion,
    legacy: profile.legacy === true,
  };
  return { set, profile, roles: profile.roles, context };
}

/** 新建账套可用的 profile：未提供准则默认小企；非法 / 错配 / legacy 新建一律结构化拒绝。 */
function resolveCreationProfile({ accounting_standard, profileId } = {}) {
  const raw = accounting_standard;
  // 旧调用方会传 undefined / null / ""：视为“未提供准则”，默认小企（不把空白当成合法准则值）。
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return resolveNewAccountingProfile(profileId === undefined ? {} : { profileId });
  }
  if (typeof raw !== "string") {
    throw profileError("accounting_standard_invalid", "会计准则是非受支持的类型", {
      field: "accounting_standard",
      reason: "not-a-string",
    });
  }
  if (raw !== raw.trim()) {
    throw profileError("accounting_standard_invalid", "会计准则必须精确匹配（不接受首尾空白）", {
      field: "accounting_standard",
      reason: "not-exact",
    });
  }
  return resolveNewAccountingProfile(profileId === undefined
    ? { accounting_standard: raw }
    : { accounting_standard: raw, profileId });
}

/** 新建账套时的科目种子：按 profile 的科目表，不再无差别读取旧 COA 单数组。 */
function seedAccounts(profile) {
  return profile.coa.map((account) => ({
    code: account.code,
    name: account.name,
    category: account.category,
    direction: account.direction,
    contra: account.contra === true,
  }));
}

/**
 * 必要的 profile 角色必须能落到真实科目上，并与准则映射语义（类别 / 方向 / 备抵）一致；
 * 缺失或冲突都在写入前失败（不伪造分录，也不能靠被污染的库元数据算 natural）。
 */
function requireRoleAccounts(setId, profile, roleNames) {
  const existing = new Map(
    rows(`SELECT code, name, category, direction, contra FROM accounts WHERE account_set_id=?`, setId)
      .map((account) => [account.code, account]),
  );
  for (const role of roleNames) {
    const value = profile.roles[role];
    const list = Array.isArray(value) ? value : [value];
    for (const code of list) {
      if (typeof code !== "string" || !code) {
        throw profileError("accounting_role_missing", `profile ${profile.id} 缺少角色 ${role}`, {
          field: role, profileId: profile.id, reason: "role-not-defined",
        });
      }
      if (!existing.has(code)) {
        throw profileError("accounting_role_missing", `profile ${profile.id} 的角色 ${role} 对应科目不在账套科目表中`, {
          field: role, profileId: profile.id, accountCode: code, reason: "role-account-missing",
        });
      }
      const semantics = accountProfileSemantics(profile, existing.get(code));
      if (semantics.reasons.length) {
        throw profileError("accounting_role_semantics_conflict", `profile ${profile.id} 的角色 ${role} 科目语义与准则映射冲突`, {
          field: role,
          accountCode: semantics.declared.code,
          matchedRoot: semantics.matchedRoot,
          reason: semantics.reasons[0],
        });
      }
    }
  }
}

// ---------------------------------------------------------------- 账套
/**
 * 新建账套：按请求准则选择合法新 profile，并在**同一保存点**内写账套、科目、首期间与 profile。
 * 未提供准则默认小企；非法准则 / 显式 legacy 新建 / 错配全部结构化拒绝。
 * 已存在账套的 profile 不可通过普通参数改变（本文件没有更新 profile / 准则的入口）。
 */
export function createAccountSet({ name, taxpayer_type, accounting_standard, start_period, profileId, enterprise } = {}) {
  if (!name) throw new Error("name_required");
  const startPeriod = requirePeriod(start_period, "start_period_invalid");
  const profile = resolveCreationProfile({ accounting_standard, profileId });
  if (profile.legacy) {
    // resolveNewAccountingProfile 已拒绝，这里只作防御。
    throw profileError("accounting_profile_legacy_not_creatable", "legacy profile 不能用于新建账套", {
      field: "profileId", profileId: profile.id, reason: "legacy-not-creatable",
    });
  }
  const identity = normalizeEnterpriseIdentity(enterprise);
  return withSavepoint(() => {
    if (getEnterpriseAccountSet(db, identity.enterpriseKey)) throw identityError("enterprise_already_bound");
    const info = run(
      `INSERT INTO account_sets (name, taxpayer_type, accounting_standard, start_period, created_at, accounting_profile_id)
       VALUES (?,?,?,?,?,?)`,
      name,
      taxpayer_type || "小规模纳税人",
      profile.declaredStandard,
      startPeriod,
      now(),
      profile.id,
    );
    const id = Number(info.lastInsertRowid);
    const insAcc = db.prepare(
      `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
       VALUES (?,?,?,?,?,?,1)`
    );
    for (const a of seedAccounts(profile)) insAcc.run(id, a.code, a.name, a.category, a.direction, a.contra ? 1 : 0);
    ensurePeriod(id, startPeriod);
    insertEnterpriseAccountSet(db, { ...identity, accountSetId: id, boundBy: "create" });
    return getAccountSet(id);
  });
}

export function listAccountSets() {
  return rows(`SELECT * FROM account_sets ORDER BY id DESC`).map((set) => {
    try {
      return { ...set, enterprise: getAccountSetEnterpriseIdentity(set.id), accountingContext: accountSetProfile(set.id).context };
    } catch (e) {
      // 损坏 / 未知 profile：列表仍可用于只读恢复核对，但明确标记错误，不静默 fallback。
      return {
        ...set,
        accountingContext: null,
        accountingContextError: {
          code: e?.code === "accounting_profile_unknown" ? "accounting_profile_unknown" : "profile_unreadable",
          field: "accounting_profile_id",
        },
      };
    }
  });
}
export function getAccountSet(id) {
  const { set, context } = accountSetProfile(id);
  return { ...set, enterprise: getAccountSetEnterpriseIdentity(id), accountingContext: context };
}
/** Local-only identity read; null marks an existing unbound historical book. */
export function getAccountSetEnterpriseIdentity(id) {
  if (!accountSetRow(id)) throw identityError("account_set_not_found");
  const binding = getAccountSetEnterprise(db, id);
  return binding ? { enterpriseKey: binding.enterprise_key, enterpriseName: binding.enterprise_name } : null;
}
export function bindAccountSetEnterprise(id, enterprise, { confirmNewBinding = false } = {}) {
  const identity = normalizeEnterpriseIdentity(enterprise);
  return withSavepoint(() => {
    if (!accountSetRow(id)) throw identityError("account_set_not_found");
    const current = getAccountSetEnterprise(db, id);
    const canonical = getEnterpriseAccountSet(db, identity.enterpriseKey);
    if (current && current.enterprise_key !== identity.enterpriseKey) throw identityError("account_set_bound_to_other_enterprise");
    if (canonical && canonical.account_set_id !== id) throw identityError("enterprise_already_bound");
    if (current) return { status: "no_change", accountSetId: id, enterprise: getAccountSetEnterpriseIdentity(id) };
    if (confirmNewBinding !== true) throw identityError("account_set_binding_confirmation_required");
    insertEnterpriseAccountSet(db, { ...identity, accountSetId: id, boundBy: "local_confirm" });
    return { status: "bound", accountSetId: id, enterprise: getAccountSetEnterpriseIdentity(id) };
  });
}
export function deleteAccountSet(id) {
  accountSetProfile(id);
  run(`DELETE FROM account_sets WHERE id=?`, id);
}

// ---------------------------------------------------------------- 科目
export function listAccounts(setId) {
  getAccountSet(setId);
  return rows(`SELECT * FROM accounts WHERE account_set_id=? ORDER BY code`, setId);
}
export function addAccount(setId, { code, name, category, direction, parent_code = null }) {
  const { profile } = accountSetProfile(setId);
  if (!code || !name) throw new Error("code_and_name_required");
  if (!["debit", "credit"].includes(direction)) throw new Error("direction_invalid");
  if (!["资产", "负债", "权益", "成本", "损益"].includes(category)) throw new Error("category_invalid");
  // 自定义明细写前校验：类别 / 方向 / 备抵必须与 profile 根科目一致；未映射编码仍允许，
  // 但报表会以 account_unmapped 诊断（不把无准则依据的科目静默当成某一类）。
  const semantics = accountProfileSemantics(profile, { code: String(code), name, category, direction, contra: false });
  if (semantics.reasons.length) {
    const reason = semantics.reasons[0];
    throw profileError("account_semantics_conflict", `自定义科目与 profile ${profile.id} 根科目语义冲突`, {
      field: reason === "category-conflict" ? "category" : reason === "direction-conflict" ? "direction" : "contra",
      accountCode: String(code),
      matchedRoot: semantics.matchedRoot,
      reason,
    });
  }
  run(
    `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
     VALUES (?,?,?,?,?,0,1)`,
    setId, String(code), name, category, direction
  );
  return listAccounts(setId);
}

// ---------------------------------------------------------------- 期初
export function setOpeningBalances(setId, items = []) {
  getAccountSet(setId);
  if (!Array.isArray(items)) throw new Error("opening_items_invalid");

  // 已有已过账凭证或封账期间时，禁止改写期初。
  const posted = row(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND status='posted'`, setId).n;
  if (posted > 0) throw new Error("opening_rewrite_after_posting");
  const closed = row(`SELECT COUNT(*) n FROM periods WHERE account_set_id=? AND status='closed'`, setId).n;
  if (closed > 0) throw new Error("opening_rewrite_period_closed");

  // 先全量预校验，再动数据库；避免部分写入。
  const resolved = [];
  for (const it of items) {
    const code = String(it?.code ?? "");
    if (!code) throw new Error("opening_code_required");
    const acc = row(`SELECT 1 FROM accounts WHERE account_set_id=? AND code=?`, setId, code);
    if (!acc) throw new Error(`account_not_found:${code}`);
    // 统一十进制规则：负数（含 -0.001）与超界在原值阶段就被拒绝，不靠舍入“修好”。
    const d = parseMoney(it?.debit, { label: "期初借方" });
    const c = parseMoney(it?.credit, { label: "期初贷方" });
    if (!d.ok || !c.ok) throw new Error(`opening_amount_invalid:${code}`);
    // 非零但不足一分：拒绝而不是静默写成 0（否则会悄悄丢掉金额）。
    if (d.subCent || c.subCent) throw new Error(`opening_amount_invalid:${code}`);
    if (d.cents > 0n && c.cents > 0n) throw new Error(`opening_borrow_lend_conflict:${code}`);
    resolved.push({ code, debitCents: d.cents, creditCents: c.cents });
  }

  // 与已有期初合并后的整体必须借贷平衡（分上精确相等）。
  const merged = new Map(getOpeningBalances(setId).map((o) => [
    o.code,
    { debitCents: storedCents(o.debit), creditCents: storedCents(o.credit) },
  ]));
  for (const it of resolved) merged.set(it.code, { debitCents: it.debitCents, creditCents: it.creditCents });
  const mergedValues = [...merged.values()];
  const td = mergedValues.reduce((s, v) => s + v.debitCents, 0n);
  const tc = mergedValues.reduce((s, v) => s + v.creditCents, 0n);
  if (td !== tc) {
    const err = new Error("opening_unbalanced");
    err.details = { total_debit: centsToNumber(td), total_credit: centsToNumber(tc) };
    throw err;
  }

  return withSavepoint(() => {
    const del = db.prepare(`DELETE FROM opening_balances WHERE account_set_id=? AND code=?`);
    const ins = db.prepare(
      `INSERT INTO opening_balances (account_set_id, code, debit, credit) VALUES (?,?,?,?)`
    );
    for (const it of resolved) {
      del.run(setId, it.code);
      ins.run(setId, it.code, centsToNumber(it.debitCents), centsToNumber(it.creditCents));
    }
    return getOpeningBalances(setId);
  });
}
export function getOpeningBalances(setId) {
  getAccountSet(setId);
  return rows(`SELECT code, debit, credit FROM opening_balances WHERE account_set_id=? ORDER BY code`, setId);
}

// ---------------------------------------------------------------- 期间
export function listPeriods(setId) {
  getAccountSet(setId);
  return rows(`SELECT period, status FROM periods WHERE account_set_id=? ORDER BY period`, setId);
}
export function ensurePeriod(setId, period) {
  const s = getAccountSet(setId);
  const p = requirePeriod(period);
  if (p < s.start_period) throw new Error("period_before_start");
  run(`INSERT OR IGNORE INTO periods (account_set_id, period, status) VALUES (?,?,'open')`, setId, p);
  return row(`SELECT period, status FROM periods WHERE account_set_id=? AND period=?`, setId, p);
}
export function setPeriodStatus(setId, period, status) {
  if (!["open", "closed"].includes(status)) throw new Error("status_invalid");
  const s = getAccountSet(setId);
  const p = requirePeriod(period);
  if (p < s.start_period) throw new Error("period_before_start");
  const existing = row(`SELECT * FROM periods WHERE account_set_id=? AND period=?`, setId, p);

  if (status === "open") {
    // 反结账：已有更晚期间封账时不能直接重开前期（否则后期已依赖的数据会被静默污染）。
    if (existing?.status === "closed") assertPeriodMutable(db, setId, p, { operation: "reopen_period" });
    // 已登记则置 open；未登记则新建期间。
    if (!existing) ensurePeriod(setId, p);
    else if (existing.status !== "open")
      run(`UPDATE periods SET status='open' WHERE account_set_id=? AND period=?`, setId, p);
    return { period: p, status: "open" };
  }

  // 结账：期间须已存在；草稿 / 试算平衡保留原有错误码，其余前置给结构化 period_end_check_failed。
  if (!existing) throw new Error("period_not_found");
  const drafts = row(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND period=? AND status='draft'`, setId, p).n;
  if (drafts > 0) throw new Error("period_has_draft_vouchers");
  const tb = trialBalance(setId, p);
  if (Math.abs(tb.totals.closing_debit - tb.totals.closing_credit) > EPS) throw new Error("period_unbalanced");
  // 资产计提 / 卡片与总账核对 / 损益与年末结转 / 连续期间顺序：与实际写入口共用同一规则。
  assertPeriodCloseable(db, setId, p, { skip: ["draft_vouchers", "trial_balance"] });
  if (existing.status !== "closed")
    run(`UPDATE periods SET status='closed' WHERE account_set_id=? AND period=?`, setId, p);
  return { period: p, status: "closed" };
}

/** 期末检查（只读）：与封账前置同一套规则，供 HTTP / Agent / MCP 查询。 */
export function periodEndCheck(setId, period) {
  const s = getAccountSet(setId);
  const p = requirePeriod(period);
  if (p < s.start_period) throw new Error("period_before_start");
  return buildPeriodEndCheck(db, setId, p);
}
/** 返回 set/period 的期间状态；未登记过则按 open 处理。 */
export function periodStatus(setId, period) {
  const p = row(`SELECT status FROM periods WHERE account_set_id=? AND period=?`, setId, period);
  return p ? p.status : "open";
}

// ---------------------------------------------------------------- 凭证
// 直接凭证仅接受普通十进制文本；导入的货币前缀/千分位语法仍由导入解析器负责。
function parseVoucherAmount(raw) {
  const parsed = parseMoney(raw, { label: "金额", maxCents: MONEY_MAX_CENTS });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // 非零但不足一分（ 0.001 / 1e-7 ）必须拒绝：不能静默舍成 0 后仍当成合法金额入库。
  if (parsed.subCent) {
    return { ok: false, error: `金额不足一分（非零金额不能舍入成 0）：${String(raw)}` };
  }
  return { ok: true, cents: parsed.cents };
}

// 校验与保存共享一次归一化结果；归一化分录不进入公开预检响应。
function normalizeVoucher(setId, entries = []) {
  const errors = [];
  const list = Array.isArray(entries) ? entries : [];
  if (!Array.isArray(entries)) errors.push("分录必须是数组");
  if (list.length < 2) errors.push("至少需要两条分录");
  const normalized = [], dList = [], cList = [];
  // 索引迭代会检查空槽，避免稀疏数组被 forEach 静默跳过。
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      errors.push(`第${i + 1}行分录必须是对象`);
      continue;
    }
    const debit = parseVoucherAmount(e.debit), credit = parseVoucherAmount(e.credit);
    if (!debit.ok) errors.push(`第${i + 1}行借方${debit.error}`);
    if (!credit.ok) errors.push(`第${i + 1}行贷方${credit.error}`);
    const d = debit.ok ? debit.cents : 0n, c = credit.ok ? credit.cents : 0n;
    dList.push(d); cList.push(c);
    if (d > 0n && c > 0n) errors.push(`第${i + 1}行借贷不能同时有值`);
    if (d === 0n && c === 0n) errors.push(`第${i + 1}行金额不能为 0`);
    const rawCode = e.code;
    const code = rawCode ? String(rawCode) : "";
    if (code) {
      const acc = row(`SELECT * FROM accounts WHERE account_set_id=? AND code=?`, setId, code);
      if (!acc) errors.push(`第${i + 1}行科目不存在：${code}`);
    } else {
      errors.push(`第${i + 1}行缺少科目`);
    }
    normalized.push({ code, summary: e.summary, debitCents: d, creditCents: c });
  }
  const tdCents = dList.reduce((s, v) => s + v, 0n), tcCents = cList.reduce((s, v) => s + v, 0n);
  let td, tc;
  try {
    td = centsToNumber(tdCents); tc = centsToNumber(tcCents);
  } catch (e) {
    errors.push(e.message || "借贷合计超出可精确表示范围");
    td = tdCents; tc = tcCents;
  }
  if (tdCents !== tcCents) errors.push(`借贷不平：借方 ${formatCents(tdCents)} / 贷方 ${formatCents(tcCents)}`);
  return {
    check: {
      ok: errors.length === 0, errors,
      total_debit: typeof td === "number" ? td : Number(td),
      total_credit: typeof tc === "number" ? tc : Number(tc),
    },
    entries: normalized.map((e) => ({
      code: e.code, summary: e.summary,
      debit: centsToNumber(e.debitCents), credit: centsToNumber(e.creditCents),
    })),
  };
}

export function checkVoucher(setId, entries = []) {
  return normalizeVoucher(setId, entries).check;
}

function nextNumber(setId, period, word) {
  const r = row(
    `SELECT MAX(number) AS n FROM vouchers WHERE account_set_id=? AND period=? AND word=?`,
    setId, period, word
  );
  return (r?.n || 0) + 1;
}

/**
 * 本次写入会影响哪些后续派生结果：
 *  - profit：损益余额。普通损益结转按「截至该期间的累计损益余额」生成，因此任何损益分录 / 结转都算；
 *  - depreciation：资产计提。后续计提依赖前期计提状态与卡片金额 / 期间事实。
 * 这两个事实决定「前期修改是否会被后续期间已过账派生凭证静默依赖」，用于统一依赖守卫。
 */
function voucherTouches(setId, { entries = [], kind = "normal" } = {}) {
  const profitCodes = new Set(listAccounts(setId).filter((a) => a.category === "损益").map((a) => a.code));
  const profit = kind === "carryforward" || entries.some((entry) => profitCodes.has(String(entry?.code ?? "")));
  return { profit, depreciation: kind === "depreciation" };
}

/** 已落库凭证的依赖分类（反过账 / 删除前用）。 */
function storedVoucherTouches(setId, voucher) {
  const codes = rows(`SELECT code FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`, voucher.id);
  return voucherTouches(setId, { entries: codes, kind: voucher.kind });
}

export function createVoucher(setId, v = {}, { touches = null } = {}) {
  const s = getAccountSet(setId);
  // 先校验，后落库：校验失败不产生期间/凭证等副作用。
  const period = requirePeriod(v.period);
  if (period < s.start_period) throw new Error("period_before_start");
  if (periodStatus(setId, period) === "closed") throw new Error("period_closed");
  // 前期变动不得静默污染已封账的后期 / 已过账年末结转 / 依赖累计余额的后期普通结转与计提：
  // 明确拒绝并给出撤销顺序。
  assertPeriodMutable(db, setId, period, {
    operation: "create_voucher",
    touches: touches ?? voucherTouches(setId, { entries: Array.isArray(v.entries) ? v.entries : [], kind: v.kind }),
  });
  const { check: chk, entries } = normalizeVoucher(setId, v.entries);
  if (!chk.ok) {
    const err = new Error("voucher_invalid");
    err.details = chk;
    throw err;
  }
  return withSavepoint(() => {
    ensurePeriod(setId, period);
    const status = v.status === "posted" ? "posted" : "draft";
    const kind = v.kind || "normal";
    const word = v.word || "记";
    const number = v.number || nextNumber(setId, period, word);
    const info = run(
      `INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, kind, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      setId, period, v.voucher_date || `${period}-01`, word, number, v.summary || "", status, kind, now()
    );
    const vid = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit) VALUES (?,?,?,?,?,?)`
    );
    entries.forEach((e, i) => ins.run(vid, i + 1, e.code, e.summary || v.summary || "", e.debit, e.credit));
    return getVoucher(setId, vid);
  });
}

export function listVouchers(setId, { period, status } = {}) {
  getAccountSet(setId);
  const where = [`account_set_id=?`];
  const args = [setId];
  if (period) { where.push("period=?"); args.push(period); }
  if (status) { where.push("status=?"); args.push(status); }
  const vs = rows(
    `SELECT * FROM vouchers WHERE ${where.join(" AND ")} ORDER BY period DESC, number DESC`,
    ...args
  );
  return vs.map(hydrate);
}
const hydrate = (v) => {
  const entries = rows(
    `SELECT line_no, code, summary, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`, v.id,
  );
  // 损坏库上的非法金额不能被静默当成 0 合计：只累加合法项，并标记 amounts_valid=false，
  // 让调用方（过账 / 报表）先做出判断，而不是展示一个看似正常的总数。
  let debit = 0n, credit = 0n, amountsValid = true;
  for (const entry of entries) {
    for (const value of [entry.debit, entry.credit]) {
      const parsed = parseMoney(value, { allowNegative: true });
      if (!parsed.ok) amountsValid = false;
    }
    const d = parseMoney(entry.debit, { allowNegative: true });
    const c = parseMoney(entry.credit, { allowNegative: true });
    if (d.ok) debit += d.cents;
    if (c.ok) credit += c.cents;
  }
  // 合计超出可保分范围时也不抛错阻塞查账：两个合计返回 null + amounts_valid=false。
  let totalDebit = null, totalCredit = null;
  try { totalDebit = centsToNumber(debit); } catch { amountsValid = false; }
  try { totalCredit = centsToNumber(credit); } catch { amountsValid = false; }
  return {
    ...v,
    entries,
    total_debit: totalDebit,
    total_credit: totalCredit,
    amounts_valid: amountsValid,
  };
};

export function getVoucher(setId, id) {
  const v = row(`SELECT * FROM vouchers WHERE account_set_id=? AND id=?`, setId, id);
  if (!v) throw new Error("voucher_not_found");
  return hydrate(v);
}

/**
 * 派生折旧/摊销凭证重新过账约束：
 * 恢复一张被反过账的折旧凭证时，核验「该资产其他已过账计提出累计 + 本凭证计提」
 * 不超过可折旧额。一旦超出则整单拒绝，绝不部分过账；合法的未超额反过账/重过账
 * 以及删除重算均不受影响。
 * 该约束堵住如下漏洞：先 unpost 旧期折旧、再跨期计提（已过账累计变 0 会重新算满额）、
 * 最后重新过账旧凭证，从而使累计计提超过可折旧额（remaining 为负）。
 */
function assertDepreciationPostable(setId, v) {
  if (v.kind !== "depreciation") return;
  const runs = rows(
    `SELECT r.asset_id, r.amount, c.original_cost, c.residual_rate, c.useful_life_months, c.opening_accumulated
       FROM asset_depreciation_runs r
       JOIN asset_cards c ON c.id = r.asset_id
      WHERE r.account_set_id=? AND r.voucher_id=?`,
    setId, v.id
  );
  if (!runs.length) return;
  const perAsset = new Map();
  for (const r of runs) {
    const info = perAsset.get(r.asset_id) || {
      postingCents: 0n,
      depreciableCents: cardMoney(r).depreciableCents,
      // 补项期初累计也是已发生的累计，必须计入“不得超过可计提额”。
      openingCents: storedCents(r.opening_accumulated ?? 0),
    };
    info.postingCents += storedCents(r.amount);
    perAsset.set(r.asset_id, info);
  }
  for (const [assetId, info] of perAsset) {
    const postedCents = sumCents(rows(
      `SELECT r.amount FROM asset_depreciation_runs r
         JOIN vouchers v ON v.id = r.voucher_id
        WHERE r.account_set_id=? AND r.asset_id=? AND v.status='posted' AND r.voucher_id<>?`,
      setId, assetId, v.id
    ).map((r) => r.amount));
    if (info.openingCents + postedCents + info.postingCents > info.depreciableCents) {
      const err = new Error("depreciation_exceeds_depreciable");
      err.code = "depreciation_exceeds_depreciable";
      err.details = {
        asset_id: assetId,
        depreciable: centsToNumber(info.depreciableCents),
        opening_accumulated: centsToNumber(info.openingCents),
        posted: centsToNumber(postedCents),
        posting: centsToNumber(info.postingCents),
        guidance: "重过账该计提凭证会把累计计提推过可计提额：请先按倒序反过账 / 删除后期计提凭证，再按期间顺序重新计提",
      };
      throw err;
    }
  }
}

/**
 * 旧草稿计提凭证的「定义一致性」守卫（重过账之前）：
 * 一张计提凭证只能代表卡片**当时定义**下的应提额。若这张凭证被反过账后卡片改了
 * 寿命 / 原值 / 残值 / 起提期间 / 取得期间 / 期初累计 / 账簿状态，或改了费用与累计科目，
 * 旧草稿就直接重过账会让账簿静默保留一个错误金额（例如寿命从 10 改 5 后仍然只提 10）。
 * 所以一律明确拒绝并给可执行路径：删除旧草稿（连带旧 run）→ 按当前定义重新计提。
 * 注：只影响**重过账旧草稿**；已过账计提的历史金额仍按原样保留，不会被静默改写。
 */
function assertDepreciationRunsCurrent(setId, v) {
  if (v.kind !== "depreciation") return;
  const runs = rows(
    `SELECT asset_id, period, amount FROM asset_depreciation_runs
      WHERE account_set_id=? AND voucher_id=? ORDER BY period, asset_id`,
    setId, v.id,
  );
  if (!runs.length) return;
  const stale = [];
  const wantEntries = new Map();
  const addEntry = (map, key, cents) => map.set(key, (map.get(key) ?? 0n) + cents);
  for (const r of runs) {
    const card = row(`SELECT * FROM asset_cards WHERE account_set_id=? AND id=?`, setId, r.asset_id);
    const recordedCents = storedCents(r.amount);
    if (!card) {
      stale.push({
        assetId: r.asset_id, period: r.period,
        recordedAmount: centsToNumber(recordedCents), expectedAmount: null,
        reason: "计提记录对应的资产卡片已不存在",
      });
      continue;
    }
    if (recordedCents !== 0n) {
      addEntry(wantEntries, `${card.expense_account}|debit`, recordedCents);
      addEntry(wantEntries, `${card.accum_account}|credit`, recordedCents);
    }
    const expected = expectedDepreciationCents(db, card, r.period);
    // 与期末检查同一口径：一致才算“该期已计提完成”，否则为旧定义下的失效草稿。
    const consistent = expected.status === "due"
      ? expected.expectedCents === recordedCents
      : recordedCents === 0n;
    if (!consistent) {
      stale.push({
        assetId: card.id, name: card.name, period: r.period,
        recordedAmount: centsToNumber(recordedCents),
        expectedAmount: centsToNumber(expected.expectedCents),
        expectedStatus: expected.status,
        reason: `${expected.reason ?? expected.status}（卡片当前定义应提 ${formatCents(expected.expectedCents)}，旧凭证记 ${formatCents(recordedCents)}）`,
      });
    }
  }
  // 科目映射也可能被改过：计提凭证必须与卡片当前的费用 / 累计科目及金额一致。
  const gotEntries = new Map();
  for (const entry of rows(`SELECT code, debit, credit FROM voucher_entries WHERE voucher_id=?`, v.id)) {
    const d = storedCents(entry.debit), c = storedCents(entry.credit);
    if (d !== 0n) addEntry(gotEntries, `${entry.code}|debit`, d);
    if (c !== 0n) addEntry(gotEntries, `${entry.code}|credit`, c);
  }
  const entryDiffs = [];
  for (const key of new Set([...wantEntries.keys(), ...gotEntries.keys()])) {
    const want = wantEntries.get(key) ?? 0n, got = gotEntries.get(key) ?? 0n;
    if (want === got) continue;
    const [code, side] = key.split("|");
    entryDiffs.push({ code, side, expectedAmount: centsToNumber(want), voucherAmount: centsToNumber(got) });
  }
  if (entryDiffs.length) {
    stale.push({
      assetId: null, name: null, period: null,
      recordedAmount: null, expectedAmount: null,
      reason: "计提凭证分录与卡片当前的费用 / 累计折旧科目（或金额）不一致",
      entries: entryDiffs,
    });
  }
  if (!stale.length) return;
  const err = new Error("depreciation_run_stale");
  err.code = "depreciation_run_stale";
  err.details = {
    voucherId: v.id,
    period: v.period,
    stale,
    guidance: "该计提凭证是旧卡片定义下的草稿，不能直接重过账（不静默改原凭证）：请删除该草稿凭证（连带旧计提记录）后按当前卡片定义重新计提；已过账的同类凭证需先反过账再删除重算",
  };
  throw err;
}

export function postVoucher(setId, id) {
  // 先读原始行 + 分录做校验，再看 hydrate 合计：即使库里金额已被损坏，也必须先给 voucher_invalid。
  const raw = row(`SELECT * FROM vouchers WHERE account_set_id=? AND id=?`, setId, id);
  if (!raw) throw new Error("voucher_not_found");
  if (raw.status === "posted") return hydrate(raw);
  if (periodStatus(setId, raw.period) === "closed") throw new Error("period_closed");
  const entries = rows(
    `SELECT line_no, code, summary, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`, id,
  );
  const chk = checkVoucher(setId, entries);
  if (!chk.ok) { const e = new Error("voucher_invalid"); e.details = chk; throw e; }
  // 先给「旧草稿是否仍符合卡片当前定义」与金额诊断（重过账会把累计推过可计提额），
  // 再给期间依赖顺序：三者都是只读断言，失败时全库不变。
  assertDepreciationRunsCurrent(setId, { id: raw.id, kind: raw.kind, period: raw.period });
  assertDepreciationPostable(setId, { id: raw.id, kind: raw.kind });
  assertPeriodMutable(db, setId, raw.period, {
    operation: "post_voucher",
    touches: { ...storedVoucherTouches(setId, raw), depreciationExcludeVoucherId: raw.id },
  });
  return withSavepoint(() => {
    run(`UPDATE vouchers SET status='posted' WHERE id=?`, id);
    return getVoucher(setId, id);
  });
}
export function unpostVoucher(setId, id) {
  const v = getVoucher(setId, id);
  if (periodStatus(setId, v.period) === "closed") throw new Error("period_closed");
  assertPeriodMutable(db, setId, v.period, {
    operation: "unpost_voucher",
    touches: { ...storedVoucherTouches(setId, v), depreciationExcludeVoucherId: v.id },
  });
  run(`UPDATE vouchers SET status='draft' WHERE id=?`, id);
  return getVoucher(setId, id);
}
export function deleteVoucher(setId, id) {
  const v = getVoucher(setId, id);
  if (periodStatus(setId, v.period) === "closed") throw new Error("period_closed");
  if (v.status === "posted") throw new Error("posted_voucher_requires_unpost");
  // 删除的是**未过账**凭证：它不在任何已过账余额里，因此不构成后期派生凭证的已实现依赖；
  // 只需保证不跨过已封账的后期 / 不绕过年末结转依赖（由 assertPeriodMutable 的期间 / 年末检查覆盖）。
  assertPeriodMutable(db, setId, v.period, { operation: "delete_voucher" });
  return withSavepoint(() => {
    deleteVoucherRow(setId, id);
    return { deleted: id };
  });
}

/** 删除凭证及其关联的折旧计提记录（不经状态/封账校验，供内部重算使用）。 */
function deleteVoucherRow(setId, id) {
  run(`DELETE FROM asset_depreciation_runs WHERE account_set_id=? AND voucher_id=?`, setId, id);
  run(`DELETE FROM vouchers WHERE account_set_id=? AND id=?`, setId, id);
}

// ---------------------------------------------------------------- 余额
/** 计算账套在 period 的科目余额（含期初 + 已过账发生额）。金额全程按整数分累加。 */
export function accountBalances(setId, period) {
  const s = getAccountSet(setId);
  const accs = listAccounts(setId);
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) throw new Error("period_invalid");
  const ZERO = { d: 0n, c: 0n };
  const open = new Map();
  for (const o of getOpeningBalances(setId)) {
    open.set(o.code, { d: storedCents(o.debit), c: storedCents(o.credit) });
  }
  const mv = new Map();
  for (const entry of postedEntryRows(db, setId, { fromPeriod: s.start_period, toPeriod: period })) {
    const cur = mv.get(entry.code) || { d: 0n, c: 0n };
    cur.d += storedCents(entry.debit);
    cur.c += storedCents(entry.credit);
    mv.set(entry.code, cur);
  }
  const out = new Map();
  for (const a of accs) {
    const o = open.get(a.code) || ZERO;
    const m = mv.get(a.code) || ZERO;
    const netCents = (o.d - o.c) + (m.d - m.c);
    const naturalCents = a.direction === "debit" ? netCents : -netCents;
    const net = centsToNumber(netCents);
    const natural = centsToNumber(naturalCents);
    out.set(a.code, {
      code: a.code, name: a.name, category: a.category, direction: a.direction,
      contra: !!a.contra,
      opening_debit: centsToNumber(o.d), opening_credit: centsToNumber(o.c),
      period_debit: centsToNumber(m.d), period_credit: centsToNumber(m.c),
      net, natural, balance: natural,
    });
  }
  return out;
}

/** 仅统计指定区间的发生额（用于利润表本期/本年累计），返回分。 */
function netForRangeCents(setId, codes, fromPeriod, toPeriod) {
  if (!codes.length) return { debit: 0n, credit: 0n };
  const wanted = new Set(codes);
  let debit = 0n, credit = 0n;
  for (const entry of postedEntryRows(db, setId, { fromPeriod, toPeriod, excludeCarryforward: true })) {
    if (!wanted.has(entry.code)) continue;
    debit += storedCents(entry.debit);
    credit += storedCents(entry.credit);
  }
  return { debit, credit };
}
function naturalRangeCents(setId, codes, fromPeriod, toPeriod) {
  const { debit, credit } = netForRangeCents(setId, codes, fromPeriod, toPeriod);
  const dir = row(`SELECT direction FROM accounts WHERE account_set_id=? AND code=?`, setId, codes[0]);
  const d = dir?.direction || "debit";
  return d === "debit" ? debit - credit : credit - debit;
}

// ---- 科目编码层级归集 ----------------------------------------------------
// 同一编码被视为“父/子”关系：编码完全相等，或某编码是另一个的前缀（如 1002 与 100201）。
// 归集时按科目逐个判断，保证“父科目直接发生 + 子科目发生”既不重复也不遗漏。
const underPrefix = (code, prefix) => code === prefix || String(code).startsWith(prefix);

/** 汇总 bal 中命中任一编码前缀的科目 natural 余额（分）；每个科目只计一次。 */
function sumByPrefixCents(balCents, prefixList) {
  return sumNaturalByPrefix(balCents, prefixList);
}

/** 把 accountBalances 的自然余额转成分表，供报表精确合计。 */
function centsView(bal) {
  return new Map([...bal].map(([code, b]) => [code, { natural: storedCents(b.natural) }]));
}

/** 判断科目编码是否属于给定的一组顶层编码及其下级明细。 */
const codeUnderAny = (code, prefixList) => prefixList.some((p) => underPrefix(code, p));

// ---------------------------------------------------------------- 报表状态 / DTO 适配
const BS_ASSET_ROW_IDS = new Set([
  "cash", "short-term-investment", "notes-receivable", "accounts-receivable", "prepayments",
  "dividends-receivable", "interest-receivable", "other-receivables", "inventory",
  "fixed-assets-cost", "accumulated-depreciation", "fixed-assets-net", "construction-in-progress",
  "intangible-assets-cost", "accumulated-amortization", "intangible-assets-net",
  "long-term-deferred-expenses", "total-assets",
]);

// 阶段 A 诊断码 → 稳定外层码（不把内部 message / 名称 / 金额原值透传给模型或导出元数据）。
const PROFILE_DIAGNOSTIC_MAP = {
  account_unmapped: ["report_account_unmapped", "account-not-in-profile"],
  account_requires_detail: ["report_account_requires_detail", "account-requires-detail"],
  account_reverse_balance_requires_detail: ["report_account_requires_detail", "reverse-balance-requires-detail"],
  account_category_conflict: ["report_account_semantics_mismatch", "account-category-conflict"],
  account_direction_conflict: ["report_account_semantics_mismatch", "account-direction-conflict"],
  account_contra_conflict: ["report_account_semantics_mismatch", "account-contra-conflict"],
  account_scope_unsupported: ["report_account_semantics_mismatch", "account-scope-unsupported"],
  account_scope_unknown: ["report_account_semantics_mismatch", "account-scope-unknown"],
  account_out_of_statement: ["report_account_semantics_mismatch", "account-out-of-statement"],
};

const REASON_TOKEN = /^[a-z0-9][a-z0-9._-]*$/i;
const fixedReason = (value, fallback) =>
  (typeof value === "string" && REASON_TOKEN.test(value) ? value : fallback);

function mappingDiagnostics(kind, evaluation) {
  const out = [];
  const seen = new Set();
  for (const diagnostic of evaluation?.diagnostics ?? []) {
    const [code, fallbackReason] = PROFILE_DIAGNOSTIC_MAP[diagnostic.code]
      ?? ["report_account_semantics_mismatch", "profile-rule-diagnostic"];
    const accountCode = typeof diagnostic.accountCode === "string" ? diagnostic.accountCode : undefined;
    const reason = fixedReason(diagnostic.reason, fallbackReason);
    const key = `${code}|${accountCode ?? ""}|${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code,
      severity: diagnostic.severity === "warning" ? "warning" : "error",
      reportKind: kind,
      ...(accountCode ? { accountCode } : {}),
      reason,
    });
  }
  return out;
}

function declaredStandardMismatch(kind, profile, context) {
  if (profile.legacy) return null;
  if (context.declaredStandard === profile.declaredStandard) return null;
  return {
    code: "declared_standard_profile_mismatch",
    severity: "warning",
    reportKind: kind,
    reason: "declared-standard-differs-from-profile",
  };
}

function profileReportStatus(kind, evaluation, { profile, context, extraDiagnostics = [] }) {
  const diagnostics = [
    ...mappingDiagnostics(kind, evaluation),
    ...extraDiagnostics,
  ];
  const mismatch = declaredStandardMismatch(kind, profile, context);
  if (mismatch) diagnostics.push(mismatch);
  const complete = evaluation.complete === true && !mismatch && !extraDiagnostics.some((d) => d.severity === "error");
  return {
    status: complete ? "complete" : "incomplete",
    complete,
    partialValues: !complete,
    diagnostics,
  };
}

function legacyReportStatus(kind, partialValues) {
  return {
    status: "legacy_compatibility",
    complete: false,
    partialValues: partialValues === true,
    diagnostics: [{
      code: "legacy_profile_compatibility",
      severity: "warning",
      reportKind: kind,
      reason: "legacy-profile-uses-old-report-path",
    }],
  };
}

// legacy 兼容报表实际覆盖的科目前缀（旧算法硬编码）；不在其中的非零科目即“确有漏映射”。
const LEGACY_BS_PREFIXES = [
  "1001", "1002", "1012", "1101", "1121", "1122", "1123", "1131", "1132", "1221",
  "1401", "1402", "1403", "1405", "1408", "1411", "1601", "1602", "1604", "1701", "1702", "1801",
  "2001", "2201", "2202", "2203", "2211", "2221", "2231", "2232", "2241", "2501", "2701",
  "3001", "3002", "3101", "3103", "3104",
];
function legacyBalancePartial(setId, period) {
  for (const [code, balance] of accountBalances(setId, period)) {
    if (storedCents(balance.net) === 0n) continue;
    if (balance.category === "损益") continue; // 旧兼容路径把损益汇总进未分配利润
    if (LEGACY_BS_PREFIXES.some((prefix) => underPrefix(code, prefix))) continue;
    return true;
  }
  return false;
}

function accountListDto(setId) {
  return listAccounts(setId).map((account) => ({
    code: account.code,
    name: account.name,
    category: account.category,
    direction: account.direction,
    contra: !!account.contra,
  }));
}

// 纯规则要求安全整数分：BigInt 分转 Number 前先检查范围，绝不静默丢分。
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
function centsToSafeMinor(cents, label = "金额") {
  const value = typeof cents === "bigint" ? cents : BigInt(cents);
  if (value > MAX_SAFE_CENTS || value < -MAX_SAFE_CENTS) {
    const error = new Error("money_total_out_of_range");
    error.code = "money_total_out_of_range";
    error.details = { field: label, reason: "cents-out-of-safe-integer-range" };
    throw error;
  }
  return Number(value);
}

function balanceAmounts(setId, period) {
  return [...accountBalances(setId, period).values()]
    .map((balance) => ({ code: balance.code, netMinor: centsToSafeMinor(storedCents(balance.net), "balance") }));
}

function rangeAmounts(setId, fromPeriod, toPeriod) {
  const acc = new Map();
  for (const entry of postedEntryRows(db, setId, { fromPeriod, toPeriod, excludeCarryforward: true })) {
    acc.set(entry.code, (acc.get(entry.code) ?? 0n) + storedCents(entry.debit) - storedCents(entry.credit));
  }
  return [...acc.entries()]
    .filter(([, cents]) => cents !== 0n)
    .map(([code, cents]) => ({ code, netMinor: centsToSafeMinor(cents, "range") }));
}

// ---------------------------------------------------------------- 报表
export function trialBalance(setId, period) {
  const bal = accountBalances(setId, period);
  const lines = [...bal.values()].map((b) => {
    const netCents = storedCents(b.net);
    return {
      code: b.code, name: b.name, direction: b.direction,
      opening_debit: b.opening_debit, opening_credit: b.opening_credit,
      period_debit: b.period_debit, period_credit: b.period_credit,
      closing_debit: centsToNumber(netCents > 0n ? netCents : 0n),
      closing_credit: centsToNumber(netCents < 0n ? -netCents : 0n),
    };
  });
  const sum = (key) => sumCents(lines.map((l) => l[key]));
  return {
    period, lines,
    totals: {
      opening_debit: centsToNumber(sum("opening_debit")), opening_credit: centsToNumber(sum("opening_credit")),
      period_debit: centsToNumber(sum("period_debit")), period_credit: centsToNumber(sum("period_credit")),
      closing_debit: centsToNumber(sum("closing_debit")), closing_credit: centsToNumber(sum("closing_credit")),
    },
  };
}

function legacyBalanceSheet(setId, period) {
  const bal = accountBalances(setId, period);
  const cents = centsView(bal);
  // 按编码层级归集：列表给出顶层科目，自动包含其下明细科目；合计全程在分上完成。
  const sum = (list) => sumByPrefixCents(cents, list);

  const 货币资金 = sum(["1001", "1002", "1012"]);
  const 短期投资 = sum(["1101"]);
  const 应收票据 = sum(["1121"]);
  const 应收账款 = sum(["1122"]);
  const 预付账款 = sum(["1123"]);
  const 其他应收款 = sum(["1131", "1132", "1221"]);
  const 存货 = sum(["1401", "1402", "1403", "1405", "1408", "1411"]);
  const 固定资产原价 = sum(["1601"]);
  const 累计折旧 = sum(["1602"]);
  const 固定资产 = 固定资产原价 - 累计折旧;
  const 在建工程 = sum(["1604"]);
  const 无形资产原价 = sum(["1701"]);
  const 累计摊销 = sum(["1702"]);
  const 无形资产 = 无形资产原价 - 累计摊销;
  const 长期待摊费用 = sum(["1801"]);
  const 资产合计 = 货币资金 + 短期投资 + 应收票据 + 应收账款 + 预付账款 + 其他应收款 +
    存货 + 固定资产 + 在建工程 + 无形资产 + 长期待摊费用;

  const 短期借款 = sum(["2001"]);
  const 应付票据 = sum(["2201"]);
  const 应付账款 = sum(["2202"]);
  const 预收账款 = sum(["2203"]);
  const 应付职工薪酬 = sum(["2211"]);
  const 应交税费 = sum(["2221"]);
  const 其他应付款 = sum(["2231", "2232", "2241"]);
  const 长期借款 = sum(["2501", "2701"]);
  const 负债合计 = 短期借款 + 应付票据 + 应付账款 + 预收账款 + 应付职工薪酬 +
    应交税费 + 其他应付款 + 长期借款;

  const 实收资本 = sum(["3001", "3002"]);
  const 盈余公积 = sum(["3101"]);
  const 已分配利润 = sum(["3104"]);
  const 损益科目 = listAccounts(setId).filter((a) => a.category === "损益").map((a) => a.code);
  // 未分配利润 = 利润分配 + 本年利润(3103) + 尚未结转的本年损益
  // 尚未结转损益 = 贷方(收入) - 借方(成本费用) = -Σ(debit-credit)
  const 未结转损益 = -损益科目.reduce((s, c) => s + storedCents(bal.get(c)?.net ?? 0), 0n);
  const 本年利润 = sumByPrefixCents(cents, ["3103"]) + 未结转损益;
  const 未分配利润 = 已分配利润 + 本年利润;
  const 所有者权益合计 = 实收资本 + 盈余公积 + 未分配利润;

  const n = centsToNumber;
  return {
    period,
    assets: [
      { label: "货币资金", value: n(货币资金) },
      { label: "短期投资", value: n(短期投资) },
      { label: "应收票据", value: n(应收票据) },
      { label: "应收账款", value: n(应收账款) },
      { label: "预付账款", value: n(预付账款) },
      { label: "其他应收款", value: n(其他应收款) },
      { label: "存货", value: n(存货) },
      { label: "固定资产原价", value: n(固定资产原价) },
      { label: "减：累计折旧", value: n(累计折旧) },
      { label: "固定资产账面价值", value: n(固定资产) },
      { label: "在建工程", value: n(在建工程) },
      { label: "无形资产账面价值", value: n(无形资产) },
      { label: "长期待摊费用", value: n(长期待摊费用) },
      { label: "资产总计", value: n(资产合计), strong: true },
    ],
    liabilities: [
      { label: "短期借款", value: n(短期借款) },
      { label: "应付票据", value: n(应付票据) },
      { label: "应付账款", value: n(应付账款) },
      { label: "预收账款", value: n(预收账款) },
      { label: "应付职工薪酬", value: n(应付职工薪酬) },
      { label: "应交税费", value: n(应交税费) },
      { label: "其他应付款", value: n(其他应付款) },
      { label: "长期借款", value: n(长期借款) },
      { label: "负债合计", value: n(负债合计), strong: true },
      { label: "实收资本", value: n(实收资本) },
      { label: "盈余公积", value: n(盈余公积) },
      { label: "未分配利润", value: n(未分配利润) },
      { label: "所有者权益合计", value: n(所有者权益合计), strong: true },
      { label: "负债和所有者权益总计", value: n(负债合计 + 所有者权益合计), strong: true },
    ],
    totals: { assets: n(资产合计), liabilities: n(负债合计), equity: n(所有者权益合计) },
    balanced: 资产合计 === 负债合计 + 所有者权益合计,
  };
}

export function balanceSheet(setId, period) {
  const { profile, context } = accountSetProfile(setId);
  if (profile.legacy) {
    const partialValues = legacyBalancePartial(setId, period);
    const data = legacyBalanceSheet(setId, period);
    const reportStatus = legacyReportStatus("balance-sheet", partialValues);
    return {
      ...data,
      accountingContext: context,
      reportStatus,
      rows: [],
      reclassifications: [],
      unresolvedAmounts: [],
      diagnostics: reportStatus.diagnostics,
    };
  }
  const accounts = accountListDto(setId);
  const evaluation = evaluateAccountingStatement(profile.id, {
    kind: "balance-sheet",
    accounts,
    amounts: balanceAmounts(setId, period),
  });
  const valueOf = (row) => centsToNumber(BigInt(row.valueMinor));
  const assets = evaluation.rows
    .filter((row) => BS_ASSET_ROW_IDS.has(row.id))
    .map((row) => ({ id: row.id, label: row.label, value: valueOf(row) }));
  const liabilities = evaluation.rows
    .filter((row) => !BS_ASSET_ROW_IDS.has(row.id))
    .map((row) => ({ id: row.id, label: row.label, value: valueOf(row) }));
  const totals = {
    assets: centsToNumber(BigInt(evaluation.totals.assets)),
    liabilities: centsToNumber(BigInt(evaluation.totals.liabilities)),
    equity: centsToNumber(BigInt(evaluation.totals.equity)),
  };
  const reportStatus = profileReportStatus("balance-sheet", evaluation, { profile, context });
  // 平衡判断全程在整数分上完成（不经浮点 === 比较，也不用 epsilon 抹平真实差额）。
  const assetsMinor = BigInt(evaluation.totals.assets);
  const liabilitiesMinor = BigInt(evaluation.totals.liabilities);
  const equityMinor = BigInt(evaluation.totals.equity);
  return {
    period,
    accountingContext: context,
    reportStatus,
    rows: evaluation.rows.map((row) => ({ id: row.id, label: row.label, valueMinor: row.valueMinor })),
    reclassifications: evaluation.reclassifications,
    unresolvedAmounts: unresolvedAmountFacts("balance-sheet", evaluation),
    diagnostics: reportStatus.diagnostics,
    assets,
    liabilities,
    totals,
    balanced: assetsMinor === liabilitiesMinor + equityMinor,
  };
}

function legacyIncomeStatement(setId, period) {
  const s = getAccountSet(setId);
  const year = String(period).slice(0, 4);
  const ytdStart = s.start_period > `${year}-01` ? s.start_period : `${year}-01`;
  const plAccounts = listAccounts(setId).filter((a) => a.category === "损益");

  // 按科目名称/编码层级归集，兼容小企业(5xxx)与企业会计准则(6xxx)两套编码；
  // 明细科目（如 560201）按其顶层编码（5602）归类，而不是只看名称/尾号。
  const TAIL = {
    "001": "营业收入", "051": "营业收入", "111": "投资收益", "301": "营业外收入",
    "401": "营业成本", "402": "营业成本", "403": "税金及附加", "601": "销售费用",
    "602": "管理费用", "603": "财务费用", "711": "营业外支出", "801": "所得税费用",
  };
  const PL_PREFIX = [
    ["5001", "营业收入"], ["5051", "营业收入"], ["6001", "营业收入"], ["6051", "营业收入"],
    ["5401", "营业成本"], ["5402", "营业成本"], ["6401", "营业成本"], ["6402", "营业成本"],
    ["5403", "税金及附加"], ["6403", "税金及附加"],
    ["5601", "销售费用"], ["6601", "销售费用"],
    ["5602", "管理费用"], ["6602", "管理费用"],
    ["5603", "财务费用"], ["6603", "财务费用"],
    ["5111", "投资收益"], ["6111", "投资收益"],
    ["5301", "营业外收入"], ["6301", "营业外收入"],
    ["5711", "营业外支出"], ["6711", "营业外支出"],
    ["5801", "所得税费用"], ["6801", "所得税费用"],
  ];
  const lineOf = (a) => {
    const n = a.name || "";
    if (/主营业务收入|其他业务收入/.test(n)) return "营业收入";
    if (/主营业务成本|其他业务成本/.test(n)) return "营业成本";
    if (/税金及附加/.test(n)) return "税金及附加";
    if (/销售费用/.test(n)) return "销售费用";
    if (/管理费用/.test(n)) return "管理费用";
    if (/财务费用/.test(n)) return "财务费用";
    if (/投资收益/.test(n)) return "投资收益";
    if (/营业外收入/.test(n)) return "营业外收入";
    if (/营业外支出/.test(n)) return "营业外支出";
    if (/所得税费用/.test(n)) return "所得税费用";
    const byPrefix = PL_PREFIX.find(([p]) => underPrefix(a.code, p));
    if (byPrefix) return byPrefix[1];
    if (TAIL[String(a.code).slice(0, 4).slice(-3)]) return TAIL[String(a.code).slice(0, 4).slice(-3)];
    return a.direction === "credit" ? "其他收入" : "其他费用";
  };

  const build = (from, to) => {
    const acc = new Map();
    for (const a of plAccounts) {
      const v = naturalRangeCents(setId, [a.code], from, to);
      if (v === 0n) continue;
      const line = lineOf(a);
      acc.set(line, (acc.get(line) ?? 0n) + v);
    }
    const g = (k) => acc.get(k) ?? 0n;
    const 其他收入 = g("其他收入"), 其他费用 = g("其他费用");
    const 营业收入 = g("营业收入") + 其他收入;
    const 营业成本 = g("营业成本") + 其他费用;
    const 税金及附加 = g("税金及附加");
    const 销售费用 = g("销售费用");
    const 管理费用 = g("管理费用");
    const 财务费用 = g("财务费用");
    const 投资收益 = g("投资收益");
    const 营业利润 = 营业收入 - 营业成本 - 税金及附加 - 销售费用 - 管理费用 - 财务费用 + 投资收益;
    const 营业外收入 = g("营业外收入");
    const 营业外支出 = g("营业外支出");
    const 利润总额 = 营业利润 + 营业外收入 - 营业外支出;
    const 所得税费用 = g("所得税费用");
    const 净利润 = 利润总额 - 所得税费用;
    const n = centsToNumber;
    return {
      营业收入: n(营业收入), 营业成本: n(营业成本), 税金及附加: n(税金及附加),
      销售费用: n(销售费用), 管理费用: n(管理费用), 财务费用: n(财务费用), 投资收益: n(投资收益),
      其他收入: n(其他收入), 其他费用: n(其他费用), 营业利润: n(营业利润),
      营业外收入: n(营业外收入), 营业外支出: n(营业外支出), 利润总额: n(利润总额),
      所得税费用: n(所得税费用), 净利润: n(净利润),
    };
  };
  return { period, current: build(period, period), ytd: build(ytdStart, period) };
}

const INCOME_KEY_BY_ROW = {
  "operating-revenue": "营业收入",
  "operating-cost": "营业成本",
  "taxes-and-surcharges": "税金及附加",
  "selling-expense": "销售费用",
  "administrative-expense": "管理费用",
  "finance-expense": "财务费用",
  "investment-income": "投资收益",
  "operating-profit": "营业利润",
  "non-operating-income": "营业外收入",
  "non-operating-expense": "营业外支出",
  "total-profit": "利润总额",
  "income-tax-expense": "所得税费用",
  "net-profit": "净利润",
};
const INCOME_ZERO_KEYS = [
  "营业收入", "营业成本", "税金及附加", "销售费用", "管理费用", "财务费用", "投资收益",
  "其他收入", "其他费用", "营业利润", "营业外收入", "营业外支出", "利润总额", "所得税费用", "净利润",
];

function incomeDto(evaluation) {
  const out = Object.fromEntries(INCOME_ZERO_KEYS.map((key) => [key, 0]));
  for (const row of evaluation.rows) {
    const key = INCOME_KEY_BY_ROW[row.id];
    if (key) out[key] = centsToNumber(BigInt(row.valueMinor));
  }
  return out;
}

/**
 * 未进入任何报表行的金额事实（语义冲突 / 待明细 / 未映射 / 超出本表）。
 * 这些金额绝不写进报表行合计（不漂亮地归零，也不误分类）；保留为人工可核对的审计事实。
 */
function unresolvedAmountFacts(kind, evaluation) {
  const out = [];
  const index = new Map();
  for (const diagnostic of evaluation?.diagnostics ?? []) {
    if (!Number.isSafeInteger(diagnostic?.amountMinor)) continue;
    const accountCode = typeof diagnostic.accountCode === "string" ? diagnostic.accountCode : null;
    const matchedRoot = typeof diagnostic.matchedRoot === "string" ? diagnostic.matchedRoot : null;
    const key = `${accountCode ?? ""}|${matchedRoot ?? ""}|${diagnostic.amountMinor}`;
    let fact = index.get(key);
    if (!fact) {
      fact = {
        reportKind: kind,
        accountCode,
        ...(matchedRoot ? { matchedRoot } : {}),
        amountMinor: diagnostic.amountMinor,
        reasons: [],
      };
      index.set(key, fact);
      out.push(fact);
    }
    if (typeof diagnostic.code === "string" && !fact.reasons.includes(diagnostic.code)) {
      fact.reasons.push(diagnostic.code);
    }
  }
  return out;
}

function mergeReportStatuses(statusList) {
  const diagnostics = [];
  const seen = new Set();
  for (const status of statusList) {
    for (const diagnostic of status.diagnostics) {
      const key = `${diagnostic.code}|${diagnostic.accountCode ?? ""}|${diagnostic.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  const complete = statusList.every((status) => status.complete === true);
  return { status: complete ? "complete" : "incomplete", complete, partialValues: !complete, diagnostics };
}

/**
 * 利润表：新 profile 只取明确时间窗内、排除结转的已过账损益发生额；
 * 本期 = 所选期间，本年累计起点 = max(账套启用期间, 当年 1 月)。
 */
export function incomeStatement(setId, period) {
  const { profile, context } = accountSetProfile(setId);
  if (profile.legacy) {
    const data = legacyIncomeStatement(setId, period);
    const reportStatus = legacyReportStatus("income-statement", false);
    return {
      ...data,
      accountingContext: context,
      reportStatus,
      rows: { current: [], ytd: [] },
      unresolvedAmounts: { current: [], ytd: [] },
      diagnostics: reportStatus.diagnostics,
    };
  }
  const set = accountSetRow(setId);
  const year = String(period).slice(0, 4);
  const ytdStart = set.start_period > `${year}-01` ? set.start_period : `${year}-01`;
  const accounts = accountListDto(setId);
  const accountByCode = new Map(accounts.map((account) => [account.code, account]));
  // 不能用「库内 category === 损益」预过滤：被错误登记成资产 / 负债的收入会连同金额被一起丢掉，
  // 得到一张漂亮但错误的零表。按准则映射判断是否属于利润表范围；未映射编码不按声明类别静默丢弃
  // （交给纯规则给 account_unmapped + 金额事实）；现金 / 往来等只进资产负债表的发生额仍不进利润表。
  const inIncomeStatement = (item) => {
    const account = accountByCode.get(item.code);
    if (!account) return false;
    let resolved;
    try {
      resolved = resolveAccountingAccountRule(profile.id, account);
    } catch {
      // 科目元数据本身非法：不静默丢弃，交给纯规则给出明确错误 / 诊断。
      return true;
    }
    if (!resolved.matchedRoot) return true;
    if (resolved.statements.incomeStatement) return true;
    return resolved.statements.balanceSheet?.via === "undistributed-profit";
  };
  const evaluate = (fromPeriod, toPeriod) => evaluateAccountingStatement(profile.id, {
    kind: "income-statement",
    accounts,
    amounts: rangeAmounts(setId, fromPeriod, toPeriod).filter(inIncomeStatement),
  });
  const currentEvaluation = evaluate(period, period);
  const ytdEvaluation = evaluate(ytdStart, period);
  const reportStatus = mergeReportStatuses([
    profileReportStatus("income-statement", currentEvaluation, { profile, context }),
    profileReportStatus("income-statement", ytdEvaluation, { profile, context }),
  ]);
  return {
    period,
    accountingContext: context,
    reportStatus,
    rows: { current: currentEvaluation.rows, ytd: ytdEvaluation.rows },
    unresolvedAmounts: {
      current: unresolvedAmountFacts("income-statement", currentEvaluation),
      ytd: unresolvedAmountFacts("income-statement", ytdEvaluation),
    },
    diagnostics: reportStatus.diagnostics,
    current: incomeDto(currentEvaluation),
    ytd: incomeDto(ytdEvaluation),
  };
}

export function generalLedger(setId, code, period) {
  const s = getAccountSet(setId);
  const acc = row(`SELECT * FROM accounts WHERE account_set_id=? AND code=?`, setId, code);
  if (!acc) throw new Error("account_not_found");
  // 父科目明细账：若存在下级科目，一并纳入（保持返回结构不变，仍逐笔展示）。
  const children = rows(
    `SELECT code FROM accounts WHERE account_set_id=? AND code<>? AND code LIKE ? ORDER BY code`,
    setId, code, `${code}%`
  ).map((r) => r.code);
  const group = [code, ...children];
  const ph = group.map(() => "?").join(",");
  const openingRows = rows(
    `SELECT debit, credit FROM opening_balances WHERE account_set_id=? AND code IN (${ph})`,
    setId, ...group,
  );
  let running = openingRows.reduce(
    (s2, r) => s2 + storedCents(r.debit) - storedCents(r.credit), 0n,
  );
  const openingDebit = sumCents(openingRows.map((r) => r.debit));
  const openingCredit = sumCents(openingRows.map((r) => r.credit));
  const items = rows(
    `SELECT v.period, v.voucher_date, v.word, v.number, v.summary AS vsummary,
            e.summary, e.debit, e.credit, v.id AS voucher_id
       FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.account_set_id=? AND v.status='posted' AND v.period BETWEEN ? AND ?
        AND e.code IN (${ph})
      ORDER BY v.period, v.number, e.line_no`,
    setId, s.start_period, period, ...group
  ).map((it) => {
    running += storedCents(it.debit) - storedCents(it.credit);
    return { ...it, balance: centsToNumber(running) };
  });
  return {
    code, name: acc.name, direction: acc.direction, period,
    opening: { debit: centsToNumber(openingDebit), credit: centsToNumber(openingCredit) },
    items,
  };
}

// ================================================================ P1 能力

const pad2 = (n) => String(n).padStart(2, "0");
function lastDay(period) {
  const [y, m] = period.split("-").map(Number);
  return `${y}-${pad2(m)}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
}
function prevPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// ---------------------------------------------------------------- 期末结转损益
/**
 * 结转本期损益到 3103 本年利润；yearEnd=true 时再结转 3103 -> 3104。
 * 结转凭证 kind='carryforward'，不计入利润表发生额，避免重复计算。
 *
 * 规则：
 * - 已过账的损益结转凭证视为“本期已结转”，再次结转损益报 already_carried_forward；
 * - 已过账的 3103→3104 年末结转不允许重复，报 already_year_end_carried；
 * - 未过账（草稿）的旧结转凭证在重算时先删除，避免残留草稿再次过账造成重复；
 * - 反过账/删除后可重新结转（不会永久阻止重算）；
 * - 本期无损益但 3103 有余额时，yearEnd=true 仍可做年末结转；
 * - 年末结转与资产负债表口径一致：3103 及其下级明细逐个转出到 3104，不遗漏明细；
 * - 期间登记（ensurePeriod）在保存点内执行，失败不留下新建的空期间。
 */
export function carryForwardProfit(setId, period, { yearEnd = false } = {}) {
  const { profile, roles } = accountSetProfile(setId);
  const p = requirePeriod(period);
  if (periodStatus(setId, p) === "closed") throw new Error("period_closed");
  // 本年利润 / 利润分配按 profile 角色解析：小企 / legacy 3103→3104，企业 4103→4104。
  requireRoleAccounts(setId, profile, ["currentYearProfit", "profitDistribution"]);
  const profitRoot = roles.currentYearProfit;
  const retainedRoot = roles.profitDistribution;
  // 参与结转的已有科目行必须与准则映射语义一致（类别 / 方向 / 备抵）：
  // 写前整体拒绝，不靠被污染的库元数据算 natural，也不在提交后再补一行掩盖。
  const semanticsConflicts = carryForwardSemanticsConflicts(db, setId, profile, roles, p, { yearEnd });
  if (semanticsConflicts.length) {
    throw profileError("carryforward_account_semantics_conflict", "参与结转的科目与准则 profile 语义冲突", {
      period: p, yearEnd: yearEnd === true, conflicts: semanticsConflicts,
    });
  }

  const plCodes = new Set(listAccounts(setId).filter((x) => x.category === "损益").map((x) => x.code));
  const isProfitCarry = (v) => v.entries.some((e) => plCodes.has(e.code));
  const carries = listVouchers(setId, { period: p }).filter((v) => v.kind === "carryforward");
  const plCarries = carries.filter(isProfitCarry);
  const yearEndCarries = carries.filter((v) => !isProfitCarry(v));
  const postedPL = plCarries.some((v) => v.status === "posted");
  const postedYE = yearEndCarries.some((v) => v.status === "posted");
  // 前期可改性：更晚期间已封账 / 已有年末结转 / 已有依赖累计损益的普通结转时，
  // 不允许静默改动本期派生凭证。
  assertPeriodMutable(db, setId, p, { operation: "carry_forward_profit", touches: { profit: true } });
  if (postedPL && !yearEnd) {
    // 不能仅按「曾经执行过」放行：若结转后又有损益分录，旧结转已失效，必须明确指出。
    const bal = accountBalances(setId, p);
    const residual = listAccounts(setId)
      .filter((a) => a.category === "损益")
      .map((a) => ({ code: a.code, name: a.name, balance: bal.get(a.code)?.natural ?? 0 }))
      .filter((x) => storedCents(x.balance) !== 0n);
    if (residual.length) {
      const err = new Error("carryforward_stale");
      err.code = "carryforward_stale";
      err.details = {
        period: p,
        voucherIds: plCarries.filter((v) => v.status === "posted").map((v) => v.id),
        residual,
        guidance: "先反过账本期旧结转凭证（再按需重新结转），不能直接重复结转或封账",
      };
      throw err;
    }
    throw new Error("already_carried_forward");
  }
  if (postedYE && yearEnd) throw new Error("already_year_end_carried");

  return withSavepoint(() => {
    // 期间登记纳入同一保存点：后续任一步失败都不留下新建的空期间。
    ensurePeriod(setId, p);
    // 先清掉可能残留的草稿结转凭证（含被反过账的），避免其日后过账造成重复入账。
    for (const v of [...plCarries, ...yearEndCarries]) {
      if (v.status !== "posted") deleteVoucherRow(setId, v.id);
    }

    // ---- 1. 结转本期损益到 profile 的本年利润角色 ----
    let voucher = null;
    let revenueCents = 0n, expenseCents = 0n, profitCents = 0n;
    if (!postedPL) {
      const bal = accountBalances(setId, p);
      const entries = [];
      // 方向取准则映射的权威语义（已在上方校验过一致），不直接用库内 direction 推定。
      for (const a of listAccounts(setId)) {
        const semantics = accountProfileSemantics(profile, a);
        const incomeStatementAccount = a.category === "损益" || semantics.effective?.category === "损益";
        if (!incomeStatementAccount) continue;
        const direction = semantics.effective?.direction ?? a.direction;
        const netCents = storedCents(bal.get(a.code)?.net ?? 0);
        const natural = direction === "credit" ? -netCents : netCents;
        if (natural === 0n) continue;
        // 按余额符号生成相反的合法分录，绝不写负数金额。
        if (direction === "credit") {
          revenueCents += natural;
          entries.push(natural > 0n
            ? { code: a.code, summary: "结转本期损益", debit: centsToNumber(natural), credit: 0 }
            : { code: a.code, summary: "结转本期损益", debit: 0, credit: centsToNumber(-natural) });
        } else {
          expenseCents += natural;
          entries.push(natural > 0n
            ? { code: a.code, summary: "结转本期损益", debit: 0, credit: centsToNumber(natural) }
            : { code: a.code, summary: "结转本期损益", debit: centsToNumber(-natural), credit: 0 });
        }
      }
      if (entries.length) {
        profitCents = revenueCents - expenseCents;
        // 利润为 0 时不加本年利润零金额行（借贷已自然平衡）。
        if (profitCents > 0n) entries.push({ code: profitRoot, summary: "结转本期损益", debit: 0, credit: centsToNumber(profitCents) });
        else if (profitCents < 0n) entries.push({ code: profitRoot, summary: "结转本期损益", debit: centsToNumber(-profitCents), credit: 0 });
        voucher = createVoucher(setId, {
          period: p, voucher_date: lastDay(p), summary: "结转本期损益",
          kind: "carryforward", status: "posted", entries,
        });
      }
    }

    // ---- 2. 年末结转：本年利润角色 → 利润分配角色（本期无损益但本年利润有余额也可执行）----
    // 与资产负债表口径一致：按本年利润前缀（含下级明细）逐个科目转出，不静默只取根余额。
    let yearEndVoucher = null;
    if (yearEnd && !postedYE) {
      const bal = accountBalances(setId, p);
      const lines = [];
      for (const [code, b] of bal) {
        if (!underPrefix(code, profitRoot)) continue;
        // 参与年末结转的明细方向同样取准则映射的权威语义，不盲信库内 direction。
        const semantics = accountProfileSemantics(profile, b);
        const direction = semantics.effective?.direction ?? b.direction;
        const netCents = storedCents(b.net);
        const natural = direction === "credit" ? -netCents : netCents;
        if (natural === 0n) continue;
        lines.push({ code, natural });
      }
      if (lines.length) {
        const total = lines.reduce((s, l) => s + l.natural, 0n);
        const es = [];
        for (const l of lines) {
          if (l.natural > 0n) es.push({ code: l.code, debit: centsToNumber(l.natural), credit: 0, summary: "结转本年利润" });
          else es.push({ code: l.code, debit: 0, credit: centsToNumber(-l.natural), summary: "结转本年利润" });
        }
        // 明细互抵后净额为零时，不需要利润分配对账行，分录本身已平衡。
        if (total > 0n) es.push({ code: retainedRoot, debit: 0, credit: centsToNumber(total), summary: "结转本年利润" });
        else if (total < 0n) es.push({ code: retainedRoot, debit: centsToNumber(-total), credit: 0, summary: "结转本年利润" });
        yearEndVoucher = createVoucher(setId, {
          period: p, voucher_date: lastDay(p), summary: "结转本年利润",
          kind: "carryforward", status: "posted", entries: es,
        });
      }
    }
    return {
      voucher, yearEndVoucher,
      revenue: centsToNumber(revenueCents),
      expense: centsToNumber(expenseCents),
      profit: centsToNumber(profitCents),
    };
  });
}

// ---------------------------------------------------------------- 资产卡片
const ASSET_LEDGER_STATUS = new Set(["booked", "pending_purchase_voucher"]);
const ASSET_ORIGINS = new Set(["purchase", "supplement", "import"]);
const CARD_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 卡片累计已提 = 补项期初累计 + 已过账计提（反过账后自动减少）。 */
function cardAccumulatedCents(card) {
  const posted = rows(
    `SELECT r.amount FROM asset_depreciation_runs r JOIN vouchers v ON v.id=r.voucher_id
      WHERE r.asset_id=? AND v.status='posted'`, card.id,
  );
  return storedCents(card.opening_accumulated ?? 0) + sumCents(posted.map((r) => r.amount));
}

function cardDto(card) {
  const money = cardMoney(card);
  const accumulatedCents = cardAccumulatedCents(card);
  const monthsDone = row(
    `SELECT COUNT(*) n FROM asset_depreciation_runs r JOIN vouchers v ON v.id=r.voucher_id
      WHERE r.asset_id=? AND v.status='posted'`, card.id).n;
  return {
    ...card,
    original_cost: centsToNumber(money.originalCents),
    residual_rate: Number(card.residual_rate),
    opening_accumulated: centsToNumber(storedCents(card.opening_accumulated ?? 0)),
    acquired_period: card.acquired_period ?? null,
    ledger_status: card.ledger_status ?? "booked",
    ledger_note: card.ledger_note ?? "",
    origin: card.origin ?? "purchase",
    depreciable: centsToNumber(money.depreciableCents),
    monthly: centsToNumber(money.monthlyCents),
    final_month: centsToNumber(money.finalMonthCents),
    accumulated: centsToNumber(accumulatedCents),
    remaining: centsToNumber(money.depreciableCents - accumulatedCents),
    months_done: monthsDone,
  };
}

export function listAssetCards(setId) {
  getAccountSet(setId);
  // 卡片列表展示的是「迄今」状态：accumulated / months_done 统计全部已过账计提（+ 显式补项期初累计）。
  // 需要某个历史期间的计提状态时请用期末检查（assetCardPeriodStatus），那里按期间口径计算。
  return rows(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`, setId).map(cardDto);
}

/** 校验卡片可选补项字段（取得期间 / 期初累计 / 未入账登记）。 */
function cardSupplementFields(c = {}, { kind, depreciableCents } = {}) {
  const acquired = c.acquired_period === undefined || c.acquired_period === null || c.acquired_period === ""
    ? null : String(c.acquired_period).trim();
  if (acquired !== null && !CARD_PERIOD_RE.test(acquired)) throw new Error("acquired_period_invalid");
  const opening = parseMoney(c.opening_accumulated, {
    label: "期初累计", allowNegative: false, maxCents: MAX_ABSOLUTE_CENTS,
  });
  if (!opening.ok) throw new Error("opening_accumulated_invalid");
  if (opening.subCent) throw new Error("opening_accumulated_invalid");
  if (depreciableCents !== undefined && opening.cents > depreciableCents) throw new Error("opening_accumulated_exceeds_depreciable");
  const ledgerStatus = c.ledger_status === undefined || c.ledger_status === null || c.ledger_status === ""
    ? (kind === "supplement" ? "pending_purchase_voucher" : "booked")
    : String(c.ledger_status).trim();
  if (!ASSET_LEDGER_STATUS.has(ledgerStatus)) throw new Error("ledger_status_invalid");
  const ledgerNote = String(c.ledger_note ?? "").trim();
  if (ledgerStatus !== "booked" && !ledgerNote) throw new Error("ledger_note_required");
  const origin = c.origin === undefined || c.origin === null || c.origin === ""
    ? (c.ledger_status === "pending_purchase_voucher" ? "supplement" : "purchase")
    : String(c.origin).trim();
  if (!ASSET_ORIGINS.has(origin)) throw new Error("asset_origin_invalid");
  return { acquired, openingCents: opening.cents, ledgerStatus, ledgerNote, origin };
}

/**
 * 卡片计提期数的**技术 / 产品输入边界**（不是“法定会计寿命”）：
 * 只接受 1 ~ MAX_SCHEDULE_PERIODS（1200 期 = 100 年）的整数。
 * 这样既能拦住 2^32 这类会把分摊 / DTO 计算推入不可控规模的输入（避免落库后才在分期 / 列表里抛错），
 * 也保留实际业务所需的长寿命；真实会计寿命仍由操作者按准则判断。
 */
function requireUsefulLifeMonths(raw) {
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    const err = new Error("useful_life_months_invalid");
    err.details = { value: raw ?? null, expected: `1 ~ ${MAX_SCHEDULE_PERIODS} 的整数期数` };
    throw err;
  }
  if (value > MAX_SCHEDULE_PERIODS) {
    const err = new Error("useful_life_months_out_of_range");
    err.details = {
      value, max: MAX_SCHEDULE_PERIODS,
      note: "技术输入边界（不冒充法定会计期限）：期数过大会让分摊 / DTO 计算不可控",
    };
    throw err;
  }
  return value;
}

export function addAssetCard(setId, c = {}) {
  const { profile, roles } = accountSetProfile(setId);
  const kind = c.kind === "intangible" ? "intangible" : "fixed";
  const name = String(c.name || "").trim();
  const cost = parseMoney(c.original_cost, { label: "资产原值" });
  const life = requireUsefulLifeMonths(c.useful_life_months);
  if (!name) throw new Error("name_required");
  if (!cost.ok || cost.cents <= 0n) throw new Error("original_cost_invalid");
  const start_period = String(c.start_period || "");
  if (!CARD_PERIOD_RE.test(start_period)) throw new Error("start_period_invalid");
  const residual = c.residual_rate === undefined ? (kind === "fixed" ? 0.05 : 0) : Number(c.residual_rate);
  if (!Number.isFinite(residual) || residual < 0 || residual >= 1) throw new Error("residual_rate_invalid");
  // 默认资产 / 累计 / 费用科目按 profile 角色：小企与 legacy 管理费用 5602，企业 6602。
  const defaultAsset = kind === "fixed" ? roles.fixedAsset : roles.intangibleAsset;
  const defaultAccum = kind === "fixed" ? roles.accumulatedDepreciation : roles.accumulatedAmortization;
  const asset_account = c.asset_account || defaultAsset;
  const accum_account = c.accum_account || defaultAccum;
  const expense_account = c.expense_account || roles.defaultDepreciationExpense;
  for (const code of [asset_account, accum_account, expense_account]) {
    if (!row(`SELECT 1 FROM accounts WHERE account_set_id=? AND code=?`, setId, code))
      throw new Error(`account_not_found:${code}`);
  }
  const residualCents = mulCentsByRatio(cost.cents, residual);
  const supplement = cardSupplementFields(c, { kind, depreciableCents: cost.cents - residualCents });
  const nextCard = {
    kind, name, original_cost: centsToNumber(cost.cents), residual_rate: residual,
    useful_life_months: life, start_period,
    asset_account, accum_account, expense_account,
    acquired_period: supplement.acquired,
    opening_accumulated: centsToNumber(supplement.openingCents),
    ledger_status: supplement.ledgerStatus, ledger_note: supplement.ledgerNote, origin: supplement.origin,
  };
  // 新增卡片会改变受影响期间的资产核对 / 计提事实：已封账 / 已过账派生凭证先拒绝并给撤销顺序。
  assertAssetCardWriteAllowed(db, setId, { operation: "add_asset_card", previous: null, next: nextCard });
  // 落库与 DTO 构造在同一保存点内：任何后续计算（分期 / 累计 / 核对）失败都必须完整回滚，
  // 绝不留下“卡片已持久化但列表 / 期末检查持续报错”的半成品。
  return withSavepoint(() => {
    const info = run(
      `INSERT INTO asset_cards (account_set_id, kind, name, original_cost, residual_rate, useful_life_months,
         start_period, asset_account, accum_account, expense_account, created_at,
         acquired_period, opening_accumulated, ledger_status, ledger_note, origin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      setId, kind, name, centsToNumber(cost.cents), residual, life, start_period, asset_account, accum_account,
      expense_account, now(), supplement.acquired, centsToNumber(supplement.openingCents),
      supplement.ledgerStatus, supplement.ledgerNote, supplement.origin,
    );
    return cardDto(row(
      `SELECT * FROM asset_cards WHERE account_set_id=? AND id=?`, setId, Number(info.lastInsertRowid),
    ));
  });
}

/**
 * 资产卡片维护 / 补项入口（本机合法可用的解除阻塞手段）：
 * 可改显示信息、费用科目、取得期间、期初累计与「未入账」登记；
 * 事实变更按实际影响守卫：已封账期间（`asset_card_affects_closed_period`）、
 * 已有已过账计提时的金额字段（`asset_card_locked_by_posted_runs`）、
 * 后续已过账普通损益结转（`later_profit_carryforward_depends_on_period`）。
 */
export function updateAssetCard(setId, id, patch = {}) {
  getAccountSet(setId);
  const card = row(`SELECT * FROM asset_cards WHERE account_set_id=? AND id=?`, setId, id);
  if (!card) throw new Error("asset_not_found");
  const next = { ...card };
  if (patch.name !== undefined) {
    const name = String(patch.name || "").trim();
    if (!name) throw new Error("name_required");
    next.name = name;
  }
  if (patch.expense_account !== undefined) {
    const code = String(patch.expense_account);
    if (!row(`SELECT 1 FROM accounts WHERE account_set_id=? AND code=?`, setId, code))
      throw new Error(`account_not_found:${code}`);
    next.expense_account = code;
  }
  if (patch.asset_account !== undefined || patch.accum_account !== undefined) {
    for (const key of ["asset_account", "accum_account"]) {
      if (patch[key] === undefined) continue;
      const code = String(patch[key]);
      if (!row(`SELECT 1 FROM accounts WHERE account_set_id=? AND code=?`, setId, code))
        throw new Error(`account_not_found:${code}`);
      next[key] = code;
    }
  }
  if (patch.original_cost !== undefined) {
    const cost = parseMoney(patch.original_cost, { label: "资产原值" });
    if (!cost.ok || cost.cents <= 0n) throw new Error("original_cost_invalid");
    next.original_cost = centsToNumber(cost.cents);
  }
  if (patch.residual_rate !== undefined) {
    const residual = Number(patch.residual_rate);
    if (!Number.isFinite(residual) || residual < 0 || residual >= 1) throw new Error("residual_rate_invalid");
    next.residual_rate = residual;
  }
  if (patch.useful_life_months !== undefined) {
    next.useful_life_months = requireUsefulLifeMonths(patch.useful_life_months);
  }
  if (patch.start_period !== undefined) {
    const p = String(patch.start_period);
    if (!CARD_PERIOD_RE.test(p)) throw new Error("start_period_invalid");
    next.start_period = p;
  }
  const nextMoney = cardMoney(next);
  const supplement = cardSupplementFields(
    { ...next, ...patch },
    { kind: next.kind, depreciableCents: nextMoney.depreciableCents },
  );
  next.acquired_period = supplement.acquired;
  next.opening_accumulated = centsToNumber(supplement.openingCents);
  next.ledger_status = supplement.ledgerStatus;
  next.ledger_note = supplement.ledgerNote;
  next.origin = supplement.origin;
  // 拒绝时数据库完全不变；guidance 给出可执行撤销 / 重算顺序。
  assertAssetCardWriteAllowed(db, setId, { operation: "update_asset_card", previous: card, next });
  // 写入与 DTO 构造同一保存点：后续计算失败必须回滚，不留下字段已改但列表 / 检查报错的半成品。
  return withSavepoint(() => {
    run(
      `UPDATE asset_cards SET name=?, original_cost=?, residual_rate=?, useful_life_months=?, start_period=?,
         asset_account=?, accum_account=?, expense_account=?, acquired_period=?, opening_accumulated=?,
         ledger_status=?, ledger_note=?, origin=? WHERE account_set_id=? AND id=?`,
      next.name, next.original_cost, next.residual_rate, next.useful_life_months, next.start_period,
      next.asset_account, next.accum_account, next.expense_account, next.acquired_period,
      next.opening_accumulated, next.ledger_status, next.ledger_note, next.origin,
      setId, id,
    );
    return cardDto(row(`SELECT * FROM asset_cards WHERE account_set_id=? AND id=?`, setId, id));
  });
}

export function deleteAssetCard(setId, id) {
  getAccountSet(setId);
  const card = row(`SELECT * FROM asset_cards WHERE account_set_id=? AND id=?`, setId, id);
  if (!card) throw new Error("asset_not_found");
  const used = row(`SELECT COUNT(*) n FROM asset_depreciation_runs WHERE account_set_id=? AND asset_id=?`, setId, id).n;
  // 删除同样会改变受影响期间的资产核对 / 计提事实：先过期间守卫，再报已计提依赖。
  assertAssetCardWriteAllowed(db, setId, { operation: "delete_asset_card", previous: card, next: null });
  if (used) throw new Error("asset_has_depreciation_runs");
  run(`DELETE FROM asset_cards WHERE account_set_id=? AND id=?`, setId, id);
  return { deleted: id };
}

export function listDepreciationRuns(setId, { period } = {}) {
  getAccountSet(setId);
  const where = ["account_set_id=?"]; const args = [setId];
  if (period) { where.push("period=?"); args.push(period); }
  return rows(`SELECT * FROM asset_depreciation_runs WHERE ${where.join(" AND ")} ORDER BY period DESC, id`, ...args);
}

// ---------------------------------------------------------------- 折旧/摊销计提
/**
 * 按直线法对全部资产卡计提指定期间折旧/摊销，生成一张凭证并记录 runs。
 * - 累计已提只认「已过账」计提：反过账后累计自动减少，重新过账恢复；
 * - 同一期间已过账的计提视为幂等，跳过；
 * - 同一期间存在未过账的计提（残留草稿/孤儿 run）时明确拒绝，
 *   要求先删除或恢复该草稿，绝不与残留草稿双重入账；
 * - 凭证 + runs 在一个保存点内原子写入，失败全回滚。
 */
export function generateDepreciation(setId, period) {
  getAccountSet(setId);
  const p = requirePeriod(period);
  if (periodStatus(setId, p) === "closed") throw new Error("period_closed");
  // 计提写入口：新增本期计提会改变损益（折旧费用）→ 后续已过账普通结转会失效，必须拒绝。
  // 注意：**补录 / 生成**前期计提不列入「后期计提依赖」守卫——分期表按期间序号决定金额，
  // 补录前期不会改写后期已过账金额；总额是否超可计提由下面的全局总额守卫单独判定。
  // 而反过账 / 删除 / 重过账已有计提凭证仍走 touches.depreciation（会破坏后期依赖）。
  assertPeriodMutable(db, setId, p, {
    operation: "generate_depreciation", touches: { profit: true },
  });
  return withSavepoint(() => {
    ensurePeriod(setId, p);
    // 同期存在未过账的 run 时明确拒绝，避免与残留草稿双重入账。
    const residual = row(
      `SELECT COUNT(*) n FROM asset_depreciation_runs r
         LEFT JOIN vouchers v ON v.id=r.voucher_id
        WHERE r.account_set_id=? AND r.period=? AND (v.id IS NULL OR v.status<>'posted')`,
      setId, p).n;
    if (residual > 0) throw new Error("depreciation_draft_exists");

    const cards = rows(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`, setId);
    const entries = [];
    const pending = [];
    const skipped = [];
    const ledgerPending = [];
    const stale = [];
    const overDepreciable = [];
    for (const c of cards) {
      const money = cardMoney(c);
      // 分期表 + 期间口径剩余额双重限制：
      //  - 分期表保证寿命内恰好提足、不提前多提；
      //  - 期间口径保证前期重算不被后期已计提污染。
      // 全局累计（含旧库后期 run）只在下面作**执行守卫**：超出可计提额则明确拒绝并给撤销顺序，
      // 不用它去截断历史应提额（那会把后期计提提前塞进前期，掩盖实际超提）。
      const status = assetCardPeriodStatus(db, c, p, money);
      if (status.status === "ledger_pending") {
        ledgerPending.push({ assetId: c.id, name: c.name, ledgerStatus: status.ledgerStatus });
        continue;
      }
      // 旧定义下的已过账计提（例如反过账后改了寿命 / 原值 / 期间，旧凭证又被写回过账状态）：
      // 不能当成“本期已计提完成”放行，也不能静默补提，必须明确要求撤销重算。
      if (status.status === "posted_stale") {
        stale.push({
          assetId: c.id,
          name: c.name,
          recordedAmount: centsToNumber(status.amountCents),
          expectedAmount: centsToNumber(status.expectedCents),
          reason: status.reason ?? null,
        });
        continue;
      }
      if (status.status !== "due") {
        skipped.push({ assetId: c.id, name: c.name, status: status.status, reason: status.reason ?? null });
        continue;
      }
      if (status.amountCents <= 0n) {
        skipped.push({ assetId: c.id, name: c.name, status: "fully_depreciated", reason: "已提足" });
        continue;
      }
      // 执行时总额守卫：全局已提（含后期 / 旧库多提）+ 本期应提 不得超可计提额。
      if (status.globalAccumulatedCents + status.amountCents > money.depreciableCents) {
        overDepreciable.push({
          assetId: c.id,
          name: c.name,
          depreciable: centsToNumber(money.depreciableCents),
          globalAccumulated: centsToNumber(status.globalAccumulatedCents),
          dueAmount: centsToNumber(status.amountCents),
        });
        continue;
      }
      const amount = centsToNumber(status.amountCents);
      const label = c.kind === "fixed" ? "折旧" : "摊销";
      entries.push({ code: c.expense_account, summary: `计提${label}-${c.name}`, debit: amount, credit: 0 });
      entries.push({ code: c.accum_account, summary: `计提${label}-${c.name}`, debit: 0, credit: amount });
      pending.push({ asset_id: c.id, amount });
    }
    // 先做完整阻断判定，再写入任何凭证 / run：部分卡应提与部分卡未入账混在一起时
    // 不得“先把能提的提了”，否则会留下未入账资产上的不成立的派生分录。
    if (ledgerPending.length) {
      const err = new Error("asset_ledger_pending");
      err.code = "asset_ledger_pending";
      err.details = {
        period: p,
        assets: ledgerPending,
        guidance: "卡片登记为尚未入固定资产账（登记本身不是入账证据）：请先补录真实购入 / 期初入账凭证、核对卡片原值与总账一致并把卡片改为 booked，再计提",
      };
      throw err;
    }
    if (stale.length) {
      const err = new Error("depreciation_run_stale");
      err.code = "depreciation_run_stale";
      err.details = {
        period: p,
        assets: stale,
        guidance: "本期已过账计提与卡片当前定义（原值 / 残值 / 寿命 / 期间 / 期初累计 / 账簿状态 / 科目）不一致：请反过账并删除该计提凭证，按当前定义重新计提；不接受旧草稿直接重过账",
      };
      throw err;
    }
    if (overDepreciable.length) {
      const err = new Error("depreciation_global_over_depreciable");
      err.code = "depreciation_global_over_depreciable";
      err.details = {
        period: p,
        assets: overDepreciable,
        guidance: "全局已提（含后期 / 旧库多提计提）+ 本期应提已超过可计提额：请按倒序反过账并删除后期多提的计提凭证，再按期间顺序重新计提（历史应提额不被全局余额篡改）",
      };
      throw err;
    }
    if (!entries.length) {
      return { voucher: null, runs: [], skipped, note: "本期无需计提（卡片尚未取得 / 未到计提期 / 已提足或按分取整为 0）" };
    }
    const voucher = createVoucher(setId, {
      period: p, voucher_date: lastDay(p), summary: "计提折旧与摊销",
      kind: "depreciation", status: "posted", entries,
    }, { touches: { profit: true } });
    const ins = db.prepare(
      `INSERT INTO asset_depreciation_runs (account_set_id, asset_id, period, amount, voucher_id, created_at)
       VALUES (?,?,?,?,?,?)`
    );
    for (const item of pending) ins.run(setId, item.asset_id, p, item.amount, voucher.id, now());
    return { voucher, runs: pending, skipped };
  });
}

// ---------------------------------------------------------------- 现金流量表
/**
 * 现金流量表：以货币资金科目的对方科目分类（经营/投资/筹资），
 * 并附「净利润 -> 经营活动净额」的间接法补充资料。
 */
export function legacyCashFlowStatement(setId, period) {
  getAccountSet(setId);
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) throw new Error("period_invalid");
  // 货币资金及其下级明细（如 100201 银行明细）均为现金科目。
  const CASH_PREFIX = ["1001", "1002", "1012"];
  const isCash = (code) => codeUnderAny(code, CASH_PREFIX);
  const classify = (code) => {
    if (/^(1101|1501|1511|1601|1602|1604|1606|1701|1702|1801)/.test(code)) return "investing";
    if (/^(2001|2231|2232|2501|2701|3001|3002|3101|3103|3104)/.test(code)) return "financing";
    return "operating";
  };
  const names = new Map(listAccounts(setId).map((a) => [a.code, a.name]));
  const bucket = { operating: new Map(), investing: new Map(), financing: new Map() };
  const addBucket = (cat, code, cents) => bucket[cat].set(code, (bucket[cat].get(code) || 0n) + cents);

  for (const v of rows(
    `SELECT id FROM vouchers WHERE account_set_id=? AND status='posted' AND kind<>'carryforward' AND period=?`,
    setId, period)) {
    const es = rows(`SELECT code, debit, credit FROM voucher_entries WHERE voucher_id=?`, v.id);
    let cashDelta = 0n;
    const others = [];
    for (const e of es) {
      const debit = storedCents(e.debit), credit = storedCents(e.credit);
      if (isCash(e.code)) cashDelta += debit - credit;
      else others.push({ code: e.code, mag: (debit < 0n ? -debit : debit) + (credit < 0n ? -credit : credit) });
    }
    if (cashDelta === 0n) continue;
    const othersMag = others.reduce((s, e) => s + e.mag, 0n);
    if (othersMag === 0n) continue;
    // 按对方科目金额比例分摊：逐项 HALF_UP 到分，余数补给最后一项，
    // 保证本张凭证分摊合计 = 现金变动（否则报表会出现永远对不上的尾差）。
    let allocated = 0n;
    for (let i = 0; i < others.length; i += 1) {
      const e = others[i];
      const part = i === others.length - 1
        ? cashDelta - allocated
        : mulDivCents(cashDelta, e.mag, othersMag);
      allocated += part;
      addBucket(classify(e.code), e.code, part);
    }
  }

  const toLines = (cat) => [...bucket[cat].entries()]
    .filter(([, v]) => v !== 0n)
    .map(([code, value]) => ({ code, name: names.get(code) || code, value: centsToNumber(value) }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const operating = toLines("operating"), investing = toLines("investing"), financing = toLines("financing");
  const sumC = (a) => a.reduce((s, l) => s + storedCents(l.value), 0n);
  const opTCents = sumC(operating), inTCents = sumC(investing), fiTCents = sumC(financing);
  const netCents = opTCents + inTCents + fiTCents;

  const balEnd = centsView(accountBalances(setId, period));
  const balBegin = centsView(accountBalances(setId, prevPeriod(period)));
  const cashAt = (bal) => sumByPrefixCents(bal, CASH_PREFIX);
  const cashBeginCents = cashAt(balBegin), cashEndCents = cashAt(balEnd);

  const is = incomeStatement(setId, period);
  // 折旧/摊销只认已过账凭证，且含累计折旧/摊销的下级明细。
  const dep = sumCents(rows(
    `SELECT e.credit FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.account_set_id=? AND v.status='posted' AND v.kind<>'carryforward' AND v.period=?
        AND (e.code LIKE '1602%' OR e.code LIKE '1702%')`, setId, period,
  ).map((r) => r.credit));
  const RECV = ["1121", "1122", "1123", "1131", "1132", "1221"];
  const INV = ["1401", "1402", "1403", "1405", "1408", "1411"];
  const PAY = ["2201", "2202", "2203", "2211", "2221", "2231", "2232", "2241"];
  const dRecvCents = sumByPrefixCents(balEnd, RECV) - sumByPrefixCents(balBegin, RECV);
  const dInvCents = sumByPrefixCents(balEnd, INV) - sumByPrefixCents(balBegin, INV);
  const dPayCents = sumByPrefixCents(balEnd, PAY) - sumByPrefixCents(balBegin, PAY);
  const n = centsToNumber;

  return {
    period, method: "直接法（按对方科目分类）",
    operating, investing, financing,
    totals: {
      operating: n(opTCents), investing: n(inTCents), financing: n(fiTCents), net_increase: n(netCents),
    },
    cash: { begin: n(cashBeginCents), end: n(cashEndCents), change: n(cashEndCents - cashBeginCents) },
    reconciles: netCents === cashEndCents - cashBeginCents,
    supplement_indirect: {
      净利润: is.current["净利润"],
      加_折旧与摊销: n(dep),
      减_经营性应收的增加: n(dRecvCents),
      减_存货的增加: n(dInvCents),
      加_经营性应付的增加: n(dPayCents),
      经营活动产生的现金流量净额: n(opTCents),
    },
  };
}

/**
 * 现金流量表：新 profile 按「该方向唯一非现金对方科目」分类基础现金凭证。
 * - 现金流入 = 现金科目借方合计、现金流出 = 现金科目贷方合计，同一凭证双向时分别保留 gross；
 * - 内部划转金额的可行区间唯一时才按非现金对方分类；配对不唯一时保留双向 gross 与歧义诊断；
 * - 该方向有多个非现金对方科目时不按比例分摊、不猜现金等价物 / 受限资金，
 *   给 cash_flow_classification_incomplete 并保留可核对金额（unknown[].value），
 *   不把未分类金额伪装成经营 / 投资 / 筹资，也不用净额 0 消除诊断。
 * 旧账套（legacy）仍走旧兼容计算（完整性由 legacy_profile_compatibility 单独表达）。
 */
export function cashFlowStatement(setId, period) {
  const { set, profile, roles, context } = accountSetProfile(setId);
  if (profile.legacy) {
    const data = legacyCashFlowStatement(setId, period);
    const reportStatus = legacyReportStatus("cash-flow-statement", false);
    return {
      ...data,
      accountingContext: context,
      reportStatus,
      diagnostics: reportStatus.diagnostics,
      unknown: [],
      classificationComplete: true,
    };
  }
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) throw new Error("period_invalid");
  const accounts = accountListDto(setId);
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const names = new Map(accounts.map((account) => [account.code, account.name]));
  const cashRoots = roles.cashRoots;
  const isCash = (code) => codeUnderAny(code, cashRoots);
  const bucket = { operating: new Map(), investing: new Map(), financing: new Map() };
  const addBucket = (category, code, cents) =>
    bucket[category].set(code, (bucket[category].get(code) || 0n) + cents);
  const unknown = [];
  // 参与本期现金 gross 的现金细目（含双向、内部划转），用于后文准则语义校验。
  const cashParticipantCodes = new Set();

  for (const voucher of rows(
    `SELECT id FROM vouchers WHERE account_set_id=? AND status='posted' AND kind<>'carryforward' AND period=?`,
    setId, period,
  )) {
    const entries = rows(`SELECT code, debit, credit FROM voucher_entries WHERE voucher_id=?`, voucher.id);
    // 现金流入 = 现金科目借方合计，现金流出 = 现金科目贷方合计。
    // 同一凭证可能同时有流入和流出（现金内部划转 / 合并记账），不能先按净额相消而丢掉 gross 双向。
    let inflow = 0n;
    let outflow = 0n;
    const debitCounterparties = new Map();
    const creditCounterparties = new Map();
    for (const entry of entries) {
      const debit = storedCents(entry.debit);
      const credit = storedCents(entry.credit);
      if (isCash(entry.code)) {
        inflow += debit;
        outflow += credit;
        cashParticipantCodes.add(entry.code);
        continue;
      }
      if (debit !== 0n) {
        debitCounterparties.set(entry.code, (debitCounterparties.get(entry.code) ?? 0n) + debit);
      }
      if (credit !== 0n) {
        creditCounterparties.set(entry.code, (creditCounterparties.get(entry.code) ?? 0n) + credit);
      }
    }
    if (inflow === 0n && outflow === 0n) continue;
    const totalOf = (map) => [...map.values()].reduce((sum, value) => sum + value, 0n);
    const debitTotal = totalOf(debitCounterparties);
    const creditTotal = totalOf(creditCounterparties);
    // 同一凭证的现金收付可以有多种合法配对：现金内部划转 t 只需吸收「超出非现金对方的现金部分」，
    // 因此 t ∈ [tMin, tMax]：tMin = max(0, 流入 − 非现金贷方) = max(0, 流出 − 非现金借方)
    // （平衡凭证上两者相等，这里取较大值以防数据异常），tMax = min(流入, 流出)。
    // 只有区间收敛为单点时才可确定外部现金收付金额；否则同一批分录既可能是
    // 「内部划转 + 非现金对非现金」，也可能是「外部现金收付 + 部分内部划转」，
    // 不得假定其中一种，也不得用净额 0 消除双向 gross 事实或把假定金额写进经营 / 投资 / 筹资。
    const minInternalIn = inflow > creditTotal ? inflow - creditTotal : 0n;
    const minInternalOut = outflow > debitTotal ? outflow - debitTotal : 0n;
    const minInternal = minInternalIn > minInternalOut ? minInternalIn : minInternalOut;
    const maxInternal = inflow < outflow ? inflow : outflow;
    if (minInternal !== maxInternal) {
      unknown.push({
        direction: "inflow",
        category: "unknown",
        reason: "ambiguous-cash-counterpart-pairing",
        value: centsToNumber(inflow),
      });
      if (outflow !== 0n) {
        unknown.push({
          direction: "outflow",
          category: "unknown",
          reason: "ambiguous-cash-counterpart-pairing",
          value: centsToNumber(-outflow),
        });
      }
      continue;
    }
    const inflowToNonCash = inflow - minInternal;
    const outflowToNonCash = outflow - minInternal;
    const classify = (signedCents, counterparties, direction) => {
      if (signedCents === 0n || counterparties.size === 0) return;
      if (counterparties.size > 1) {
        // 不实现复合凭证按比例分摊：不猜分类，也不把金额塞进其他类别。
        unknown.push({
          direction,
          category: "unknown",
          reason: "multi-counterpart-allocation-not-implemented",
          value: centsToNumber(signedCents),
        });
        return;
      }
      const [code] = [...counterparties.keys()];
      const account = byCode.get(code);
      if (!account) {
        unknown.push({ code, direction, category: "unknown", reason: "counterpart-unmapped", value: centsToNumber(signedCents) });
        return;
      }
      const classified = classifyAccountingCashCounterpart(profile.id, account);
      if (classified.category === "operating" || classified.category === "investing" || classified.category === "financing") {
        addBucket(classified.category, code, signedCents);
        return;
      }
      unknown.push({
        code,
        direction,
        category: "unknown",
        reason: fixedReason(classified.reason, "classification-not-verified"),
        value: centsToNumber(signedCents),
      });
    };
    classify(inflowToNonCash, creditCounterparties, "inflow");
    classify(-outflowToNonCash, debitCounterparties, "outflow");
  }

  const toLines = (category) => [...bucket[category].entries()]
    .filter(([, value]) => value !== 0n)
    .map(([code, value]) => ({ code, name: names.get(code) || code, value: centsToNumber(value) }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const operating = toLines("operating");
  const investing = toLines("investing");
  const financing = toLines("financing");
  const sumLine = (lines) => lines.reduce((total, line) => total + storedCents(line.value), 0n);
  const operatingCents = sumLine(operating);
  const investingCents = sumLine(investing);
  const financingCents = sumLine(financing);
  const netCents = operatingCents + investingCents + financingCents;

  const balEnd = centsView(accountBalances(setId, period));
  const balBegin = centsView(accountBalances(setId, prevPeriod(period)));
  // 现金余额按真实「借方 − 贷方」整数分事实汇总，不盲信库内可能已损坏的 direction：
  // profile 角色已确定现金是资产 / 借方，任何「负债 / 贷方」声明只能作为待诊断冲突，
  // 不能把借方现金余额翻成负数，也不能把它静默抹为 0。
  const cashNetByCode = (throughPeriod) => {
    const netByCode = new Map();
    const add = (code, cents) => netByCode.set(code, (netByCode.get(code) ?? 0n) + cents);
    for (const opening of getOpeningBalances(setId)) {
      if (isCash(opening.code)) add(opening.code, storedCents(opening.debit) - storedCents(opening.credit));
    }
    for (const entry of postedEntryRows(db, setId, { fromPeriod: set.start_period, toPeriod: throughPeriod })) {
      if (isCash(entry.code)) add(entry.code, storedCents(entry.debit) - storedCents(entry.credit));
    }
    return netByCode;
  };
  const cashBeginByCode = cashNetByCode(prevPeriod(period));
  const cashEndByCode = cashNetByCode(period);
  const sumCashCents = (netByCode) => [...netByCode.values()].reduce((total, cents) => total + cents, 0n);
  const cashBeginCents = sumCashCents(cashBeginByCode);
  const cashEndCents = sumCashCents(cashEndByCode);
  for (const [code, cents] of cashBeginByCode) if (cents !== 0n) cashParticipantCodes.add(code);
  for (const [code, cents] of cashEndByCode) if (cents !== 0n) cashParticipantCodes.add(code);

  // 参与现金 gross / 期初 / 期末的所有现金细目都要用 profile 权威语义（类别 / 方向 / 备抵）校验：
  // 合法自定义明细（如 100201 资产 / debit）通过；历史损坏 / 未映射记录保留诊断，
  // 不静默 complete，也不把金额从可核余额里抹掉。
  const CASH_SEMANTICS_REASON = {
    "category-conflict": "account-category-conflict",
    "direction-conflict": "account-direction-conflict",
    "contra-conflict": "account-contra-conflict",
    "account-metadata-invalid": "account-metadata-invalid",
  };
  const cashSemanticsIssues = [];
  for (const code of cashParticipantCodes) {
    const account = byCode.get(code);
    const semantics = account ? accountProfileSemantics(profile, account) : null;
    if (!semantics || !semantics.matchedRoot) {
      cashSemanticsIssues.push({
        accountCode: code,
        diagnostics: [{ code: "report_account_unmapped", reason: "account-not-in-profile" }],
      });
      continue;
    }
    if (semantics.reasons.length) {
      cashSemanticsIssues.push({
        accountCode: code,
        diagnostics: semantics.reasons.map((reason) => ({
          code: "report_account_semantics_mismatch",
          reason: CASH_SEMANTICS_REASON[reason] ?? "account-metadata-invalid",
        })),
      });
    }
  }

  const earnings = incomeStatement(setId, period);
  // 折旧 / 摊销只认已过账借方对方科目（累计折旧 / 摊销角色前缀）。
  const accumRoots = [roles.accumulatedDepreciation, roles.accumulatedAmortization];
  const depreciationCents = postedEntryRows(db, setId, {
    fromPeriod: period, toPeriod: period, excludeCarryforward: true,
  }).reduce((total, entry) => (
    codeUnderAny(entry.code, accumRoots) ? total + storedCents(entry.credit) : total
  ), 0n);

  const rules = getAccountingReportRules(profile.id);
  const rootsOf = (rowId) => {
    const row = rules.balanceSheet.rows.find((item) => item.rowId === rowId);
    return row?.roots ?? [];
  };
  const receivableRoots = [
    ...rootsOf("notes-receivable"), ...rootsOf("accounts-receivable"),
    ...rootsOf("prepayments"), ...rootsOf("other-receivables"),
  ];
  const inventoryRoots = rootsOf("inventory");
  const payableRoots = [
    ...rootsOf("notes-payable"), ...rootsOf("accounts-payable"), ...rootsOf("advances-from-customers"),
    ...rootsOf("employee-benefits-payable"), ...rootsOf("taxes-payable"), ...rootsOf("interest-payable"),
    ...rootsOf("dividends-payable"), ...rootsOf("other-payables"),
  ];
  const delta = (roots) => sumByPrefixCents(balEnd, roots) - sumByPrefixCents(balBegin, roots);
  const n = centsToNumber;

  const unknownReasons = [...new Set(unknown.map((item) => fixedReason(item.reason, "classification-not-verified")))];
  const extraDiagnostics = unknownReasons.map((reason) => ({
    code: "cash_flow_classification_incomplete",
    severity: "error",
    reportKind: "cash-flow-statement",
    reason,
  }));
  for (const issue of cashSemanticsIssues) {
    for (const diagnostic of issue.diagnostics) {
      extraDiagnostics.push({
        code: diagnostic.code,
        severity: "error",
        reportKind: "cash-flow-statement",
        accountCode: issue.accountCode,
        reason: diagnostic.reason,
      });
    }
  }
  const classificationComplete = unknown.length === 0 && cashSemanticsIssues.length === 0;
  const reportStatus = profileReportStatus(
    "cash-flow-statement",
    { complete: classificationComplete, diagnostics: [] },
    { profile, context, extraDiagnostics },
  );

  return {
    period,
    method: "直接法（单一对方科目分类）",
    accountingContext: context,
    reportStatus,
    diagnostics: reportStatus.diagnostics,
    operating,
    investing,
    financing,
    unknown,
    classificationComplete,
    totals: {
      operating: n(operatingCents),
      investing: n(investingCents),
      financing: n(financingCents),
      net_increase: n(netCents),
    },
    cash: { begin: n(cashBeginCents), end: n(cashEndCents), change: n(cashEndCents - cashBeginCents) },
    reconciles: netCents === cashEndCents - cashBeginCents,
    supplement_indirect: {
      净利润: earnings.current["净利润"],
      加_折旧与摊销: n(depreciationCents),
      减_经营性应收的增加: n(delta(receivableRoots)),
      减_存货的增加: n(delta(inventoryRoots)),
      加_经营性应付的增加: n(delta(payableRoots)),
      经营活动产生的现金流量净额: n(operatingCents),
    },
  };
}

// ================================================================ 导入旧账

const normKey = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_\u3000]/g, "");

export function parseCsv(text) {
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

const DIRECTIONS = { 借: "debit", debit: "debit", d: "debit", 借方: "debit", 贷: "credit", credit: "credit", c: "credit", 贷方: "credit" };

// 金额上限与统一十进制规则由 money.mjs 提供（12 位整数 + 2 位小数，超过按超界拒绝）。
// 允许的金额文本：可带前导 ¥/￥、正负号、千分位与小数；不含内部空白、指数、单位。
const AMOUNT_TEXT_RE = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
const CURRENCY_PREFIX_RE = /^[¥￥]\s*/;
const ACCOUNT_CATEGORIES = ["资产", "负债", "权益", "成本", "损益"];

/**
 * 严格金额解析（先核对原始类型/数值范围/符号，再归一化到 2 位小数）。
 * - 只允许 number / string / null / undefined；对象、数组、布尔一律拒绝，
 *   不允许 String([100]) 之类被强制成 "100" 或 "[object Object]"。
 * - 有限 number 直接采用；number 型 NaN/Infinity 拒绝。
 * - 空白/缺失（""/undefined/null）按 0 处理，这是允许的输入格式。
 * - 文本必须匹配 AMOUNT_TEXT_RE；垃圾文本、部分可解析文本一律拒绝，不再按 0 吞掉。
 * - 先判断原始数值的绝对值是否超界、是否带负号，再 r2；不允许超界原值/极小负值
 *   因舍入被接受。
 * 返回 { ok: true, value, rawValue, negative } 或 { ok: false, error }。
 */
export function parseImportAmount(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: 0, rawValue: 0, negative: false, subCent: false };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, error: "金额必须是有限数字（不允许 NaN/Infinity）" };
    return finishImportAmount(String(raw), raw);
  }
  if (typeof raw !== "string") {
    return { ok: false, error: `金额类型非法（只允许数字或文本）：${fmtRaw(raw)}` };
  }
  const text = raw.trim();
  if (text === "") return { ok: true, value: 0, rawValue: 0, negative: false, subCent: false };
  const body = text.replace(CURRENCY_PREFIX_RE, "").trim();
  if (!AMOUNT_TEXT_RE.test(body)) return { ok: false, error: `金额文本非法：${text}` };
  const normalized = body.replace(/,/g, "");
  return finishImportAmount(normalized, Number(normalized), text);
}
function finishImportAmount(normalized, rawValue, source = normalized) {
  const parsed = parseMoney(normalized, { allowNegative: true, label: "金额" });
  if (!parsed.ok) {
    if (parsed.code === "money_over_limit") return { ok: false, error: `金额超界（绝对值上限 ${MONEY_MAX_TEXT}）：${source}` };
    if (parsed.code === "money_not_finite") return { ok: false, error: "金额必须是有限数字（不允许 NaN/Infinity）" };
    return { ok: false, error: `金额文本非法：${source}` };
  }
  // 负号按原值判定（-0.001 也必须报“不能为负”，不能因舍入成 0 被接受）。
  const negative = /^-/.test(normalized) && /[1-9]/.test(normalized);
  return { ok: true, value: centsToNumber(parsed.cents), rawValue, negative, subCent: parsed.subCent };
}

// 凭证日期：仅接受 YYYY-MM-DD 的真实日历日期；空白表示缺省为期间首日。
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseImportDate(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { ok: false, error: `日期类型非法（只允许文本或数字）：${fmtRaw(raw)}` };
  }
  const text = String(raw).trim();
  if (text === "") return { ok: true, value: "" };
  const m = DATE_RE.exec(text);
  if (!m) return { ok: false, error: `日期格式应为 YYYY-MM-DD：${text}` };
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: `日期不是真实日历日：${text}` };
  }
  return { ok: true, value: `${m[1]}-${m[2]}-${m[3]}` };
}

const normDirection = (raw) => {
  const s = String(raw ?? "").trim();
  return s ? (DIRECTIONS[normKey(s)] || s) : "";
};
const fmtRaw = (v) => {
  if (v === undefined || v === null || v === "") return "(空)";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return "[对象]"; } }
  return String(v);
};
// 文本字段只允许 string/number/null/undefined；对象/数组/布尔不得被 String() 成垃圾文本。
function coerceText(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw === "string") return { ok: true, value: raw.trim() };
  if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: String(raw) };
  return { ok: false, error: `文本类型非法：${fmtRaw(raw)}` };
}

function headerMap(rows, synonyms, positions) {
  const first = (rows[0] || []).map(normKey);
  const idx = {}; let matched = 0;
  for (const key of Object.keys(synonyms)) {
    const i = first.findIndex((h) => synonyms[key].includes(h));
    if (i >= 0) { idx[key] = i; matched++; }
  }
  if (matched >= 2) return { idx, start: 1 };
  const pos = {}; Object.keys(synonyms).forEach((k, n) => { pos[k] = positions[n]; });
  return { idx: pos, start: 0 };
}

const CSV_COLS = {
  accounts: {
    code: ["科目编码", "科目代码", "编码", "code"],
    name: ["科目名称", "名称", "name"],
    category: ["类别", "科目类别", "category"],
    direction: ["方向", "余额方向", "direction"],
  },
  openings: {
    code: ["科目编码", "科目代码", "编码", "code"],
    debit: ["借方", "期初借方", "借方余额", "debit"],
    credit: ["贷方", "期初贷方", "贷方余额", "credit"],
  },
  vouchers: {
    period: ["期间", "会计期间", "period"],
    date: ["日期", "凭证日期", "date"],
    word: ["字号", "凭证字", "word"],
    number: ["凭证号", "号码", "number"],
    summary: ["摘要", "summary"],
    code: ["科目编码", "科目代码", "code"],
    debit: ["借方", "借方金额", "debit"],
    credit: ["贷方", "贷方金额", "credit"],
  },
};
const META_KEYS = {
  账套名称: "name", 名称: "name", name: "name",
  纳税人性质: "taxpayer_type", 纳税人类型: "taxpayer_type", taxpayer_type: "taxpayer_type",
  会计准则: "accounting_standard", accounting_standard: "accounting_standard",
  启用期间: "start_period", start_period: "start_period",
};

/** 把 4 张 CSV 文本解析成导入 payload（不落库）。 */
export function parseImportTexts(texts = {}, metaOverride = {}) {
  const payload = { account_set: { ...metaOverride }, accounts: [], opening_balances: [], vouchers: [] };
  if (texts.meta) {
    for (const r of parseCsv(texts.meta)) {
      if (r.length < 2) continue;
      const key = META_KEYS[normKey(r[0])];
      if (key) payload.account_set[key] = String(r[1]).trim();
    }
  }
  if (texts.accounts) {
    const rows = parseCsv(texts.accounts);
    const { idx, start } = headerMap(rows, CSV_COLS.accounts, [0, 1, 2, 3]);
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      payload.accounts.push({
        code: String(row[idx.code] ?? "").trim(), name: String(row[idx.name] ?? "").trim(),
        category: String(row[idx.category] ?? "").trim(),
        direction: DIRECTIONS[normKey(row[idx.direction])] || String(row[idx.direction] ?? "").trim(),
      });
    }
  }
  if (texts.openings) {
    const rows = parseCsv(texts.openings);
    const { idx, start } = headerMap(rows, CSV_COLS.openings, [0, 1, 2]);
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      // 保留原始金额文本，由 validateImportPayload / importAccountSet 统一严格校验，避免静默归 0。
      payload.opening_balances.push({
        code: String(row[idx.code] ?? "").trim(),
        debit: String(row[idx.debit] ?? "").trim(), credit: String(row[idx.credit] ?? "").trim(),
      });
    }
  }
  if (texts.vouchers) {
    const rows = parseCsv(texts.vouchers);
    const { idx, start } = headerMap(rows, CSV_COLS.vouchers, [0, 1, 2, 3, 4, 5, 6, 7]);
    const groups = new Map();
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      const period = String(row[idx.period] ?? "").trim();
      const word = String(row[idx.word] ?? "").trim() || "记";
      // 保留原始编号文本；合法显式编号按数值归一化分组，非法编号单独成组交由校验拒绝，
      // 不再用 parseInt 吞掉 `1oops` 这类坏数据。
      const numberRaw = String(row[idx.number] ?? "").trim();
      const validNumber = /^\d+$/.test(numberRaw) && Number.isSafeInteger(Number(numberRaw)) && Number(numberRaw) > 0;
      const numberKey = numberRaw === "" ? "1" : (validNumber ? String(Number(numberRaw)) : `bad:${numberRaw}`);
      const key = `${period}|${word}|${numberKey}`;
      if (!groups.has(key)) groups.set(key, {
        period, word,
        numberRaw,
        // 合法缺省编号保持原契约（默认 1）；显式编号在预检中必须为安全正整数。
        number: validNumber ? Number(numberRaw) : (numberRaw === "" ? 1 : undefined),
        date: String(row[idx.date] ?? "").trim(), dates: [],
        summary: String(row[idx.summary] ?? "").trim(), entries: [],
      });
      const g = groups.get(key);
      // 保留同一凭证每一行的原始日期，避免只留首行而漏掉后续行的非法日期。
      g.dates.push(String(row[idx.date] ?? "").trim());
      g.entries.push({
        code: String(row[idx.code] ?? "").trim(), summary: String(row[idx.summary] ?? "").trim(),
        debit: String(row[idx.debit] ?? "").trim(), credit: String(row[idx.credit] ?? "").trim(),
      });
    }
    payload.vouchers = [...groups.values()];
  }
  return payload;
}

/**
 * 共享导入预检：先核对原始数据/文本，再归一化成可写入的值。
 * 预检与正式写入共用本函数，保证「预检通过后正式写入不会因同一静态约束失败」。
 * 本函数只读，不产生任何业务写入；错误带行号/凭证/科目/字段上下文。
 * 返回 { ok, errors, warnings, normalized, summary, profile, profileError }。
 *
 * 第二个参数是**内部已验证上下文**（可选），不是 payload 字段：
 *   { profileId, accounts? }
 * 用于 append 目标账套 / 旧已完成 create 批次重放：必须按目标账套**实际** profile 与科目表校验，
 * 不是按新企业模板先拒绝合法旧录入。payload 里的任何字段都不能冒充这个上下文。
 */
export function normalizeImportPayload(payload = {}, context = null) {
  const errors = [], warnings = [];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      errors: [`导入数据格式非法（payload 应为对象）：${fmtRaw(payload)}`],
      warnings,
      normalized: { account_set: {}, accounts: [], opening_balances: [], vouchers: [] },
      summary: { account_set: null, start_period: null, accounts: 0, opening_balances: 0, vouchers: 0, entries: 0 },
      profile: null,
      profileError: null,
    };
  }
  const p = payload;
  if (p.account_set !== undefined && p.account_set !== null
    && (typeof p.account_set !== "object" || Array.isArray(p.account_set))) {
    errors.push(`账套信息 account_set 格式非法（应为对象）：${fmtRaw(p.account_set)}`);
  }
  const meta = (p.account_set && typeof p.account_set === "object" && !Array.isArray(p.account_set)) ? p.account_set : {};

  // ---- 账套 meta：所有会写入 SQLite 的字段先核对类型，再归一化 ----
  const nameT = coerceText(meta.name);
  const name = nameT.ok ? nameT.value : "";
  if (!nameT.ok) errors.push(`账套名称 name 类型非法：${fmtRaw(meta.name)}`);
  else if (!name) errors.push("缺少账套名称");
  const taxT = coerceText(meta.taxpayer_type);
  if (!taxT.ok) errors.push(`纳税人性质 taxpayer_type 类型非法：${fmtRaw(meta.taxpayer_type)}`);
  const stdT = coerceText(meta.accounting_standard);
  if (!stdT.ok) errors.push(`会计准则 accounting_standard 类型非法：${fmtRaw(meta.accounting_standard)}`);

  // ---- 会计 profile / 基础科目表（内部上下文优先；否则按请求准则选择新 profile）----
  let profile = null;
  let profileError = null;
  let baseAccounts = [];
  if (context !== undefined && context !== null) {
    if (typeof context !== "object" || Array.isArray(context) || typeof context.profileId !== "string") {
      throw Object.assign(new Error("import_context_invalid"), {
        code: "import_context_invalid",
        details: { field: "context", reason: "malformed" },
      });
    }
    profile = getAccountingProfile(context.profileId);
    baseAccounts = Array.isArray(context.accounts) ? context.accounts : seedAccounts(profile);
  } else {
    const rawStd = meta.accounting_standard;
    let standard;
    if (rawStd === undefined || rawStd === null) {
      standard = undefined;
    } else if (!stdT.ok) {
      profileError = { code: "accounting_standard_invalid", message: "会计准则是非受支持的类型" };
    } else if (typeof rawStd === "string" && rawStd !== rawStd.trim()) {
      profileError = { code: "accounting_standard_invalid", message: "会计准则必须精确匹配（不接受首尾空白）" };
    } else if (stdT.value === "") {
      standard = undefined;
    } else {
      standard = stdT.value;
    }
    if (!profileError) {
      try {
        profile = resolveNewAccountingProfile(standard === undefined ? {} : { accounting_standard: standard });
      } catch (e) {
        profileError = { code: e?.code || "accounting_standard_invalid", message: e?.message || "会计准则不受支持" };
      }
    }
    if (profileError) errors.push(`${profileError.code}: ${profileError.message}`);
    baseAccounts = profile ? seedAccounts(profile) : [];
  }
  const baseCodes = new Set(baseAccounts.map((account) => String(account.code)));
  const startRaw = meta.start_period;
  let startPeriod = null;
  if (startRaw !== undefined && startRaw !== null && typeof startRaw !== "string" && typeof startRaw !== "number") {
    errors.push(`启用期间 start_period 类型非法：${fmtRaw(startRaw)}`);
  } else {
    startPeriod = parsePeriod(startRaw);
    if (!startPeriod) errors.push(`启用期间非法（应为 YYYY-MM 且月份 01-12）：${fmtRaw(startRaw)}`);
  }

  // 三个集合：缺失（undefined/null）按空集合；显式给了错误类型必须报错，不能静默丢弃。
  const readCollection = (key) => {
    const v = p[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { errors.push(`导入数据 ${key} 格式非法（应为数组）：${fmtRaw(v)}`); return []; }
    return v;
  };
  const accountsIn = readCollection("accounts");
  const openingsIn = readCollection("opening_balances");
  const vouchersIn = readCollection("vouchers");

  // ---- 科目 ----
  const standardCodes = baseCodes;
  const accountCodes = new Set(standardCodes);
  const normalizedAccounts = [];
  const seenCodes = new Set();
  accountsIn.forEach((a, i) => {
    const line = i + 1;
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      errors.push(`科目第 ${line} 行格式非法（应为对象）：${fmtRaw(a)}`); return;
    }
    const codeT = coerceText(a.code), nameT2 = coerceText(a.name);
    const dirT = coerceText(a.direction), catT = coerceText(a.category);
    if (!codeT.ok) errors.push(`科目第 ${line} 行科目编码类型非法：${fmtRaw(a.code)}`);
    if (!nameT2.ok) errors.push(`科目第 ${line} 行科目名称类型非法：${fmtRaw(a.name)}`);
    if (!dirT.ok) errors.push(`科目第 ${line} 行方向类型非法：${fmtRaw(a.direction)}`);
    if (!catT.ok) errors.push(`科目第 ${line} 行类别类型非法：${fmtRaw(a.category)}`);
    const code = codeT.ok ? codeT.value : "";
    const aname = nameT2.ok ? nameT2.value : "";
    const rawDir = dirT.ok ? dirT.value : "";
    const rawCat = catT.ok ? catT.value : "";
    const direction = normDirection(rawDir);
    if (!code) errors.push(`科目第 ${line} 行缺少科目编码`);
    else if (!aname) errors.push(`科目第 ${line} 行（编码 ${code}）缺少科目名称`);
    if (rawDir && !["debit", "credit"].includes(direction)) errors.push(`科目第 ${line} 行（编码 ${code || "空"}）方向非法：${rawDir}`);
    if (rawCat && !ACCOUNT_CATEGORIES.includes(rawCat)) errors.push(`科目第 ${line} 行（编码 ${code || "空"}）类别非法：${rawCat}`);

    const isStandard = !!code && standardCodes.has(code);
    const isDuplicate = !!code && seenCodes.has(code);
    if (isStandard) warnings.push(`科目 ${code} 已存在标准科目，将保留标准名称`);
    if (isDuplicate) warnings.push(`科目 ${code} 重复出现，仅保留首行`);
    if (code) { seenCodes.add(code); accountCodes.add(code); }

    // 只有会真正新增的科目才强制方向/类别；标准科目写入时被跳过，不因此拒绝历史输入。
    if (code && !isStandard && !isDuplicate) {
      if (!["debit", "credit"].includes(direction)) errors.push(`科目 ${code} 方向缺失或非法（新增科目必须为 debit/credit）：${rawDir || "(空)"}`);
      if (!ACCOUNT_CATEGORIES.includes(rawCat)) errors.push(`科目 ${code} 类别缺失或非法（新增科目必须为 资产/负债/权益/成本/损益）：${rawCat || "(空)"}`);
    }
    normalizedAccounts.push({ code, name: aname, category: rawCat, direction });
  });

  // ---- 期初余额 ----
  const normalizedOpenings = [];
  const seenOpeningCodes = new Set();
  const odValues = [], ocValues = [];
  let openingHasError = false;
  openingsIn.forEach((o, i) => {
    const line = i + 1;
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      errors.push(`期初余额第 ${line} 行格式非法（应为对象）：${fmtRaw(o)}`); openingHasError = true; return;
    }
    const codeT = coerceText(o.code);
    if (!codeT.ok) { errors.push(`期初余额第 ${line} 行科目编码类型非法：${fmtRaw(o.code)}`); openingHasError = true; }
    const code = codeT.ok ? codeT.value : "";
    if (!code) { errors.push(`期初余额第 ${line} 行缺少科目编码`); openingHasError = true; return; }
    // 重复期初必须拒绝：数据库按期初科目覆盖写入，汇总与覆盖语义不同会导致预检/写入不一致。
    if (seenOpeningCodes.has(code)) {
      errors.push(`期初余额第 ${line} 行（科目 ${code}）重复出现，请合并为一行`); openingHasError = true; return;
    }
    seenOpeningCodes.add(code);
    if (!accountCodes.has(code)) { errors.push(`期初余额第 ${line} 行科目不存在：${code}`); openingHasError = true; return; }
    const d = parseImportAmount(o.debit);
    const c = parseImportAmount(o.credit);
    if (!d.ok) { errors.push(`期初余额第 ${line} 行（科目 ${code}）借方金额非法：${fmtRaw(o.debit)}（${d.error}）`); openingHasError = true; }
    if (!c.ok) { errors.push(`期初余额第 ${line} 行（科目 ${code}）贷方金额非法：${fmtRaw(o.credit)}（${c.error}）`); openingHasError = true; }
    if (!d.ok || !c.ok) return;
    if (d.negative) { errors.push(`期初余额第 ${line} 行（科目 ${code}）借方不能为负：${fmtRaw(o.debit)}`); openingHasError = true; }
    if (c.negative) { errors.push(`期初余额第 ${line} 行（科目 ${code}）贷方不能为负：${fmtRaw(o.credit)}`); openingHasError = true; }
    if (d.value > 0 && c.value > 0) { errors.push(`期初余额第 ${line} 行（科目 ${code}）借贷不能同时有值`); openingHasError = true; }
    odValues.push(d.value); ocValues.push(c.value);
    if (d.subCent || c.subCent) { errors.push(`期初余额第 ${line} 行（科目 ${code}）金额不足一分，不能当成 0 入库`); openingHasError = true; }
    normalizedOpenings.push({ code, debit: d.value, credit: c.value });
  });
  const odCents = sumCents(odValues), ocCents = sumCents(ocValues);
  const od = centsToNumber(odCents), oc = centsToNumber(ocCents);
  if (!openingHasError && odCents !== ocCents) errors.push(`期初余额借贷不平：借 ${od} / 贷 ${oc}`);

  // ---- 凭证 ----
  const normalizedVouchers = [];
  let entryCount = 0;
  vouchersIn.forEach((v, i) => {
    const line = i + 1;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      errors.push(`凭证第 ${line} 张格式非法（应为对象）：${fmtRaw(v)}`); return;
    }
    const wordT = coerceText(v.word);
    const summaryT = coerceText(v.summary);
    const periodT = coerceText(v.period);
    if (!wordT.ok) errors.push(`凭证第 ${line} 张字号类型非法：${fmtRaw(v.word)}`);
    if (!summaryT.ok) errors.push(`凭证第 ${line} 张摘要类型非法：${fmtRaw(v.summary)}`);
    if (!periodT.ok) errors.push(`凭证第 ${line} 张期间类型非法：${fmtRaw(v.period)}`);
    const word = (wordT.ok && wordT.value) || "记";
    const period = periodT.ok ? parsePeriod(periodT.value) : null;

    // 凭证编号：number 与 numberRaw 各自严格类型/语法校验；两者同时存在时必须一致，
    // 辅助字段 numberRaw 不得经 String() 掩盖 number 的错误或本身类型非法。
    // 兼容 CSV 缺省编号默认 1、JSON 无编号自动取号，以及合法 CSV parse->JSON 序列化往返。
    let number, numberError = null;
    const numberErrors = [];
    let rawNumber, fieldNumber;
    const hasNumberRaw = v.numberRaw !== undefined && v.numberRaw !== null;
    const hasNumber = v.number !== undefined && v.number !== null && v.number !== "";
    if (hasNumberRaw) {
      if (typeof v.numberRaw !== "string") {
        numberErrors.push(`凭证编号 numberRaw 类型非法（应为文本）：${fmtRaw(v.numberRaw)}`);
      } else {
        const raw = v.numberRaw.trim();
        if (raw === "") rawNumber = 1;
        else if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0) rawNumber = Number(raw);
        else numberErrors.push(`凭证编号非法（应为安全正整数）：${fmtRaw(v.numberRaw)}`);
      }
    }
    if (hasNumber) {
      const nv = v.number;
      if (typeof nv === "number" && Number.isSafeInteger(nv) && nv > 0) fieldNumber = nv;
      else if (typeof nv === "string" && /^\d+$/.test(nv.trim()) && Number.isSafeInteger(Number(nv)) && Number(nv) > 0) fieldNumber = Number(nv);
      else numberErrors.push(`凭证编号非法（应为安全正整数）：${fmtRaw(nv)}`);
    }
    if (rawNumber !== undefined && fieldNumber !== undefined && rawNumber !== fieldNumber) {
      numberErrors.push(`凭证编号 number 与 numberRaw 不一致：${fieldNumber} / ${fmtRaw(v.numberRaw)}`);
    }
    number = hasNumberRaw ? rawNumber : fieldNumber;
    if (numberErrors.length) numberError = numberErrors.join("；");
    const numberLabel = number !== undefined ? number
      : (typeof v.numberRaw === "string" && v.numberRaw.trim() ? v.numberRaw.trim() : "自动");
    const label = `${periodT.ok ? (periodT.value || "(空)") : fmtRaw(v.period)} ${word}-${numberLabel}`;
    if (!period) errors.push(`凭证第 ${line} 张（${label}）期间非法：${fmtRaw(v.period)}`);
    else if (startPeriod && period < startPeriod) errors.push(`凭证第 ${line} 张（${label}）期间不得早于启用期间 ${startPeriod}：${period}`);
    if (numberError) errors.push(`凭证第 ${line} 张（${label}）${numberError}`);

    // 日期：date 本身始终校验，不能被 dates 覆盖率或替代；dates 若存在必须为数组并逐项校验，
    // 且与 date 已填值一致（同凭证内不得出现多个不同日期）。
    const dateValues = [];
    let dateHasError = false;
    const checkDate = (raw) => {
      const dp = parseImportDate(raw);
      if (!dp.ok) { errors.push(`凭证第 ${line} 张（${label}）日期非法：${dp.error}`); dateHasError = true; }
      else if (dp.value) dateValues.push(dp.value);
    };
    checkDate(v.date);
    if (v.dates !== undefined && v.dates !== null) {
      if (!Array.isArray(v.dates)) {
        errors.push(`凭证第 ${line} 张（${label}）辅助日期 dates 格式非法（应为数组）：${fmtRaw(v.dates)}`);
        dateHasError = true;
      } else {
        for (const dRaw of v.dates) checkDate(dRaw);
      }
    }
    const distinctDates = new Set(dateValues);
    if (distinctDates.size > 1) {
      errors.push(`凭证第 ${line} 张（${label}）同一凭证日期不一致：${[...distinctDates].join("、")}`);
      dateHasError = true;
    }
    const dateValue = distinctDates.size ? [...distinctDates][0] : "";
    if (!dateHasError && dateValue && period && dateValue.slice(0, 7) !== period) {
      warnings.push(`凭证第 ${line} 张（${label}）日期 ${dateValue} 与期间 ${period} 不在同一月份`);
    }

    // 分录：非数组要报形状错误，不能当空数组吞掉。
    const esRaw = v.entries;
    let entryHasError = false;
    if (esRaw !== undefined && esRaw !== null && !Array.isArray(esRaw)) {
      errors.push(`凭证第 ${line} 张（${label}）分录 entries 格式非法（应为数组）：${fmtRaw(esRaw)}`);
      entryHasError = true;
    }
    const es = Array.isArray(esRaw) ? esRaw : [];
    entryCount += es.length;
    const normalizedEntries = [];
    const vdValues = [], vcValues = [];
    if (es.length < 2) errors.push(`凭证第 ${line} 张（${label}）至少两条分录`);
    es.forEach((e, j) => {
      const eline = j + 1;
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行格式非法（应为对象）：${fmtRaw(e)}`);
        entryHasError = true; return;
      }
      const codeT = coerceText(e.code), esumT = coerceText(e.summary);
      if (!codeT.ok) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行科目编码类型非法：${fmtRaw(e.code)}`); entryHasError = true; }
      if (!esumT.ok) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行摘要类型非法：${fmtRaw(e.summary)}`); entryHasError = true; }
      const code = codeT.ok ? codeT.value : "";
      if (!code) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行缺少科目`); entryHasError = true; return; }
      if (!accountCodes.has(code)) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行科目不存在：${code}`); entryHasError = true; }
      const d = parseImportAmount(e.debit);
      const c = parseImportAmount(e.credit);
      if (!d.ok) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行借方金额非法：${fmtRaw(e.debit)}（${d.error}）`); entryHasError = true; }
      if (!c.ok) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行贷方金额非法：${fmtRaw(e.credit)}（${c.error}）`); entryHasError = true; }
      if (!d.ok || !c.ok) return;
      if (d.negative) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行借方不能为负：${fmtRaw(e.debit)}`); entryHasError = true; }
      if (c.negative) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行贷方不能为负：${fmtRaw(e.credit)}`); entryHasError = true; }
      if (d.value > 0 && c.value > 0) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行借贷不能同时有值`); entryHasError = true; }
      if (d.value === 0 && c.value === 0) { errors.push(`凭证第 ${line} 张（${label}）第 ${eline} 行金额不能为 0`); entryHasError = true; }
      vdValues.push(d.value); vcValues.push(c.value);
      let eSummary = esumT.ok ? esumT.value : "";
      if ((e.summary === undefined || e.summary === null) && summaryT.ok) eSummary = summaryT.value;
      normalizedEntries.push({ code, summary: eSummary, debit: d.value, credit: c.value });
    });
    const vdCents = sumCents(vdValues), vcCents = sumCents(vcValues);
    const vd = centsToNumber(vdCents), vc = centsToNumber(vcCents);
    if (!entryHasError && vdCents !== vcCents) errors.push(`凭证第 ${line} 张（${label}）借贷不平：借 ${vd} / 贷 ${vc}`);
    normalizedVouchers.push({
      period: period || (periodT.ok ? periodT.value : ""), date: dateValue,
      word, number, summary: summaryT.ok ? summaryT.value : "", entries: normalizedEntries,
    });
  });

  return {
    ok: errors.length === 0,
    errors, warnings,
    normalized: {
      account_set: {
        name,
        taxpayer_type: taxT.ok ? taxT.value : "",
        accounting_standard: stdT.ok ? stdT.value : "",
        start_period: startPeriod || (typeof startRaw === "string" ? startRaw : ""),
      },
      accounts: normalizedAccounts,
      opening_balances: normalizedOpenings,
      vouchers: normalizedVouchers,
    },
    summary: {
      account_set: name || null,
      start_period: startPeriod || (typeof startRaw === "string" ? startRaw : null),
      accounts: accountsIn.length,
      opening_balances: openingsIn.length,
      vouchers: vouchersIn.length,
      entries: entryCount,
    },
    profile: profile ? { id: profile.id, declaredStandard: profile.declaredStandard, legacy: profile.legacy === true } : null,
    profileError,
  };
}

/** 校验导入 payload，返回错误/警告/统计（向后兼容入口，内部与正式写入共用同一约束）。 */
export function validateImportPayload(payload = {}, options = {}) {
  return importAccountSet(payload, { ...options, dryRun: true }).validation;
}
function importValidation(normalized, enterprise) {
  let identity = null, identityFailure = null;
  try {
    identity = normalizeEnterpriseIdentity(enterprise);
    if (getEnterpriseAccountSet(db, identity.enterpriseKey)) throw identityError("enterprise_already_bound");
  } catch (e) { identityFailure = { code: e.code }; }
  const r = normalized;
  return {
    ok: r.ok && !identityFailure, errors: [...r.errors, ...(identityFailure ? [identityFailure.code] : [])], warnings: r.warnings, summary: r.summary,
    profile: r.profile, profileError: r.profileError, identityError: identityFailure,
  };
}

/**
 * 旧首次导入（无来源 / 企业 / 批次身份）：行为与返回结构保持不变，
 * 但新建账套按请求准则选择合法新 profile（同一事务内写账套 / 科目 / 首期间 / profile）。
 * 返回 validation 中可带 profileError，不把非法准则逃逸成泛 500。
 */
export function importAccountSet(payload = {}, { dryRun = false, enterprise, profileId } = {}) {
  // profileId is an envelope option and never changes historical payload/fingerprint fields.
  let context = null;
  if (profileId !== undefined) {
    try { const profile = resolveCreationProfile({ accounting_standard: payload?.account_set?.accounting_standard, profileId });
      context = { profileId: profile.id, accounts: profile.coa };
    } catch (e) {
      const validation = { ok: false, errors: [e.code], warnings: [], summary: null, profile: null,
        profileError: { code: e.code }, identityError: null };
      return { dryRun: true, validation, created: null };
    }
  }
  const normalized = normalizeImportPayload(payload, context);
  const validation = importValidation(normalized, enterprise);
  if (dryRun || !validation.ok) return { dryRun: true, validation, created: null };
  const n = normalized.normalized;
  const meta = n.account_set;
  db.exec("BEGIN");
  try {
    const set = createAccountSet({
      enterprise, name: meta.name, taxpayer_type: meta.taxpayer_type || "小规模纳税人",
      accounting_standard: meta.accounting_standard || undefined, start_period: meta.start_period,
      ...(normalized.profile ? { profileId: normalized.profile.id } : {}),
    });
    const have = new Set(listAccounts(set.id).map((a) => a.code));
    for (const a of n.accounts) {
      if (have.has(String(a.code))) continue;
      addAccount(set.id, { code: a.code, name: a.name, category: a.category, direction: a.direction });
      have.add(String(a.code));
    }
    if (n.opening_balances.length) setOpeningBalances(set.id, n.opening_balances);
    let vcount = 0;
    for (const v of n.vouchers) {
      createVoucher(set.id, {
        period: v.period, voucher_date: v.date || `${v.period}-01`, word: v.word,
        number: v.number, summary: v.summary, kind: "normal", status: "posted", entries: v.entries,
      });
      vcount++;
    }
    db.exec("COMMIT");
    return {
      dryRun: false, validation,
      created: {
        id: set.id, name: set.name, start_period: set.start_period,
        accounts: listAccounts(set.id).length, opening_balances: getOpeningBalances(set.id).length, vouchers: vcount,
      },
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
