// money.mjs — 人民币金额的统一十进制规则（LOCAL-02）
//
// 目标（与 docs/ACCOUNTING-PERIOD-INTEGRITY.md 一致）：
// 1) 金额一律按「分」为最小单位：内部用 BigInt 整数分计算，落库 / 出参时再转成
//    两位小数的 Number。这样 1.005、0.1+0.2、100/3 之类的二进制误差不会进入账簿。
// 2) 舍入规则唯一：ROUND_HALF_UP（四舍五入，远离零），输入直接按「十进制文本」判定，
//    不先经过浮点乘法，因此 1.005 一定得到 1.01，而不是 1.00。
// 3) 非法值绝不静默变成 0：负数（含 -0.001 这类极小负数）、超界原值（999999999999.994）、
//    NaN / Infinity / 非十进制文本一律拒绝；调用方可用 subCent 标记再拒绝「不足一分」的
//    非零金额，避免把 0.001 悄悄写成 0。
// 4) 合计不静默失真：合计在 BigInt 分上完成；转回 Number 前同时检查整数分范围与
//    「十进制往返保分」，不满足即抛 money_total_out_of_range / money_total_not_representable，
//    绝不返回被截断或被舍入的数字。
//
// 本文件不 import 任何其他模块（尤其不 import accounting.mjs），避免循环依赖。

/** 金额最小单位（分）与位数。 */
export const MONEY_FRACTION_DIGITS = 2;

/** 单笔金额上限：12 位整数 + 2 位小数（与既有限制一致，本包不扩大上限）。 */
export const MONEY_MAX_TEXT = "999999999999.99";

/** 单笔金额上限（分）。 */
export const MONEY_MAX_CENTS = 99999999999999n;

/**
 * 存储 / 累计金额的输入上限（分）：仅保证整数分在 Number 中可精确表示，
 * **不是**单笔上限。单笔（凭证 / 期初 / 导入）上限仍为 MONEY_MAX_CENTS；
 * 累计余额、期初累计等存续金额可以合法超过单笔上限。
 * 输出侧另有更严格的「十进制往返可保分」校验（见 centsToNumber）。
 */
export const MAX_ABSOLUTE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/** 金额领域错误：带稳定 code，便于 HTTP / Agent / MCP 层映射。 */
export class MoneyError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "MoneyError";
    this.code = code;
    this.details = details;
  }
}

const PLAIN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * 原值是否超出 maxCents（按完整十进制位比较，不截断小数位）。
 * 不能用固定标度（如 1e9）先把小数截断再比较：999999999999.9900000001 会被截成边界值而误收。
 */
function exceedsMax(intDigits, fracDigits, maxCents) {
  if (maxCents === null) return false;
  const maxInt = maxCents / 100n;
  const maxFrac = maxCents % 100n;                 // 0..99
  const intValue = BigInt(intDigits);
  if (intValue !== maxInt) return intValue > maxInt;
  // 整数部分相等：小数部分（全部有效位）比较；先去掉尾部的 0，再与 maxFrac 比较两位。
  const frac = fracDigits.replace(/0+$/, "");
  if (frac.length === 0) return false;
  const padded = `${maxFrac}`.padStart(2, "0");
  const head = frac.slice(0, 2).padEnd(2, "0");
  if (head !== padded) return head > padded;
  // 前两位相等：只要第三位及之后还有非零数字，就超出上限。
  return /[1-9]/.test(frac.slice(2));
}

/** 金额上限文本（错误信息用）。 */
const maxText = (maxCents) => (maxCents === MONEY_MAX_CENTS
  ? MONEY_MAX_TEXT
  : formatCents(maxCents));

/**
 * 把输入拆成十进制文本的符号 / 整数位 / 小数位。
 * 数字只接受有限值，并按「最短往返十进制表示」处理（1.005 → "1.005"），
 * 因此不会因为 1.005 实际存成 1.00499999999999989 而错误地舍去。
 * 返回 null 表示无法作为十进制金额（指数过小 / 过大 / 非数值）。
 */
