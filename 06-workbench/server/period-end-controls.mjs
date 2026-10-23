import { auxiliaryCompletenessStep } from './auxiliary-storage.mjs';
// period-end-controls.mjs — 期末检查 / 封账前置 / 前期可改性守卫（LOCAL-02）
//
// 设计约束：
// 1) 本文件不 import accounting.mjs（accounting.mjs 反过来 import 本文件），避免循环依赖；
//    所有查询显式接收 DatabaseSync 句柄，金额一律走 money.mjs 的整数分规则。
// 2) 「检查」与「执行」用同一份规则：封账调用 assertPeriodCloseable，计提调用
//    assetCardPeriodStatus，接口查询调用 buildPeriodEndCheck，三者结论必须一致。
// 3) 每一步都给「适用 / 不适用 / 不适用理由」，不对所有企业一刀切：
//    无资产卡片、无损益发生、非年末期间都显式标 not_applicable 并说明理由。
// 4) 拒绝必须是可解除的：每条阻塞都带 code / 期望 / 当前 / 建议顺序，
//    补项与反操作顺序写进 docs/ACCOUNTING-PERIOD-INTEGRITY.md。
// 5) 「依赖」按实际业务读取的余额判定，不按「曾经执行过」：普通损益结转读累计损益余额，
//    所以依赖所有前期损益发生额；计提读卡片事实与截至本期的累计，所以依赖前期计提状态。
//    前期修改一律「明确拒绝 + 给撤销顺序」，不保留后期错误的已过账派生结果。

import {
  MONEY_MAX_TEXT,
  centsToNumber,
  evenSplitAmountCents,
  formatCents,
  monthsBetween,
  mulCentsByRatio,
  storedCents,
  sumCents,
} from "./money.mjs";
import { getAccountingProfile } from "./accounting-profiles.mjs";
import { resolveAccountingAccountRule } from "./accounting-report-rules.mjs";

export const PERIOD_END_STATUS = {
  OK: "ok",
  BLOCKED: "blocked",
  NOT_APPLICABLE: "not_applicable",
};

/** 资产 / 累计折旧摊销的标准科目前缀（两个新 profile 与 legacy 的已核实基础均落在这些前缀）。 */
const ASSET_ACCOUNT_CODES = ["1601", "1701"];
const ACCUM_ACCOUNT_CODES = ["1602", "1702"];

/**
 * 读取账套持久 profile 与角色（本文件不能 import accounting.mjs，避免循环依赖）。
 * 未知 / 损坏 profile **不 fallback 到新小企**：正常业务得到结构化 accounting_profile_unknown，
 * 期末检查 / 封账前置 / 前期修改守卫都会在真正写入前失败。
 */
export function accountSetProfileForControls(db, setId) {
  const set = db.prepare(`SELECT * FROM account_sets WHERE id=?`).get(setId);
  if (!set) throw new Error("account_set_not_found");
  const profileId = set.accounting_profile_id;
  let profile;
  try {
    profile = getAccountingProfile(profileId);
  } catch {
    const error = new Error("accounting_profile_unknown");
    error.code = "accounting_profile_unknown";
    // 不回显库内任意原始 profile 字符串（只给固定字段 + 受控 reason）。
    error.details = {
      field: "accounting_profile_id",
      reason: "profile-not-registered",
    };
    throw error;
  }
  return {
    set,
    profile,
    roles: profile.roles,
    context: {
      declaredStandard: set.accounting_standard ?? null,
      profileId: profile.id,
      coaVersion: profile.coaVersion,
      reportMappingVersion: profile.reportMappingVersion,
      legacy: profile.legacy === true,
    },
  };
}

/**
 * 用准则映射校验一行科目元数据（类别 / 方向 / 备抵），**不盲信库内元数据**。
 * 返回：
 * - `matchedRoot`：命中的 profile 根科目（未映射为 null）
 * - `effective`：规则解析后的语义（类别 / 方向来自根科目，备抵含声明合并；未映射为 null）
 * - `reasons`：受控冲突 token（category-conflict / direction-conflict / contra-conflict /
 *   account-metadata-invalid），空数组表示一致
 * 未映射的自定义编码本身不算冲突（报表层会单独诊断），但它的方向无法用准则校验。
 */
export function accountProfileSemantics(profile, account) {
  const declared = {
    code: String(account?.code ?? ""),
    category: account?.category,
    direction: account?.direction,
    contra: account?.contra === true || account?.contra === 1 || account?.contra === "1",
    name: typeof account?.name === "string" ? account.name : null,
  };
  let resolved;
  try {
    resolved = resolveAccountingAccountRule(profile.id, declared);
  } catch {
    return {
      declared,
      matchedRoot: null,
      effective: null,
      reasons: ["account-metadata-invalid"],
    };
  }
  if (!resolved.matchedRoot) {
    return { declared, matchedRoot: null, effective: null, reasons: [] };
  }
  const reasons = [];
  if (resolved.effective.category !== declared.category) reasons.push("category-conflict");
  if (resolved.effective.direction !== declared.direction) reasons.push("direction-conflict");
  // effective.contra 已合并声明值，不能再拿它反证声明是否与权威根冲突。
  // 复用纯规则依据根科目给出的诊断，保留合法备抵根 / 明细的继承语义。
  if (resolved.diagnostics.some((diagnostic) => diagnostic.code === "account_contra_conflict")) {
    reasons.push("contra-conflict");
  }
  return {
    declared,
    matchedRoot: resolved.matchedRoot,
    effective: resolved.effective,
    reasons,
  };
}

const semanticsConflict = (account, field, reason) => ({
  field,
  accountCode: account.declared.code,
  matchedRoot: account.matchedRoot,
  reason,
});

/** 冲突原因 → 受控 field token（category / direction / contra）。 */
const conflictField = (reason) => (reason === "category-conflict"
  ? "category"
  : reason === "direction-conflict" ? "direction" : "contra");

/**
 * 结转参与科目的语义校验（写入前整体拒绝的依据）。
 * 参与 = 库内登记为损益，或准则映射属于损益（防止被错误登记成资产 / 负债的收入漏结），
 * 以及 yearEnd=true 时本年利润角色前缀下的明细。
 * 只校验期末仍有余额的科目：零余额异常科目不影响结转结果，留给报表诊断。
 */
