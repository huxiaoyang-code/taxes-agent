// 导入金额格式的确定性解析；普通凭证仍使用 money.mjs 的严格十进制合同。
import {parseMoney,centsToNumber,MONEY_MAX_TEXT} from './money.mjs';
const fmtRaw=v=>{if(v===undefined||v===null||v==='')return '(空)';if(typeof v==='object'){try{return JSON.stringify(v);}catch{return '[对象]';}}return String(v);};
const AMOUNT_TEXT_RE = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
const CURRENCY_PREFIX_RE = /^[¥￥]\s*/;

/**
 * 严格金额解析（先核对原始类型/数值范围/符号，再归一化到 2 位小数）。
 * - 只允许 number / string / null / undefined；对象、数组、布尔一律拒绝，
 *   不允许 String([100]) 之类被强制成 "100" 或 "[object Object]"。
 * - 有限 number 直接采用；number 型 NaN/Infinity 拒绝。
 * - 空白/缺失（""/undefined/null）按 0 处理，这是允许的输入格式。
 * - 文本必须匹配 AMOUNT_TEXT_RE；垃圾文本、部分可解析文本一律拒绝，不再按 0 吞掉。
 * - 先判断原始数值的绝对值是否超界、记录是否带负号，再按分舍入；不允许超界原值/不足一分值
 *   被舍入后掩盖，是否允许负值由调用入口的业务合同决定。
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
  // 负号按原值保留；期初等非负入口仍可识别 -0.001，红字凭证入口独立检查不足一分值。
  const negative = /^-/.test(normalized) && /[1-9]/.test(normalized);
  return { ok: true, value: centsToNumber(parsed.cents), rawValue, negative, subCent: parsed.subCent };
}