function decimalParts(raw) {
  let text;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { invalid: "not_finite" };
    const shortest = String(raw);
    if (!/e/i.test(shortest)) text = shortest;
    else {
      const abs = Math.abs(raw);
      if (abs >= 1e21) return { invalid: "over" };       // 远超上限（含 Number.MAX_VALUE）
      if (abs !== 0 && abs < 1e-18) {
        // 远小于一分：仍保留符号与非零事实，交由调用方判定负数 / 不足一分。
        return { sign: raw < 0 ? -1 : 1, int: "0", frac: "", nonzero: true };
      }
      text = raw.toFixed(30);                              // 纯十进制展开，避免指数记法
    }
  } else if (typeof raw === "string") {
    text = raw.trim();
    if (text === "") return { empty: true };
  } else {
    return { invalid: "type" };
  }
  if (/e/i.test(text)) return { invalid: "not_decimal" };
  const m = PLAIN.exec(text);
  if (!m) return { invalid: "not_decimal" };
  const [, sign, intRaw, fracRaw = ""] = m;
  if (!intRaw && !fracRaw) return { invalid: "not_decimal" }; // "" / "." / "+"
  return {
    sign: sign === "-" ? -1 : 1,
    int: intRaw.replace(/^0+(?=\d)/, "") || "0",
    frac: fracRaw,
    // 非零判定必须看全部数字位，不能只看前 9 位截断值：-0.000…1 仍是负数。
    nonzero: /[1-9]/.test(intRaw + fracRaw),
  };
}

/**
 * 严格解析金额到分。
 *
 * 返回：
 *  - { ok: true, cents: BigInt, negative: boolean, subCent: boolean, empty: boolean }
 *  - { ok: false, code, error }
 *
 * 规则顺序（重要）：先核对类型 / 是否有限 → 再核对原值符号与上限（都在舍入之前）
 * → 最后 ROUND_HALF_UP 到分。因此极小负数不会被舍成 -0，超界原值不会被舍进界内。
 */
export function parseMoney(raw, {
  allowNegative = false,
  maxCents = MONEY_MAX_CENTS,
  allowEmpty = true,
  label = "金额",
} = {}) {
  if (raw === undefined || raw === null) {
    if (!allowEmpty) return { ok: false, code: "money_required", error: `${label}不能为空` };
    return { ok: true, cents: 0n, negative: false, subCent: false, empty: true };
  }
  const parts = decimalParts(raw);
  if (parts.empty) {
    if (!allowEmpty) return { ok: false, code: "money_required", error: `${label}不能为空` };
    return { ok: true, cents: 0n, negative: false, subCent: false, empty: true };
  }
  if (parts.invalid === "type") {
    return { ok: false, code: "money_type_invalid", error: `${label}类型非法（只允许数字或十进制文本）` };
  }
  if (parts.invalid === "not_finite") {
    return { ok: false, code: "money_not_finite", error: `${label}必须是有限数字（不允许 NaN / Infinity）` };
  }
  if (parts.invalid === "not_decimal") {
    return { ok: false, code: "money_not_decimal", error: `${label}必须是普通十进制数字（不接受指数、千分位或其它记法）` };
  }

  if (parts.invalid === "over") {
    return { ok: false, code: "money_over_limit", error: `${label}超界（绝对值上限 ${maxText(maxCents)}）` };
  }
  const frac = parts.frac;
  // 上限按完整原值判定（全部小数位参与），且在任何舍入之前。
  if (exceedsMax(parts.int, frac, maxCents)) {
    return { ok: false, code: "money_over_limit", error: `${label}超界（绝对值上限 ${maxText(maxCents)}）` };
  }
  if (parts.sign < 0 && parts.nonzero) {
    if (!allowNegative) return { ok: false, code: "money_negative", error: `${label}不能为负` };
  }

  const intCents = BigInt(parts.int) * 100n;
  const fracCents = frac.length ? BigInt(frac.slice(0, 2).padEnd(2, "0")) : 0n;
  // 第三位小数（及之后）是否达到半分：只需看第三位，0.0050 进一分、0.00499 舍去。
  const roundUp = frac.length > MONEY_FRACTION_DIGITS && frac[MONEY_FRACTION_DIGITS] >= "5";
  let cents = intCents + fracCents + (roundUp ? 1n : 0n);
  if (parts.sign < 0) cents = -cents;

  const negative = cents < 0n;
  const subCent = cents === 0n && parts.nonzero;
  if (maxCents !== null && (cents > maxCents || -cents > maxCents)) {
    return { ok: false, code: "money_over_limit", error: `${label}超界（绝对值上限 ${maxText(maxCents)}）` };
  }
  return { ok: true, cents, negative, subCent, empty: false };
}