export function carryForwardSemanticsConflicts(db, setId, profile, roles, period, { yearEnd = false } = {}) {
  const balances = balancesThrough(db, setId, period);
  const out = [];
  for (const account of accountRows(db, setId)) {
    const net = balances.get(account.code)?.net ?? 0n;
    if (net === 0n) continue;
    const semantics = accountProfileSemantics(profile, account);
    const authoritativePl = semantics.effective?.category === "损益";
    const profitCarry = account.category === "损益" || authoritativePl;
    const yearEndCarry = yearEnd && underPrefix(account.code, roles.currentYearProfit);
    if (!profitCarry && !yearEndCarry) continue;
    if (!semantics.reasons.length) continue;
    out.push({
      stage: profitCarry ? "profit-carry" : "year-end",
      ...semanticsConflict(
        semantics,
        conflictField(semantics.reasons[0]),
        semantics.reasons[0],
      ),
      reasons: semantics.reasons,
    });
  }
  return out;
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const isPeriod = (value) => PERIOD_RE.test(String(value ?? ""));
const prevMonth = (period) => {
  const [y, m] = String(period).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const nextMonth = (period) => {
  const [y, m] = String(period).split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const underPrefix = (code, prefix) => code === prefix || String(code).startsWith(prefix);

// ------------------------------------------------------------------ 基础查询
function accountRows(db, setId) {
  return db.prepare(
    `SELECT code, name, category, direction, contra FROM accounts WHERE account_set_id=? ORDER BY code`,
  ).all(setId);
}

function periodRows(db, setId) {
  return db.prepare(`SELECT period, status FROM periods WHERE account_set_id=? ORDER BY period`).all(setId);
}

function openingRows(db, setId) {
  return db.prepare(`SELECT code, debit, credit FROM opening_balances WHERE account_set_id=?`).all(setId);
}

/** 已过账发生额（可按区间 / 是否排除结转凭证过滤），全部按分累加。 */
export function postedEntryRows(db, setId, { fromPeriod = null, toPeriod = null, excludeCarryforward = false } = {}) {
  const where = ["v.account_set_id=?", "v.status='posted'"];
  const args = [setId];
  if (fromPeriod) { where.push("v.period>=?"); args.push(fromPeriod); }
  if (toPeriod) { where.push("v.period<=?"); args.push(toPeriod); }
  if (excludeCarryforward) where.push("v.kind<>'carryforward'");
  return db.prepare(
    `SELECT v.id AS voucher_id, v.period, v.kind, e.code, e.debit, e.credit
       FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE ${where.join(" AND ")}
      ORDER BY v.period, v.id, e.line_no`,
  ).all(...args);
}

/**
 * 截至 period 的科目净额（借方 − 贷方，单位分）。
 * 返回 Map(code → { net: BigInt, natural: BigInt, opening: BigInt, periodNet: BigInt })。
 * 「截至」包含该期已过账发生额，与报表口径一致。
 */
export function balancesThrough(db, setId, period) {
  const accounts = accountRows(db, setId);
  const opening = new Map();
  for (const row of openingRows(db, setId)) {
    opening.set(row.code, storedCents(row.debit) - storedCents(row.credit));
  }
  const net = new Map();
  const periodNet = new Map();
  for (const [code, cents] of opening) {
    net.set(code, cents);
  }
  for (const row of postedEntryRows(db, setId, { toPeriod: period })) {
    const delta = storedCents(row.debit) - storedCents(row.credit);
    net.set(row.code, (net.get(row.code) ?? 0n) + delta);
    if (row.period === period) periodNet.set(row.code, (periodNet.get(row.code) ?? 0n) + delta);
  }
  const out = new Map();
  for (const account of accounts) {
    const value = net.get(account.code) ?? 0n;
    out.set(account.code, {
      code: account.code,
      name: account.name,
      category: account.category,
      direction: account.direction,
      net: value,
      natural: account.direction === "debit" ? value : -value,
      opening: opening.get(account.code) ?? 0n,
      periodNet: periodNet.get(account.code) ?? 0n,
    });
  }
  return out;
}

/** 按科目前缀汇总自然余额（每个科目只计一次，父子不重复）。 */
export function sumNaturalByPrefix(balances, prefixes) {
  let total = 0n;
  for (const [code, b] of balances) {
    if (prefixes.some((p) => underPrefix(code, p))) total += b.natural;
  }
  return total;
}

// ------------------------------------------------------------------ 资产卡片金额与期序
/** 卡片金额（分）：原值、残值、可折旧 / 摊销额、分期口径。
 * 分期金额按需 O(1) 计算（amountAt），不展开整张表：寿命再大也不会线性吃内存。
 */
export function cardMoney(card) {
  const originalCents = storedCents(card.original_cost);
  const residualCents = mulCentsByRatio(originalCents, card.residual_rate ?? 0);
  const depreciableCents = originalCents - residualCents;
  const life = Number(card.useful_life_months);
  const amountAt = (index) => evenSplitAmountCents(depreciableCents, life, index);
  return {
    originalCents, residualCents, depreciableCents, life, amountAt,
    monthlyCents: amountAt(0),
    finalMonthCents: amountAt(life - 1),
  };
}

/** 卡片显式取得 / 入账期间；未登记时为 null（绝不用 start_period 推测取得日）。 */
export const cardAcquiredPeriod = (card) => {
  const value = card.acquired_period;
  return value === undefined || value === null || value === "" ? null : String(value);
};

/**
 * 卡片在 period 是否已存在（参与资产 / 总账核对）。
 * - 已登记取得期间：按取得期间判断；
 * - **未登记取得期间：保守视为已存在**（参与核对并单独报缺项），
 *   不把「缺元数据」当成「前期不存在 / 本期刚购入」的证据。
 */
function cardExistsAt(card, period) {
  const acquired = cardAcquiredPeriod(card);
  if (acquired === null) return true;
  return isPeriod(acquired) ? acquired <= period : true;
}

/** 已过账计提金额（分）：截至 period（历史口径）。exclusive=true 时只统计**早于** period 的计提。 */
function postedRunCents(db, cardId, throughPeriod = null, { exclusive = false } = {}) {
  const rows = throughPeriod
    ? db.prepare(
      `SELECT r.amount FROM asset_depreciation_runs r JOIN vouchers v ON v.id = r.voucher_id
        WHERE r.asset_id=? AND v.status='posted' AND r.period${exclusive ? "<" : "<="}?`,
    ).all(cardId, throughPeriod)
    : db.prepare(
      `SELECT r.amount FROM asset_depreciation_runs r JOIN vouchers v ON v.id = r.voucher_id
        WHERE r.asset_id=? AND v.status='posted'`,
    ).all(cardId);
  return sumCents(rows.map((r) => r.amount));
}

/**
 * 按卡片**当前**定义计算该卡片在 period 应计提多少（分，O(1)）。
 * 与「本期是否真的存在计提记录」无关：
 *  - 期间非法 / 卡片当时尚不存在 / 未入账 / 未到期 / 已提足 / 已过寿命 → expectedCents = 0；
 *  - 否则 = min(分期表当期金额, 截至上一期剩余额)。
 * 用途：① 计算本期应提额；② 校验一张**旧草稿 / 已过账计提**是否仍与卡片定义一致
 * （原值 / 残值 / 寿命 / 起提期间 / 取得期间 / 期初累计 / 账簿状态任一改变都会让它失配）。
 */
export function expectedDepreciationCents(db, card, period, money = cardMoney(card)) {
  const index = monthsBetween(card.start_period, period);
  const openingCents = storedCents(card.opening_accumulated ?? 0);
  const beforeCents = openingCents + postedRunCents(db, card.id, period, { exclusive: true });
  const base = { index, openingCents, beforeCents };
  if (index === null) {
    return { ...base, status: "invalid", expectedCents: 0n, reason: "计提开始期间非法" };
  }
  if (!cardExistsAt(card, period)) {
    return {
      ...base, status: "not_existed", expectedCents: 0n,
      reason: `该期间卡片尚未取得 / 入账（取得期间 ${cardAcquiredPeriod(card)}），不应有计提`,
    };
  }
  if (index < 0) {
    return { ...base, status: "not_started", expectedCents: 0n, reason: `计提开始期间为 ${card.start_period}` };
  }
  if ((card.ledger_status ?? "booked") !== "booked") {
    return {
      ...base, status: "ledger_pending", expectedCents: 0n,
      reason: "卡片登记为尚未入固定资产账：不得计提，需先补真实购入 / 期初入账并核对总账一致后改为 booked",
    };
  }
  const remainingCents = money.depreciableCents - beforeCents;
  if (remainingCents <= 0n) {
    return { ...base, status: "fully_depreciated", expectedCents: 0n, reason: "截至上一期累计已提足，本期不应再提" };
  }
  if (index >= money.life) {
    return {
      ...base, status: "life_expired", expectedCents: 0n,
      reason: `已超过 ${money.life} 期寿命但累计未提足，需人工核对卡片或补提`,
    };
  }
  let dueCents = money.amountAt(index);
  if (dueCents > remainingCents) dueCents = remainingCents;
  if (dueCents < 0n) dueCents = 0n;
  if (dueCents === 0n) {
    // 极小金额按分取整后本期为 0（余额在后期提足）：不是阻塞项，也不是“已提足”。
    return {
      ...base, status: "no_amount_due", expectedCents: 0n,
      reason: "按分取整后本期应计提额为 0，余额在后续期提足",
    };
  }
  return { ...base, status: "due", expectedCents: dueCents };
}

/**
 * 单张卡片在 period 的计提状态：
 *  not_existed       该期间卡片尚未取得 / 入账（acquired_period 晚于 period）：不适用计提，也不阻塞
 *  not_started       未到计提开始期间（start_period 之后才开始计提，不等同取得日期）
 *  posted            本期已计提并过账，且金额仍与卡片当前定义一致
 *  posted_stale      本期已过账，但与卡片当前定义应提额（或科目）不一致：旧定义下的失效计提，
 *                    不能当成“已完成”（阻止封账），必须反过账 + 删除后重算
 *  draft_pending     本期存在未过账计提（必须删除或恢复，绝不双重入账）
 *  ledger_pending    卡片登记为「尚未入固定资产账」：不得计提，也不能作为已入账资产核对
 *  fully_depreciated 已提足（**截至该期间**的累计达到可折旧 / 摊销额，无法再提）
 *  life_expired      已过应有寿命（历史遗留多提检查）
 *  due               本期应计提但未计提（封账阻塞项）
 *  no_amount_due     按分取整后本期应计提额为 0（极小金额 / 尾差留到后期），不阻塞封账
 *
 * 期间口径（重要）：accumulated / remaining / fully_depreciated / amount 只由「截至 period」的
 * 已过账计提决定；globalAccumulatedCents / globalRemainingCents 只供**执行时**总额守卫使用，
 * **绝不**参与历史状态 / 历史应提额判定。旧库若已存在后期 run，历史 DTO 必须如实显示「截至该期间」
 * 的应提额，由 generateDepreciation 在执行时明确拒绝（depreciation_global_over_depreciable）
 * 并给出撤销顺序，而不是篡改历史应提额来掩盖超提。
 *
 * 适用期 / 金额口径（重要）：「本期没有计提记录」这一支**不再自己算**，而是直接复用
 * expectedDepreciationCents —— 与「已过账计提是否仍成立」用的是同一个判定。两处各写一套会导致
 * 自相矛盾：生成按分期表写入一个「卡片当时还不存在」的期间计提，检查又立刻判它 posted_stale，
 * 用户按指引删除后重新生成又写回同一张错误凭证（无限循环）。
 */
export function assetCardPeriodStatus(db, card, period, money = cardMoney(card)) {
  const index = monthsBetween(card.start_period, period);
  const openingCents = storedCents(card.opening_accumulated ?? 0);
  // 历史口径：累计只含**本期及以前**已过账计提，后期期间不能污染前期状态 / 前期重算。
  const accumulatedCents = openingCents + postedRunCents(db, card.id, period);
  const globalAccumulatedCents = openingCents + postedRunCents(db, card.id, null);
  const remainingCents = money.depreciableCents - accumulatedCents;
  // 全局可计提余额：只作为执行时（generateDepreciation）的总额守卫，不参与历史状态 / 应提额判定。
  const globalRemainingCents = money.depreciableCents - globalAccumulatedCents;
  const ledgerStatus = card.ledger_status ?? "booked";
  const run = db.prepare(
    `SELECT r.id, r.amount, v.id AS voucher_id, v.status AS voucher_status
       FROM asset_depreciation_runs r LEFT JOIN vouchers v ON v.id = r.voucher_id
      WHERE r.asset_id=? AND r.period=?`,
  ).get(card.id, period);
  const base = {
    assetId: card.id,
    name: card.name,
    kind: card.kind,
    startPeriod: card.start_period,
    acquiredPeriod: cardAcquiredPeriod(card),
    acquiredPeriodMissing: cardAcquiredPeriod(card) === null,
    periodIndex: index,
    depreciableCents: money.depreciableCents,
    accumulatedCents,
    globalAccumulatedCents,
    remainingCents,
    globalRemainingCents,
    ledgerStatus,
  };
  if (index === null) return { ...base, status: "invalid", reason: "计提开始期间非法" };
  if (run && run.voucher_status === "posted") {
    const recordedCents = storedCents(run.amount);
    // 已过账 ≠ 已完成：必须再用卡片**当前**定义重算本期应提额。
    // 反过账后改了寿命 / 原值 / 残值 / 起提期间 / 取得期间 / 期初累计 / 账簿状态时，
    // 旧的已过账计提就不再成立，必须报 posted_stale（阻止封账），绝不当成“已计提完成”放行。
    const expected = expectedDepreciationCents(db, card, period, money);
    const consistent = expected.status === "due"
      ? expected.expectedCents === recordedCents
      : recordedCents === 0n;
    if (consistent) return { ...base, status: "posted", amountCents: recordedCents };
    return {
      ...base,
      status: "posted_stale",
      amountCents: recordedCents,
      expectedCents: expected.expectedCents,
      expectedStatus: expected.status,
      reason: `已过账计提 ${formatCents(recordedCents)} 与卡片当前定义应提 ${formatCents(expected.expectedCents)} 不一致`
        + `（${expected.reason ?? expected.status}）：需反过账并删除旧计提凭证，按当前定义重新计提`,
    };
  }
  if (run) {
    return {
      ...base,
      status: "draft_pending",
      amountCents: storedCents(run.amount),
      voucherId: run.voucher_id ?? null,
      reason: "本期存在未过账计提记录，需先删除或恢复该凭证",
    };
  }
  // 没有本期计提记录：适用期 / 金额口径与上面的「已过账计提校验」共用同一 helper（expectedDepreciationCents）。
  // 取得期间 / 未入固定资产账 / 未到起提期间 / 已提足 / 已过寿命 / 按分取整为 0 全部由那一处判定，
  // 因此「生成」与「验证」不可能再给出互相矛盾的结论。
  const expected = expectedDepreciationCents(db, card, period, money);
  if (expected.status === "due") {
    return { ...base, status: "due", amountCents: expected.expectedCents };
  }
  // 不适用计提的期间（卡片尚未取得 / 未到起提期间 / 期间非法）不给 dueAmount（null），
  // 保持既有 DTO 口径：0 只用于「算出来确实是 0」或「已提足 / 未入账」。
  const notApplicable = ["not_existed", "not_started", "invalid"].includes(expected.status);
  return {
    ...base,
    // invalid / not_existed / not_started / ledger_pending / fully_depreciated / life_expired / no_amount_due
    status: expected.status,
    ...(notApplicable ? {} : { amountCents: 0n }),
    reason: expected.reason ?? expected.status,
  };
}

/** 卡片的计提状态 DTO（对外 / 检查结果）：金额转回两位小数。 */
function cardStatusDto(status) {
  return {
    assetId: status.assetId,
    name: status.name,
    kind: status.kind,
    status: status.status,
    startPeriod: status.startPeriod,
    acquiredPeriod: status.acquiredPeriod,
    acquiredPeriodMissing: status.acquiredPeriodMissing,
    periodIndex: status.periodIndex,
    ledgerStatus: status.ledgerStatus,
    depreciable: centsToNumber(status.depreciableCents),
    accumulated: centsToNumber(status.accumulatedCents),
    accumulatedTotal: centsToNumber(status.globalAccumulatedCents),
    remaining: centsToNumber(status.remainingCents),
    dueAmount: status.amountCents === undefined ? null : centsToNumber(status.amountCents),
    expectedAmount: status.expectedCents === undefined ? null : centsToNumber(status.expectedCents),
    reason: status.reason ?? null,
  };
}

// ------------------------------------------------------------------ 步骤：资产 / 总账核对
/** 把明细科目余额归集到与之匹配的最长根科目（父子科目只计一次）。 */
function groupGlByRoot(balances, roots) {
  const out = new Map();
  for (const [code, b] of balances) {
    let best = null;
    for (const root of roots) {
      if (underPrefix(code, root) && (best === null || String(root).length > String(best).length)) best = root;
    }
    if (best !== null) out.set(best, (out.get(best) || 0n) + b.natural);
  }
  return out;
}

function assetReconciliationStep(db, setId, period, roles) {
  const cards = db.prepare(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`).all(setId);
  const balances = balancesThrough(db, setId, period);
  const assetRoots = new Set([
    ...ASSET_ACCOUNT_CODES, roles.fixedAsset, roles.intangibleAsset,
  ].filter(Boolean));
  const accumRoots = new Set([
    ...ACCUM_ACCOUNT_CODES, roles.accumulatedDepreciation, roles.accumulatedAmortization,
  ].filter(Boolean));
  for (const card of cards) {
    assetRoots.add(String(card.asset_account));
    accumRoots.add(String(card.accum_account));
  }

  const cardAssetTotals = new Map();
  const cardAccumTotals = new Map();
  const pendingLedger = [];
  const missingMetadata = [];
  for (const card of cards) {
    const money = cardMoney(card);
    const exists = cardExistsAt(card, period);
    const ledgerStatus = card.ledger_status ?? "booked";
    const acquired = cardAcquiredPeriod(card);
    if (acquired === null) {
      // 缺取得期间：不用 start_period 推测存在性，也不静默当成“前期不存在”。
      // 保守按“已存在”参与核对，并列出明确缺项，经资产维护入口补登记后解除。
      missingMetadata.push({
        assetId: card.id,
        name: card.name,
        message: `卡片「${card.name}」未登记取得 / 入账期间，无法确定各期间是否存在，需先补登记`,
      });
    }
    // 累计折旧/摊销：无论卡片是否已登记入账，已过账计提都会记入总账，必须参与累计核对。
    const accumCode = String(card.accum_account);
    const opening = exists ? storedCents(card.opening_accumulated ?? 0) : 0n;
    const runs = exists ? postedRunCents(db, card.id, period) : 0n;
    cardAccumTotals.set(accumCode, (cardAccumTotals.get(accumCode) || 0n) + opening + runs);
    // 「尚未入固定资产账」不是豁免：账面没有原值就不能当作已入账资产，必须继续参与原值核对，
    // 并额外给出明确缺项（真实补购入 / 期初入账后改正状态才能真正解除）。
    // 但只统计**该期间已存在**的卡片：取得期间在查询期间之后的卡片，本期根本没有这项资产，
    // 不应把它的待补凭证登记跨期前置成阻塞（缺取得期间仍按“已存在”保守报告）。
    if (exists && ledgerStatus !== "booked") {
      pendingLedger.push({
        assetId: card.id,
        name: card.name,
        ledgerStatus,
        note: card.ledger_note || "",
        originalCost: centsToNumber(money.originalCents),
      });
    }
    if (exists) {
      const code = String(card.asset_account);
      cardAssetTotals.set(code, (cardAssetTotals.get(code) || 0n) + money.originalCents);
    }
  }

  const issues = [];
  const compare = (kind, roots, cardTotals) => {
    const glTotals = groupGlByRoot(balances, roots);
    const codes = new Set([...glTotals.keys(), ...cardTotals.keys()]);
    for (const code of codes) {
      const glCents = glTotals.get(code) ?? 0n;
      const cardCents = cardTotals.get(code) ?? 0n;
      const difference = glCents - cardCents;
      if (difference === 0n) continue;
      const missingCard = kind === "asset" && cardCents === 0n && glCents !== 0n;
      issues.push({
        kind,
        code,
        issueCode: missingCard ? "asset_missing_card" : kind === "asset" ? "asset_cost_mismatch" : "asset_accumulated_mismatch",
        glBalance: centsToNumber(glCents),
        cardTotal: centsToNumber(cardCents),
        difference: centsToNumber(difference),
        message: missingCard
          ? `总账科目 ${code} 有余额 ${formatCents(glCents)}，但没有对应资产卡片（缺卡片）`
          : kind === "asset"
            ? `资产卡片原值合计 ${formatCents(cardCents)} 与总账原值 ${formatCents(glCents)} 不一致（差额 ${formatCents(difference)}）`
            : `资产卡片累计折旧/摊销 ${formatCents(cardCents)} 与总账 ${formatCents(glCents)} 不一致（差额 ${formatCents(difference)}）`,
      });
    }
  };
  compare("asset", assetRoots, cardAssetTotals);
  compare("accum", accumRoots, cardAccumTotals);

  const totals = {
    asset: centsToNumber([...cardAssetTotals.values()].reduce((s, v) => s + v, 0n)),
    accumulated: centsToNumber([...cardAccumTotals.values()].reduce((s, v) => s + v, 0n)),
  };
  const blocking = issues.map((issue) => ({
    code: issue.issueCode,
    message: issue.message,
    details: {
      accountCode: issue.code,
      kind: issue.kind,
      glBalance: issue.glBalance,
      cardTotal: issue.cardTotal,
      difference: issue.difference,
    },
  }));
  for (const item of missingMetadata) {
    blocking.push({
      code: "asset_acquired_period_missing",
      message: item.message,
      details: { assetId: item.assetId, name: item.name },
    });
  }
  for (const item of pendingLedger) {
    blocking.push({
      code: "asset_purchase_voucher_pending",
      message: `卡片「${item.name}」登记为尚未入固定资产账（${item.note || "未填写原因"}）：登记本身不是原值入账证据，不能跳过卡片 / 总账核对，也不能据此计提；请补录真实购入或期初入账凭证、核对一致后把卡片改为 booked`,
      details: {
        assetId: item.assetId,
        name: item.name,
        ledgerStatus: item.ledgerStatus,
        originalCost: item.originalCost,
        note: item.note,
      },
    });
  }
  const details = { cards: cards.length, totals, pendingLedger, missingMetadata };
  if (!cards.length && !issues.length) {
    return {
      id: "asset_reconciliation",
      title: "资产卡片与总账核对",
      status: PERIOD_END_STATUS.NOT_APPLICABLE,
      reason: "本账套没有资产卡片，相关总账科目也没有余额",
      details,
    };
  }
  if (blocking.length) {
    return {
      id: "asset_reconciliation",
      title: "资产卡片与总账核对",
      status: PERIOD_END_STATUS.BLOCKED,
      reason: missingMetadata.length && !issues.length && !pendingLedger.length
        ? `${missingMetadata.length} 张卡片缺取得 / 入账期间（明确缺项，补登记后可封账）`
        : `${blocking.length} 项卡片 / 总账差异、未入账登记或补项缺项，必须先处理后才可封账`,
      blocking,
      details,
    };
  }
  return {
    id: "asset_reconciliation",
    title: "资产卡片与总账核对",
    status: PERIOD_END_STATUS.OK,
    reason: "卡片原值与累计折旧/摊销均与总账一致",
    details,
  };
}

// 各期间的已过账计提统一用 postedRunCents(db, cardId, throughPeriod) 汇总。

// ------------------------------------------------------------------ 步骤：计提完整性
function depreciationStep(db, setId, period) {
  const cards = db.prepare(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`).all(setId);
  if (!cards.length) {
    return {
      id: "depreciation",
      title: "应计提折旧 / 摊销完整",
      status: PERIOD_END_STATUS.NOT_APPLICABLE,
      reason: "本账套没有资产卡片，本期无应计提折旧或摊销",
      details: { cards: [] },
    };
  }
  const statuses = cards.map((card) => assetCardPeriodStatus(db, card, period));
  const due = statuses.filter((s) => s.status === "due");
  const draft = statuses.filter((s) => s.status === "draft_pending");
  const expired = statuses.filter((s) => s.status === "life_expired");
  const ledgerPending = statuses.filter((s) => s.status === "ledger_pending");
  const stale = statuses.filter((s) => s.status === "posted_stale");
  const blocking = [];
  for (const s of stale) {
    blocking.push({
      code: "depreciation_run_stale",
      message: `资产「${s.name}」本期已过账计提 ${formatCents(s.amountCents)} 与卡片当前定义应提 ${formatCents(s.expectedCents)} 不一致`
        + `（${s.reason ?? "卡片定义已变更"}）：旧草稿重过账 / 旧计提凭证不能继续生效，请反过账并删除旧计提凭证后重新计提`,
      details: {
        assetId: s.assetId, period,
        recordedAmount: centsToNumber(s.amountCents),
        expectedAmount: centsToNumber(s.expectedCents),
        expectedStatus: s.expectedStatus ?? null,
        guidance: "反过账该计提凭证 → 删除旧计提凭证（连带旧 run）→ 按当前卡片定义重新计提；不接受把旧草稿直接重过账",
      },
    });
  }
  for (const s of ledgerPending) {
    blocking.push({
      code: "asset_ledger_pending",
      message: `资产「${s.name}」登记为尚未入固定资产账：不得计提，请补录真实购入 / 期初入账凭证、核对卡片原值与总账一致后改为 booked`,
      details: { assetId: s.assetId, period, ledgerStatus: s.ledgerStatus },
    });
  }
  for (const s of due) {
    blocking.push({
      code: "depreciation_missing",
      message: `资产「${s.name}」本期应计提 ${formatCents(s.amountCents)}（累计 ${formatCents(s.accumulatedCents)} / 可计提 ${formatCents(s.depreciableCents)}）`,
      details: { assetId: s.assetId, dueAmount: centsToNumber(s.amountCents) },
    });
  }
  for (const s of draft) {
    blocking.push({
      code: "depreciation_draft_exists",
      message: `资产「${s.name}」本期存在未过账计提（凭证 ${s.voucherId ?? "已删除"}），需先删除或恢复`,
      details: { assetId: s.assetId, voucherId: s.voucherId ?? null },
    });
  }
  for (const s of expired) {
    blocking.push({
      code: "depreciation_life_expired_underprovided",
      message: `资产「${s.name}」已过计提寿命但累计未提足（剩余 ${formatCents(s.remainingCents)}），需人工核对`,
      details: { assetId: s.assetId, remaining: centsToNumber(s.remainingCents) },
    });
  }
  const details = { cards: statuses.map(cardStatusDto) };
  if (blocking.length) {
    return {
      id: "depreciation",
      title: "应计提折旧 / 摊销完整",
      status: PERIOD_END_STATUS.BLOCKED,
      reason: `${blocking.length} 项计提未完成或状态不一致`,
      blocking,
      details,
    };
  }
  const posted = statuses.filter((s) => s.status === "posted").length;
  return {
    id: "depreciation",
    title: "应计提折旧 / 摊销完整",
    status: PERIOD_END_STATUS.OK,
    reason: `本期应计提项均已过账（已计提 ${posted} 张，其余为尚未取得 / 未到期 / 已提足）`,
    details,
  };
}

// ------------------------------------------------------------------ 步骤：损益结转
function profitCarryStep(db, setId, period, roles) {
  const accounts = accountRows(db, setId);
  const plAccounts = accounts.filter((a) => a.category === "损益");
  const balances = balancesThrough(db, setId, period);
  const movement = postedEntryRows(db, setId, { fromPeriod: period, toPeriod: period, excludeCarryforward: true })
    .filter((row) => plAccounts.some((a) => row.code === a.code))
    .reduce((s, row) => s + storedCents(row.debit) + storedCents(row.credit), 0n);
  const nonzero = plAccounts
    .map((a) => ({ account: a, natural: balances.get(a.code)?.natural ?? 0n }))
    .filter((x) => x.natural !== 0n);
  const details = {
    movement: centsToNumber(movement),
    accounts: nonzero.map((x) => ({
      code: x.account.code,
      name: x.account.name,
      balance: centsToNumber(x.natural),
    })),
  };
  if (movement === 0n && !nonzero.length) {
    return {
      id: "profit_carry_forward",
      title: `损益结转（结转本期损益到 ${roles.currentYearProfit}）`,
      status: PERIOD_END_STATUS.NOT_APPLICABLE,
      reason: "本账套本期没有损益类发生额，也无未结转损益余额",
      details,
    };
  }
  if (nonzero.length) {
    const postedCarry = db.prepare(
      `SELECT COUNT(*) AS n FROM vouchers v WHERE v.account_set_id=? AND v.period=? AND v.status='posted' AND v.kind='carryforward'
         AND EXISTS (SELECT 1 FROM voucher_entries e JOIN accounts a ON a.account_set_id=v.account_set_id AND a.code=e.code
                      WHERE e.voucher_id=v.id AND a.category='损益')`,
    ).get(setId, period).n;
    return {
      id: "profit_carry_forward",
      title: `损益结转（结转本期损益到 ${roles.currentYearProfit}）`,
      status: PERIOD_END_STATUS.BLOCKED,
      reason: postedCarry
        ? "已存在结转凭证，但之后又有损益分录，导致结转失效（不能按“曾经执行过”放行）"
        : nonzero.length === 1
          ? "损益类科目仍有余额，说明本期结转未做"
          : `${nonzero.length} 个损益类科目仍有余额，说明本期结转未做`,
      blocking: [{
        code: postedCarry ? "profit_carry_stale" : "profit_not_carried_forward",
        message: postedCarry
          ? "先反过账本期旧结转凭证，重新执行结转本期损益后再封账"
          : "请先执行结转本期损益（carry_forward_profit）后再封账",
        details,
      }],
      details,
    };
  }
  return {
    id: "profit_carry_forward",
    title: `损益结转（结转本期损益到 ${roles.currentYearProfit}）`,
    status: PERIOD_END_STATUS.OK,
    reason: `本期损益已全部结转到 ${roles.currentYearProfit}（损益类科目余额为零）`,
    details,
  };
}

function yearEndCarryStep(db, setId, period, roles) {
  const balances = balancesThrough(db, setId, period);
  const carry = sumNaturalByPrefix(balances, [roles.currentYearProfit]);
  const details = { period, carryBalance: centsToNumber(carry) };
  if (!String(period).endsWith("-12")) {
    return {
      id: "year_end_carry_forward",
      title: `年末结转（${roles.currentYearProfit} → ${roles.profitDistribution}）`,
      status: PERIOD_END_STATUS.NOT_APPLICABLE,
      reason: "非 12 月期间，不做年末利润分配结转",
      details,
    };
  }
  if (carry !== 0n) {
    return {
      id: "year_end_carry_forward",
      title: `年末结转（${roles.currentYearProfit} → ${roles.profitDistribution}）`,
      status: PERIOD_END_STATUS.BLOCKED,
      reason: `12 月末 ${roles.currentYearProfit} 仍有余额 ${formatCents(carry)}，必须结转本年利润后才可封账`,
      blocking: [{
        code: "year_end_not_carried",
        message: `请以 yearEnd=true 再执行一次结转本期损益（${roles.currentYearProfit} → ${roles.profitDistribution}）`,
        details,
      }],
      details,
    };
  }
  return {
    id: "year_end_carry_forward",
    title: `年末结转（${roles.currentYearProfit} → ${roles.profitDistribution}）`,
    status: PERIOD_END_STATUS.OK,
    reason: `12 月末 ${roles.currentYearProfit} 已结转完毕`,
    details,
  };
}

// ------------------------------------------------------------------ 步骤：草稿 / 试算平衡 / 期间顺序
function draftStep(db, setId, period) {
  const drafts = db.prepare(
    `SELECT id, word, number, summary FROM vouchers
      WHERE account_set_id=? AND period=? AND status='draft' ORDER BY number, id`,
  ).all(setId, period);
  if (!drafts.length) {
    return {
      id: "draft_vouchers",
      title: "本期无未过账草稿凭证",
      status: PERIOD_END_STATUS.OK,
      reason: "本期草稿凭证为 0",
      details: { drafts: [] },
    };
  }
  return {
    id: "draft_vouchers",
    title: "本期无未过账草稿凭证",
    status: PERIOD_END_STATUS.BLOCKED,
    reason: `本期还有 ${drafts.length} 张草稿凭证，必须先过账或删除`,
    blocking: [{
      code: "period_has_draft_vouchers",
      message: `草稿凭证：${drafts.map((v) => `${v.word}-${v.number}`).join("、")}`,
      details: { voucherIds: drafts.map((v) => v.id) },
    }],
    details: { drafts: drafts.map((v) => ({ id: v.id, word: v.word, number: v.number, summary: v.summary })) },
  };
}

function trialBalanceStep(db, setId, period) {
  const balances = balancesThrough(db, setId, period);
  let debit = 0n, credit = 0n;
  for (const b of balances.values()) {
    if (b.net > 0n) debit += b.net;
    else if (b.net < 0n) credit += -b.net;
  }
  const difference = debit - credit;
  const details = {
    closingDebit: centsToNumber(debit),
    closingCredit: centsToNumber(credit),
    difference: centsToNumber(difference),
  };
  if (difference !== 0n) {
    return {
      id: "trial_balance",
      title: "试算平衡",
      status: PERIOD_END_STATUS.BLOCKED,
      reason: `期末借贷不平：借 ${formatCents(debit)} / 贷 ${formatCents(credit)}`,
      blocking: [{ code: "period_unbalanced", message: "期末借贷不平，禁止封账", details }],
      details,
    };
  }
  return {
    id: "trial_balance",
    title: "试算平衡",
    status: PERIOD_END_STATUS.OK,
    reason: `期末借贷平衡（${formatCents(debit)}）`,
    details,
  };
}

function periodSequenceStep(db, setId, period) {
  const periods = periodRows(db, setId);
  const closed = new Set(periods.filter((p) => p.status === "closed").map((p) => p.period));
  const earlierRegisteredOpen = periods.filter((p) => p.period < period && p.status !== "closed");
  // 只有「已有业务证据的更早未封账期间」才构成跳过期限的风险：完全无适用业务的空期间不需要先封账，
  // 否则一家企业开账后只在年底录账时，会被一年空期间永久阻住。
  // 业务证据不止凭证：本期无凭证不代表没有应计提折旧 / 摊销（期初投入的资产、导入的卡片都一样）。
  const withActivity = new Set(
    db.prepare(`SELECT DISTINCT period FROM vouchers WHERE account_set_id=? AND period<?`).all(setId, period)
      .map((r) => r.period),
  );
  const depreciationPending = earlierPeriodsWithDepreciationBusiness(db, setId, period)
    .filter((item) => !closed.has(item.period));
  const earlierBlocking = [...new Set([
    ...earlierRegisteredOpen.filter((p) => withActivity.has(p.period)).map((p) => p.period),
    ...depreciationPending.map((item) => item.period),
  ])].sort();
  const laterClosed = periods.filter((p) => p.period > period && p.status === "closed");
  // details 对外必须是可 JSON 序列化的值：金额已在 earlierPeriodsWithDepreciationBusiness 里转成两位小数。
  const depreciationDetails = depreciationPending.map((item) => ({
    period: item.period,
    assets: item.assets.map((asset) => ({
      assetId: asset.assetId, name: asset.name, status: asset.status,
      dueAmount: asset.dueAmount, reason: asset.reason,
    })),
  }));
  const details = {
    earlierRegisteredOpen: earlierRegisteredOpen.map((p) => p.period),
    earlierWithActivity: earlierBlocking.map((p) => p.period),
    earlierDepreciationPending: depreciationDetails,
    laterClosed: laterClosed.map((p) => p.period),
  };
  const blocking = [];
  if (laterClosed.length) {
    blocking.push({
      code: "later_period_closed",
      message: `以下更晚期间已封账：${laterClosed.map((p) => p.period).join("、")}；封账必须按期间顺序进行，请先按倒序反结账这些期间`,
      details,
    });
  }
  if (depreciationPending.length) {
    blocking.push({
      code: "previous_period_depreciation_pending",
      message: `以下更早期间仍有应计提折旧 / 摊销未完成：${depreciationPending
        .map((item) => `${item.period}（${item.assets.map((a) => `${a.name} ${formatCents(a.dueCents)}`).join("、")}）`)
        .join("；")}；无凭证不代表没有应计提业务，请先按期间顺序完成这些期间的计提 / 结转 / 封账`,
      details,
    });
  }
  if (earlierBlocking.length) {
    blocking.push({
      code: "previous_period_open",
      message: `以下更早期间已有业务但未封账：${earlierBlocking.join("、")}；请先按顺序封账更早期间`,
      details,
    });
  }
  if (blocking.length) {
    return {
      id: "period_sequence",
      title: "连续期间顺序",
      status: PERIOD_END_STATUS.BLOCKED,
      reason: "封账必须按期间顺序，不得跨过已有业务的未封账期间或先行封账后期",
      blocking,
      details,
    };
  }
  return {
    id: "period_sequence",
    title: "连续期间顺序",
    status: PERIOD_END_STATUS.OK,
    reason: "更早的已登记且有业务的期间均已封账，且没有更晚期间先行封账",
    details,
  };
}

/**
 * 更早期间是否仍有「应计提但未计提」的资产业务（无凭证也算业务）。
 * 返回 [{ period, assets: [{ assetId, name, status, dueAmount, reason }] }]，按期间升序。
 * 只认 due / draft_pending / life_expired：已过账的计提本身就产生凭证（已计入凭证证据），
 * no_amount_due（按分取整后为 0）不构成需要先封账的业务。
 */
function earlierPeriodsWithDepreciationBusiness(db, setId, period) {
  const cards = db.prepare(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`).all(setId);
  if (!cards.length) return [];
  const startPeriod = db.prepare(`SELECT start_period FROM account_sets WHERE id=?`).get(setId)?.start_period;
  let cursor = null;
  for (const card of cards) {
    const start = String(card.start_period ?? "");
    if (!isPeriod(start)) continue;
    if (cursor === null || start < cursor) cursor = start;
  }
  if (cursor === null) return [];
  if (isPeriod(startPeriod) && startPeriod > cursor) cursor = startPeriod;
  const out = [];
  let guard = 0;
  while (cursor < period && guard < 1200) {
    guard += 1;
    const assets = cards
      .map((card) => assetCardPeriodStatus(db, card, cursor))
      .filter((status) => ["due", "draft_pending", "life_expired"].includes(status.status))
      .map((status) => ({
        assetId: status.assetId,
        name: status.name,
        status: status.status,
        dueCents: status.amountCents ?? 0n,
        dueAmount: centsToNumber(status.amountCents ?? 0n),
        reason: status.reason ?? null,
      }));
    if (assets.length) out.push({ period: cursor, assets });
    cursor = nextMonth(cursor);
  }
  return out;
}

// ------------------------------------------------------------------ 汇总检查
/**
 * 期末检查：返回逐步状态（ok / blocked / not_applicable）+ 明确缺项。
 * 默认包含全部步骤；封账调用可 skip 已单独报错的步骤以避免重复错误码。
 */
export function buildPeriodEndCheck(db, setId, period, { skip = [] } = {}) {
  const { profile, roles, context } = accountSetProfileForControls(db, setId);
  // 必要性角色必须先能落到真实科目上，再谈“检查通过”：缺角色 / 语义冲突不允许静默封账。
  const existingCodes = new Set(
    db.prepare(`SELECT code FROM accounts WHERE account_set_id=?`).all(setId).map((row) => row.code),
  );
  const roleRows = new Map(
    db.prepare(`SELECT code, name, category, direction, contra FROM accounts WHERE account_set_id=?`).all(setId)
      .map((row) => [row.code, row]),
  );
  for (const role of ["currentYearProfit", "profitDistribution", "defaultDepreciationExpense"]) {
    const code = roles[role];
    if (typeof code !== "string" || !code || !existingCodes.has(code)) {
      const error = new Error("accounting_role_missing");
      error.code = "accounting_role_missing";
      error.details = {
        field: role,
        profileId: profile.id,
        ...(typeof code === "string" && code ? { accountCode: code } : {}),
        reason: "role-account-missing",
      };
      throw error;
    }
    // 角色科目也必须与准则映射语义一致（类别 / 方向 / 备抵）：库内元数据被污染时不允许静默封账。
    const semantics = accountProfileSemantics(profile, roleRows.get(code));
    if (semantics.reasons.length) {
      const error = new Error("accounting_role_semantics_conflict");
      error.code = "accounting_role_semantics_conflict";
      error.details = { field: role, profileId: profile.id, ...semanticsConflict(semantics, conflictField(semantics.reasons[0]), semantics.reasons[0]) };
      throw error;
    }
  }
  // 参与结转的科目行语义冲突同样在检查阶段明确拒绝，避免“期末检查说已结转、结转却失败”的不一致。
  const carryConflicts = carryForwardSemanticsConflicts(db, setId, profile, roles, period, {
    yearEnd: String(period).endsWith("-12"),
  });
  if (carryConflicts.length) {
    const error = new Error("carryforward_account_semantics_conflict");
    error.code = "carryforward_account_semantics_conflict";
    error.details = { source: "period-end-check", period, conflicts: carryConflicts };
    throw error;
  }
  const steps = [
    draftStep(db, setId, period),
    trialBalanceStep(db, setId, period),
    depreciationStep(db, setId, period),
    assetReconciliationStep(db, setId, period, roles),
    profitCarryStep(db, setId, period, roles),
    yearEndCarryStep(db, setId, period, roles),
    periodSequenceStep(db, setId, period),
  ].filter((step) => !skip.includes(step.id));
  const auxiliary = auxiliaryCompletenessStep(db, setId, period);
  if (auxiliary) steps.push(auxiliary);
  const blocking = [];
  for (const step of steps) {
    for (const item of step.blocking || []) {
      blocking.push({ step: step.id, title: step.title, code: item.code, message: item.message, details: item.details ?? null });
    }
  }
  // 固定诊断码只作提示：legacy 兼容 / 登记准则与持久 profile 不一致不作为自动封账阻塞；
  // 真正阻止写入的是未知 profile / 缺失或有冲突的必要角色（由 accountSetProfileForControls 与写入入口负责）。
  const warnings = [];
  if (profile.legacy) {
    warnings.push({
      code: "legacy_profile_compatibility",
      severity: "warning",
      reportKind: "period-end-check",
      reason: "legacy-profile-uses-old-report-path",
    });
  } else if (context.declaredStandard !== profile.declaredStandard) {
    warnings.push({
      code: "declared_standard_profile_mismatch",
      severity: "warning",
      reportKind: "period-end-check",
      reason: "declared-standard-differs-from-profile",
    });
  }
  return {
    accountSetId: setId,
    period,
    accountingContext: context,
    warnings,
    ready: blocking.length === 0,
    steps,
    blocking,
    missing: blocking.map((b) => ({ step: b.step, code: b.code, message: b.message })),
    rules: {
      moneyScale: 2,
      rounding: "ROUND_HALF_UP",
      maxAmount: MONEY_MAX_TEXT,
      profitAccount: roles.currentYearProfit,
      retainedEarningsAccount: roles.profitDistribution,
      defaultDepreciationExpense: roles.defaultDepreciationExpense,
      note: "所有金额按分（整数分）计算，四舍五入到分；检查与实际计提 / 结转共用同一规则；结转 / 利润分配科目按账套持久 profile 解析",
    },
  };
}

/** 封账前置断言：不通过时抛 period_end_check_failed（带逐步明细）。 */
export function assertPeriodCloseable(db, setId, period, { skip = [] } = {}) {
  const check = buildPeriodEndCheck(db, setId, period, { skip });
  if (check.ready) return check;
  const err = new Error("period_end_check_failed");
  err.code = "period_end_check_failed";
  err.details = {
    accountSetId: setId,
    period,
    blocking: check.blocking,
    steps: check.steps.map((s) => ({ id: s.id, status: s.status, reason: s.reason ?? null })),
  };
  throw err;
}

// ------------------------------------------------------------------ 前期可改性守卫
/**
 * 后续期间（默认严格更晚）已过账的普通损益结转。
 * 普通结转按「截至该期间的累计损益余额」生成，因此依赖**所有**前期损益发生额，
 * 不能假设「普通结转只依本期」。
 */
export function laterProfitCarryforwards(db, setId, period, { inclusive = false } = {}) {
  const op = inclusive ? ">=" : ">";
  return db.prepare(
    `SELECT v.id, v.period, v.word, v.number FROM vouchers v
      WHERE v.account_set_id=? AND v.period${op}? AND v.status='posted' AND v.kind='carryforward'
        AND EXISTS (SELECT 1 FROM voucher_entries e JOIN accounts a
                     ON a.account_set_id=v.account_set_id AND a.code=e.code
                    WHERE e.voucher_id=v.id AND a.category='损益')
      ORDER BY v.period, v.id`,
  ).all(setId, period);
}

/**
 * 后续期间（默认严格更晚）已过账的资产计提。
 * 计提按「卡片事实 + 截至该期间的累计已提」分期，因此依赖前期计提状态与卡片金额 / 期间事实。
 */
export function laterDepreciationRuns(db, setId, period, { inclusive = false, excludeVoucherId = null } = {}) {
  const op = inclusive ? ">=" : ">";
  return db.prepare(
    `SELECT r.id, r.asset_id, r.period, r.amount, r.voucher_id
       FROM asset_depreciation_runs r JOIN vouchers v ON v.id=r.voucher_id
      WHERE r.account_set_id=? AND v.status='posted' AND r.period${op}?
        AND (? IS NULL OR r.voucher_id<>?)
      ORDER BY r.period, r.asset_id`,
  ).all(setId, period, excludeVoucherId, excludeVoucherId);
}

/**
 * 修改某个期间的账簿前的依赖守卫（反过账 / 删除 / 新增凭证 / 过账 / 反结账 / 计提 / 结转 / 期初 / 导入）：
 *  - 更晚期间已封账：直接拒绝，给出「按倒序反结账」的可执行顺序；
 *  - 更晚期间已有已过账年末结转（3103 → 3104）：该结转依赖本年累计利润，前期变动会让它失效；
 *  - touches.profit：本次写入会改变损益余额时，后续期间的**普通**损益结转同样依赖累计余额 → 拒绝；
 *  - touches.depreciation：本次写入会改变计提时，后续期间已过账计提依赖前期计提状态 → 拒绝。
 * 这些都是「明确拒绝 + 可执行撤销顺序」，绝不在保留后期错误已过账派生结果的同时放行前期修改。
 */
export function assertPeriodMutable(db, setId, period, { operation = "modify", touches = null } = {}) {
  const { roles } = accountSetProfileForControls(db, setId);
  const want = { profit: touches?.profit === true, depreciation: touches?.depreciation === true };
  const periods = periodRows(db, setId);
  const laterClosed = periods.filter((p) => p.period > period && p.status === "closed").map((p) => p.period);
  if (laterClosed.length) {
    const err = new Error("later_period_closed");
    err.code = "later_period_closed";
    err.details = {
      operation,
      period,
      laterClosedPeriods: laterClosed,
      guidance: `修改 ${period} 之前必须按倒序反结账：${laterClosed.slice().reverse().join(" → ")}`,
    };
    throw err;
  }
  // 后续已过账年末结转：按 profile 的本年利润 / 利润分配角色识别（企业 4103→4104，小企 / legacy 3103→3104）。
  const yearEndCandidates = db.prepare(
    `SELECT v.id, v.period, v.word, v.number FROM vouchers v
      WHERE v.account_set_id=? AND v.period>? AND v.status='posted' AND v.kind='carryforward'
        AND NOT EXISTS (SELECT 1 FROM voucher_entries e JOIN accounts a ON a.account_set_id=v.account_set_id AND a.code=e.code
                         WHERE e.voucher_id=v.id AND a.category='损益')
      ORDER BY v.period`,
  ).all(setId, period);
  const carryRoots = [roles.currentYearProfit, roles.profitDistribution];
  const yearEnd = yearEndCandidates.filter((voucher) => db.prepare(
    `SELECT code FROM voucher_entries WHERE voucher_id=?`,
  ).all(voucher.id).some((entry) => carryRoots.some((root) => entry.code === root || String(entry.code).startsWith(root))));
  if (yearEnd.length) {
    const err = new Error("later_year_end_carryforward_depends_on_period");
    err.code = "later_year_end_carryforward_depends_on_period";
    err.details = {
      operation,
      period,
      dependencies: yearEnd.map((v) => ({ voucherId: v.id, period: v.period, word: v.word, number: v.number })),
      guidance: `后续期间的年末结转依赖本年累计利润：先反过账 ${yearEnd.map((v) => `${v.period} ${v.word}-${v.number}`).join("、")}，修改前期后按顺序重新结转`,
    };
    throw err;
  }
  if (want.profit) {
    const carries = laterProfitCarryforwards(db, setId, period);
    if (carries.length) {
      const err = new Error("later_profit_carryforward_depends_on_period");
      err.code = "later_profit_carryforward_depends_on_period";
      err.details = {
        operation,
        period,
        dependencies: carries.map((v) => ({ voucherId: v.id, period: v.period, word: v.word, number: v.number })),
        guidance: `后续期间的普通损益结转按「截至该期间的累计损益余额」生成，依赖 ${period} 的损益发生额：请先按倒序反过账 ${carries
          .slice().reverse().map((v) => `${v.period} ${v.word}-${v.number}`).join("、")}，修改前期后按期间顺序重新结转`,
      };
      throw err;
    }
  }
  if (want.depreciation) {
    const runs = laterDepreciationRuns(db, setId, period, {
      excludeVoucherId: touches?.depreciationExcludeVoucherId ?? null,
    });
    if (runs.length) {
      const err = new Error("later_depreciation_depends_on_period");
      err.code = "later_depreciation_depends_on_period";
      err.details = {
        operation,
        period,
        runs: runs.map((r) => ({
          assetId: r.asset_id, period: r.period, amount: centsToNumber(storedCents(r.amount)), voucherId: r.voucher_id,
        })),
        guidance: `后续期间已过账计提依赖前期计提状态与卡片事实：请先按倒序反过账并删除 ${[...new Set(runs.map((r) => r.period))]
          .slice().reverse().join(" → ")} 的计提凭证，修改 / 重算前期后按期间顺序重新计提`,
      };
      throw err;
    }
  }
}

// ------------------------------------------------------------------ 资产卡片维护守卫
/** 卡片金额 / 期间事实字段：改动会改变已入账的核对结果或后续计提金额。 */
const CARD_AMOUNT_FIELDS = [
  "original_cost", "residual_rate", "useful_life_months", "start_period",
  "opening_accumulated", "ledger_status", "asset_account", "accum_account", "kind",
];
/**
 * 会改变折旧 / 摊销**金额或适用性**的字段（影响损益 → 影响后续已过账普通结转）。
 * 取得期间、科目映射只影响「某期间是否存在 / 记到哪个科目」，不改变折旧金额，不含在内。
 */
const CARD_DEPRECIATION_FIELDS = [
  "original_cost", "residual_rate", "useful_life_months", "start_period",
  "opening_accumulated", "ledger_status", "kind",
];
/** 卡片事实字段：改动会改变「某期间是否存在 / 是否计提」的历史结论（不含只影响显示 / 未来科目的字段）。 */
const CARD_FACT_FIELDS = [...CARD_AMOUNT_FIELDS, "acquired_period", "origin"];

const normalizeCard = (card) => ({
  kind: String(card.kind ?? "fixed"),
  name: String(card.name ?? ""),
  original_cost: formatCents(storedCents(card.original_cost ?? 0)),
  residual_rate: String(Number(card.residual_rate ?? 0)),
  useful_life_months: String(Number(card.useful_life_months ?? 0)),
  start_period: String(card.start_period ?? ""),
  asset_account: String(card.asset_account ?? ""),
  accum_account: String(card.accum_account ?? ""),
  expense_account: String(card.expense_account ?? ""),
  acquired_period: cardAcquiredPeriod(card) ?? "",
  opening_accumulated: formatCents(storedCents(card.opening_accumulated ?? 0)),
  ledger_status: String(card.ledger_status ?? "booked"),
  ledger_note: String(card.ledger_note ?? ""),
  origin: String(card.origin ?? "purchase"),
});

const changedCardFields = (previous, next) => {
  const before = previous ? normalizeCard(previous) : null;
  const after = next ? normalizeCard(next) : null;
  const all = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed = [...all].filter((key) => (before?.[key] ?? null) !== (after?.[key] ?? null));
  return {
    changed,
    amount: changed.some((key) => CARD_AMOUNT_FIELDS.includes(key)),
    depreciation: changed.some((key) => CARD_DEPRECIATION_FIELDS.includes(key)),
    fact: changed.some((key) => CARD_FACT_FIELDS.includes(key)),
  };
};

/** 卡片最早可能影响到的期间：min(取得期间, 计提开始期间)；缺取得期间时视为「一直存在」。 */
function cardLowerBound(card) {
  const acquired = cardAcquiredPeriod(card);
  const start = String(card.start_period ?? "");
  const candidates = [];
  if (isPeriod(start)) candidates.push(start);
  if (acquired === null) return null;            // 未知取得期间 → 不设下界
  if (isPeriod(acquired)) candidates.push(acquired);
  return candidates.length ? candidates.sort()[0] : null;
}

/**
 * 资产卡片维护守卫（新增 / 修改 / 删除共用）：
 *  1) 任何事实变更都要保护「受影响期间」：取得期间起算到最晚期间，只要其中有已封账期间就拒绝；
 *  2) 金额字段变更在已有已过账计提时拒绝（否则会静默改变已提金额 / 已核对原值）；
 *  3) 影响折旧的变更在后续期间已有已过账损益结转时拒绝（结转依赖累计损益，包括折旧费用）。
 * 纯显示信息（名称 / 备注 / 费用科目）不受影响，可正常维护。
 * 拒绝时数据库完全不变，guidance 给出「按倒序反结账 / 反过账 → 维护 → 重算 → 按顺序重新封账」的可执行路径。
 */
export function assertAssetCardWriteAllowed(db, setId, { operation, previous = null, next = null }) {
  const change = changedCardFields(previous, next);
  if (!change.fact) return change;
  const startPeriod = db.prepare(`SELECT start_period FROM account_sets WHERE id=?`).get(setId)?.start_period;
  const setStart = isPeriod(startPeriod) ? startPeriod : null;
  // 受影响期间下界：旧 / 新状态都要算（例如把取得期间往后改，也要保护原先存在的期间）。
  let lowerBound = null;
  let unknown = false;
  for (const card of [previous, next].filter(Boolean)) {
    const bound = cardLowerBound(card);
    if (bound === null) { unknown = true; break; }
    if (lowerBound === null || bound < lowerBound) lowerBound = bound;
  }
  if (unknown || lowerBound === null) lowerBound = setStart;
  else if (setStart !== null && setStart > lowerBound) lowerBound = setStart;

  const closed = periodRows(db, setId)
    .filter((p) => p.status === "closed" && (lowerBound === null || p.period >= lowerBound))
    .map((p) => p.period);
  if (closed.length) {
    const err = new Error("asset_card_affects_closed_period");
    err.code = "asset_card_affects_closed_period";
    err.details = {
      operation,
      changedFields: change.changed,
      affectedFrom: lowerBound,
      closedPeriods: closed,
      guidance: `卡片事实从 ${lowerBound ?? "账套启用期间"} 起影响资产核对 / 计提，其中 ${closed.join("、")} 已封账：请先按倒序反结账（${closed
        .slice().reverse().join(" → ")}），维护卡片后按期间顺序重新检查 / 计提 / 结转并重新封账`,
    };
    throw err;
  }

  if (previous && change.amount) {
    const published = db.prepare(
      `SELECT r.period, r.voucher_id FROM asset_depreciation_runs r JOIN vouchers v ON v.id=r.voucher_id
        WHERE r.account_set_id=? AND r.asset_id=? AND v.status='posted' ORDER BY r.period`,
    ).all(setId, previous.id);
    if (published.length) {
      const err = new Error("asset_card_locked_by_posted_runs");
      err.code = "asset_card_locked_by_posted_runs";
      err.details = {
        operation,
        assetId: previous.id,
        changedFields: change.changed,
        postedRuns: published.map((r) => ({ period: r.period, voucherId: r.voucher_id })),
        guidance: `该卡片已有已过账计提（${[...new Set(published.map((r) => r.period))].join("、")}），改原值 / 累计 / 期间 / 账簿状态会静默改变已提金额：请先按倒序反过账并删除这些计提凭证，维护卡片后按期间顺序重新计提`,
      };
      throw err;
    }
  }

  // 折旧费用进入损益 → 影响后续期间已过账的普通损益结转（只限真能改变折旧金额 / 适用性的变更）。
  let profitFrom = null;
  let profitFromUnknown = false;
  for (const card of [previous, next].filter(Boolean)) {
    const start = String(card.start_period ?? "");
    if (!isPeriod(start)) { profitFromUnknown = true; break; }
    if (profitFrom === null || start < profitFrom) profitFrom = start;
  }
  if (change.depreciation && !profitFromUnknown && profitFrom !== null) {
    const carries = laterProfitCarryforwards(db, setId, profitFrom, { inclusive: true });
    if (carries.length) {
      const err = new Error("later_profit_carryforward_depends_on_period");
      err.code = "later_profit_carryforward_depends_on_period";
      err.details = {
        operation,
        affectedFrom: profitFrom,
        changedFields: change.changed,
        dependencies: carries.map((v) => ({ voucherId: v.id, period: v.period, word: v.word, number: v.number })),
        guidance: `卡片变更会改变折旧 / 摊销（损益）金额，后续期间 ${carries.map((v) => v.period).join("、")} 的普通损益结转已依赖这些余额：请先按倒序反过账这些结转凭证，维护卡片后按期间顺序重新结转`,
      };
      throw err;
    }
  }
  return change;
}

/** 期间之前的一个月（供调用方组装提示，不构造具体日期）。 */
export const previousPeriodOf = prevMonth;
/** 期间之后一个月（供调用方组装提示，不构造具体日期）。 */
export const nextPeriodOf = nextMonth;