/** 严格取分；失败抛 MoneyError（供领域层直接使用）。 */
export function requireCents(raw, options = {}) {
  const r = parseMoney(raw, options);
  if (!r.ok) throw new MoneyError(r.code, r.error, { value: raw, ...options });
  return r.cents;
}

/**
 * 已落库 / 已归一化金额 → 分。
 * 注意：这里**不**施加单笔金额上限 —— 累计余额、期初累计等存续金额可以合法超过单笔上限；
 * 仅按「整数分可精确表示」的范围限制，并拒绝非有限值 / 非十进制值。
 */
export function storedCents(value, label = "金额") {
  return requireCents(value, {
    allowNegative: true, label, allowEmpty: true, maxCents: MAX_ABSOLUTE_CENTS,
  });
}

/**
 * 分 → Number（两位小数）。
 * 两道护栏：
 *  1) 整数分必须在 Number 安全整数范围内；
 *  2) 转回 Number 后必须能经「最短十进制表示 → 再解析」精确还原为同一分数，
 *     否则拒绝（例如 9007199254740991 分除 100 后的 JSON 输出会丢一分）。
 * 宁可供求方降级也不能返回一个悄悄少一分 / 多一分的数字。
 */
export function centsToNumber(cents) {
  const c = typeof cents === "bigint" ? cents : BigInt(cents);
  if (c > MAX_ABSOLUTE_CENTS || c < -MAX_ABSOLUTE_CENTS) {
    throw new MoneyError("money_total_out_of_range", "金额合计超出可精确表示范围", {
      cents: c.toString(),
    });
  }
  const value = Number(c) / 100;
  const back = parseMoney(value, { allowNegative: true, maxCents: null, label: "金额合计" });
  if (!back.ok || back.cents !== c) {
    throw new MoneyError("money_total_not_representable", "金额合计无法以两位小数精确保留到分", {
      cents: c.toString(),
      serialized: String(value),
    });
  }
  return value;
}

/** 分 → 固定两位小数的文本（CSV / 日志用，不受浮点影响）。 */
export function formatCents(cents) {
  const c = typeof cents === "bigint" ? cents : BigInt(cents);
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const int = abs / 100n;
  const frac = abs % 100n;
  return `${negative ? "-" : ""}${int}.${String(frac).padStart(2, "0")}`;
}

/** 合计：在整数分上累加。 */
export function sumCents(values, label = "金额") {
  let total = 0n;
  for (const v of values) total += storedCents(v, label);
  return total;
}

/**
 * 按十进制比率精确相乘并四舍五入到分（用于残值率等比例）。
 * 例：60000.00 × 5% = 3000.00；1.01 × 10% = 0.101 → 0.10。
 */
export function mulCentsByRatio(cents, ratio) {
  const text = typeof ratio === "number" ? String(ratio) : String(ratio ?? "").trim();
  const m = PLAIN.exec(text);
  if (!m || (!m[2] && !m[3])) throw new MoneyError("money_ratio_invalid", `比率非法：${ratio}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2] || "0";
  const frac = m[3] || "";
  const scale = 10n ** BigInt(frac.length);
  const numerator = sign * BigInt(intPart + frac);
  const raw = (typeof cents === "bigint" ? cents : BigInt(cents)) * numerator;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  let q = abs / scale;
  const r = abs % scale;
  if (r * 2n >= scale) q += 1n;               // ROUND_HALF_UP
  return negative ? -q : q;
}

/**
 * 按比例拆分金额并四舍五入到分：cents × numerator / denominator（HALF_UP）。
 * 用于现金流按对方科目分摊等无法整除的分配场景；调用方负责把余数补给最后一项，
 * 保证分摊合计与原始金额严格相等。
 */
export function mulDivCents(cents, numerator, denominator) {
  const a = typeof cents === "bigint" ? cents : BigInt(cents);
  const b = typeof numerator === "bigint" ? numerator : BigInt(numerator);
  const d = typeof denominator === "bigint" ? denominator : BigInt(denominator);
  if (d === 0n) throw new MoneyError("money_division_by_zero", "金额分摊分母不能为 0");
  const raw = a * b;
  const negative = raw < 0n !== d < 0n;
  const absRaw = raw < 0n ? -raw : raw;
  const absDen = d < 0n ? -d : d;
  let q = absRaw / absDen;
  const r = absRaw % absDen;
  if (r * 2n >= absDen) q += 1n;
  return negative ? -q : q;
}

/**
 * 分期表**展开**的上限（期数）。这是技术输入边界，不是法定折旧年限。
 * evenSplitAmountCents（O(1) 取单期）不受此限；只有 splitEvenlyCents（展开整张表）才受限。
 */
export const MAX_SCHEDULE_PERIODS = 1200;

function requirePeriodCount(periods) {
  const count = Number(periods);
  if (!Number.isInteger(count) || count < 1) {
    throw new MoneyError("money_periods_invalid", `分期数必须为正整数：${periods}`);
  }
  return count;
}

/**
 * 第 index 期（0 起）的金额，**O(1)**，不展开整张分期表。
 * 规则：每期向下取整到分，余额全部落在最后一期 —— 寿命内恰好提足、前期永不超额。
 * 期数只要求正整数（不设内存上限）：即使旧库里的使用寿命很大，取一期仍然是常数内存 / 常数时间。
 */
export function evenSplitAmountCents(totalCents, periods, index) {
  const total = typeof totalCents === "bigint" ? totalCents : BigInt(totalCents);
  const count = requirePeriodCount(periods);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= count) {
    throw new MoneyError("money_periods_invalid", `期序超出分期范围（0 ~ ${count - 1}）：${index}`);
  }
  const base = total / BigInt(count);
  return i === count - 1 ? total - base * BigInt(count - 1) : base;
}

/**
 * 把总额按「分」平均分期：每期向下取整，余额全部落在最后一期。
 * 会展开整张表，所以限定 1 ~ MAX_SCHEDULE_PERIODS 期（防止巨大期数线性吃内存）；
 * 只需要某一期金额时用 evenSplitAmountCents（O(1)）。
 */
export function splitEvenlyCents(totalCents, periods) {
  const total = typeof totalCents === "bigint" ? totalCents : BigInt(totalCents);
  const count = requirePeriodCount(periods);
  if (count > MAX_SCHEDULE_PERIODS) {
    throw new MoneyError("money_periods_out_of_range",
      `分期数超出展开上限（1 ~ ${MAX_SCHEDULE_PERIODS} 期）：${periods}；只需单期金额请用 evenSplitAmountCents`);
  }
  return Array.from({ length: count }, (_, i) => evenSplitAmountCents(total, count, i));
}

/** 两个期间（YYYY-MM）相差的月数，b - a；用于计提期序（不构造日期）。 */
export function monthsBetween(fromPeriod, toPeriod) {
  const parse = (p) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(p ?? ""));
    return m ? Number(m[1]) * 12 + (Number(m[2]) - 1) : null;
  };
  const a = parse(fromPeriod), b = parse(toPeriod);
  if (a === null || b === null) return null;
  return b - a;
}
