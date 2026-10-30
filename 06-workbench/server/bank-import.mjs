// bank-import.mjs — 银行流水文件（CSV）解析、字段映射与规范化（纯函数，无数据库副作用）。
//
// 设计约束（LOCAL-04）：
// 1) 本文件不 import db.mjs / accounting.mjs，也不打开任何数据库：导入本模块不会创建、
//    不会迁移、不会写入任何库。正式落库由 bank-reconciliation.mjs 在显式注入的连接和
//    显式事务内完成。
// 2) 预检（preview）与正式导入共用同一套规则：正式导入会重新跑一遍本模块的解析，再在
//    事务内复核当前库状态，因此预检所见与落库结果使用完全相同的规范化结果。
// 3) 金额一律规范化为「安全整数分」（Number，上限 MAX_AMOUNT_CENTS），不用浮点容差吞分差；
//    超过两位小数、指数写法、混杂文本、NaN / Infinity、超界都拒绝，不静默归 0。
// 4) 空字符串（未提供）与显式 0 在「借贷两列」模式下都表示该方向没有发生额，但整行两列
//    都为空 / 0 视为没有金额而拒绝；在「金额 + 收付方向」模式下 0 是明确的非法金额。
// 5) 业务方向统一从企业视角：inflow = 银行余额增加（收款 / 银行存款借方），
//    outflow = 银行余额减少（付款 / 银行存款贷方）。银行原文件的借贷含义必须由映射显式声明，
//    本模块不按列名、数值符号或文件顺序猜方向。
// 6) 日期必须严格匹配映射声明的格式，并通过真实日历校验；不做时区换算，不猜含糊日期。
//    行日期必须落在本次导入显式声明的账务期间（YYYY-MM）内。
// 7) 银行稳定流水 ID 可缺。缺失时不产生「可靠唯一标识」：行指纹只作为疑似重复信号，
//    由调用方保存为待人工判定的证据。

import { createHash } from "node:crypto";

/** 规范化规则版本：映射指纹与批次身份都包含它，规则升级即视为不同批次身份。 */
export const NORMALIZATION_VERSION = "bank-normalize-v1";

/** 首版只支持人民币分；不猜外币、不换汇。 */
export const SUPPORTED_CURRENCIES = Object.freeze(["CNY"]);

/** 业务方向（企业视角）。 */
export const DIRECTIONS = Object.freeze({ INFLOW: "inflow", OUTFLOW: "outflow" });

/** 金额上限（分）：99,999,999,999,999 分 = 999,999,999,999.99 元。 */
export const MAX_AMOUNT_CENTS = 99999999999999;

/** 文件 / 行 / 字段的显式限制。 */
export const BANK_CSV_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxRows: 20000,
  maxColumns: 40,
  maxFieldChars: 4096,
  maxErrors: 200,
  maxSummaryChars: 200,
  maxRefIdChars: 64,
});

const DATE_FORMATS = Object.freeze({
  "YYYY-MM-DD": /^(\d{4})-(\d{2})-(\d{2})$/,
  "YYYY/MM/DD": /^(\d{4})\/(\d{2})\/(\d{2})$/,
  "YYYYMMDD": /^(\d{4})(\d{2})(\d{2})$/,
});

const PERIOD_RE = /^(\d{4})-(\d{2})$/;
export const REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export function sha256Hex(text) {
  return sha256(String(text ?? ""));
}

/** 稳定 JSON（对象键排序）用于指纹，避免键序影响身份。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 期间文本校验：YYYY-MM 且 01-12。 */
export function isValidPeriod(value) {
  const m = PERIOD_RE.exec(String(value ?? ""));
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/** 严格日期校验（真实日历）：返回 YYYY-MM-DD 或 null。 */
export function normalizeDateText(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  return validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) ? text : null;
}

function validCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** 按映射声明的格式解析日期；不做时区换算。 */
export function parseDateByFormat(raw, format = "YYYY-MM-DD") {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, code: "row_date_missing", message: "缺少日期" };
  const re = DATE_FORMATS[format];
  if (!re) return { ok: false, code: "mapping_date_format_invalid", message: `不支持的日期格式：${format}` };
  const m = re.exec(text);
  if (!m) return { ok: false, code: "row_date_invalid", message: `日期与映射格式 ${format} 不一致：${text}` };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!validCalendarDate(year, month, day)) {
    return { ok: false, code: "row_date_invalid", message: `日期不是真实日历日期：${text}` };
  }
  return { ok: true, date: `${m[1]}-${m[2]}-${m[3]}` };
}

// ------------------------------------------------------------------ CSV 解析
/**
 * 解析 CSV：支持 UTF-8 BOM、CRLF / LF / CR 换行、引号包裹、`""` 转义、
 * 字段内逗号与换行。畸形引号、重复表头、超限一律结构化报错。
 *
 * 返回 { ok, headers, rows: [{ rowNumber, lineNumber, cells }], errors, skippedBlankRows }。
 * rowNumber 是「第几条数据记录（不含表头，1 起）」，lineNumber 是文件中的起始行号。
 */
export function parseBankCsv(text, options = {}) {
  const limits = { ...BANK_CSV_LIMITS, ...(options.limits || {}) };
  const errors = [];
  let errorsTruncated = false;
  const addError = (code, message, extra = {}) => {
    if (errors.length < limits.maxErrors) errors.push({ code, message, ...extra });
    else errorsTruncated = true;
  };

  if (typeof text !== "string") {
    return {
      ok: false, headers: [], rows: [], skippedBlankRows: 0, errorsTruncated: false,
      errors: [{ code: "csv_not_text", message: "CSV 内容必须是文本" }],
    };
  }

  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1); // UTF-8 字节序标记（BOM）
  if (input.length === 0) {
    return {
      ok: false, headers: [], rows: [], skippedBlankRows: 0, errorsTruncated: false,
      errors: [{ code: "csv_empty", message: "CSV 内容为空" }],
    };
  }
  if (Buffer.byteLength(input, "utf8") > limits.maxBytes) {
    return {
      ok: false, headers: [], rows: [], skippedBlankRows: 0, errorsTruncated: false,
      errors: [{ code: "csv_too_large", message: `CSV 超过大小上限 ${limits.maxBytes} 字节` }],
    };
  }

  const records = [];
  let cells = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let fieldStarted = false;
  let fieldOverflowReported = false;
  let recordStarted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const pushField = () => {
    cells.push(field);
    field = "";
    quoted = false;
    quoteClosed = false;
    fieldStarted = false;
    fieldOverflowReported = false;
  };
  const pushRecord = () => {
    pushField();
    records.push({ line: recordLine, cells });
    cells = [];
    recordStarted = false;
  };
  const checkFieldLength = () => {
    if (field.length > limits.maxFieldChars && !fieldOverflowReported) {
      fieldOverflowReported = true;
      addError("csv_field_too_long", `字段超过 ${limits.maxFieldChars} 字符上限`, { line });
    }
  };

  while (i < input.length) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          fieldStarted = true;
          i += 2;
          checkFieldLength();
          continue;
        }
        quoted = false;
        quoteClosed = true;
        i += 1;
        continue;
      }
      if (ch === "\n") line += 1;
      field += ch;
      fieldStarted = true;
      checkFieldLength();
      i += 1;
      continue;
    }
    if (quoteClosed) {
      if (ch === ",") { pushField(); recordStarted = true; i += 1; continue; }
      if (ch === "\r" || ch === "\n") {
        pushRecord();
        i += ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
        line += 1;
        recordLine = line;
        continue;
      }
      addError("csv_trailing_characters", "引号闭合后出现非法字符", { line });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) {
        addError("csv_stray_quote", "字段中途出现未转义的引号", { line });
        field += ch;
        i += 1;
        checkFieldLength();
        continue;
      }
      quoted = true;
      fieldStarted = true;
      recordStarted = true;
      i += 1;
      continue;
    }
    if (ch === ",") { pushField(); recordStarted = true; i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      pushRecord();
      i += ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    field += ch;
    fieldStarted = true;
    recordStarted = true;
    checkFieldLength();
    i += 1;
  }

  if (quoted) {
    addError("csv_unclosed_quote", "引号未闭合", { line: recordLine });
  } else if (recordStarted || fieldStarted || cells.length > 0) {
    pushRecord();
  }

  if (!records.length) {
    addError("csv_empty", "CSV 没有任何记录");
    return { ok: false, headers: [], rows: [], skippedBlankRows: 0, errorsTruncated, errors };
  }

  const headers = records[0].cells.map((h) => String(h).trim());
  if (headers.length > limits.maxColumns) {
    addError("csv_too_many_columns", `列数超过上限 ${limits.maxColumns}`, { line: records[0].line });
  }
  const seen = new Map();
  headers.forEach((header, index) => {
    if (!header) addError("csv_empty_header", `第 ${index + 1} 列表头为空`, { line: records[0].line, column: index + 1 });
    const key = header.toLowerCase();
    if (seen.has(key)) {
      addError("csv_duplicate_header", `表头重复：${header}`, {
        line: records[0].line, header, columns: [seen.get(key) + 1, index + 1],
      });
    } else {
      seen.set(key, index);
    }
  });

  const ignoreBlankRows = options.ignoreBlankRows !== false;
  const rows = [];
  let skippedBlankRows = 0;
  for (let r = 1; r < records.length; r += 1) {
    const record = records[r];
    const rowNumber = r;
    if (record.cells.length > headers.length) {
      addError("csv_row_too_many_fields", `数据行字段数 ${record.cells.length} 多于表头 ${headers.length}`, {
        rowNumber, line: record.line,
      });
    }
    const blank = record.cells.every((c) => String(c).trim() === "");
    if (blank) {
      if (ignoreBlankRows) { skippedBlankRows += 1; continue; }
      addError("csv_blank_row", "空数据行", { rowNumber, line: record.line });
      continue;
    }
    if (rows.length >= limits.maxRows) {
      addError("csv_too_many_rows", `数据行数超过上限 ${limits.maxRows}`, { line: record.line });
      break;
    }
    rows.push({ rowNumber, lineNumber: record.line, cells: record.cells.slice(0, headers.length) });
  }

  return {
    ok: errors.length === 0,
    headers,
    rows,
    skippedBlankRows,
    errorsTruncated,
    errors,
    limits,
  };
}

// ------------------------------------------------------------------ 金额
/**
 * 金额文本 -> 安全整数分。
 * 返回 { ok, cents, negative, empty } 或 { ok:false, code, message }。
 * - 空文本 = 未提供（empty:true, cents:0），不是 0 金额；
 * - 指数写法、混杂文本、多个小数点、未声明时使用千分位一律拒绝；
 * - 超过两位小数拒绝（不四舍五入，不用浮点容差）；
 * - 超过 MAX_AMOUNT_CENTS 拒绝；
 * - 负号交给调用方按映射规则处理（本函数只报告 negative）。
 */
export function parseAmountText(raw, options = {}) {
  const { thousandsSeparator = null, allowCurrencySymbol = false } = options;
  if (raw === undefined || raw === null) return { ok: true, cents: 0, negative: false, empty: true };
  let text = String(raw).trim();
  if (text === "") return { ok: true, cents: 0, negative: false, empty: true };
  if (allowCurrencySymbol) text = text.replace(/^(?:CNY|RMB|CN¥|￥|¥)\s*/i, "");
  if (!text) return { ok: false, code: "amount_invalid", message: "金额文本只有货币符号" };
  if (/[eE]/.test(text)) return { ok: false, code: "amount_exponent", message: `金额不允许指数写法：${raw}` };
  let negative = false;
  if (text.startsWith("-")) { negative = true; text = text.slice(1); }
  else if (text.startsWith("+")) { text = text.slice(1); }
  if (!text || text === ".") return { ok: false, code: "amount_invalid", message: `金额文本非法：${raw}` };
  if (thousandsSeparator) {
    if (thousandsSeparator === ",") {
      // 声明千分位后：带逗号的必须正确分组；不带逗号的普通数字仍然允许（小额不必加分隔符）。
      if (text.includes(",")) {
        if (!/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(text)) {
          return { ok: false, code: "amount_invalid", message: `千分位格式非法：${raw}` };
        }
        text = text.replace(/,/g, "");
      }
    } else if (thousandsSeparator === " ") {
      if (text.includes(" ")) {
        if (!/^\d{1,3}(?: \d{3})*(?:\.\d+)?$/.test(text)) {
          return { ok: false, code: "amount_invalid", message: `千分位格式非法：${raw}` };
        }
        text = text.replace(/ /g, "");
      }
    } else {
      return { ok: false, code: "mapping_thousands_invalid", message: `不支持的千分位分隔符：${thousandsSeparator}` };
    }
  } else if (text.includes(",")) {
    return { ok: false, code: "amount_invalid", message: `金额含逗号但映射未声明千分位：${raw}` };
  }
  if (!/^\d+(?:\.\d*)?$/.test(text)) return { ok: false, code: "amount_invalid", message: `金额文本非法：${raw}` };
  const [intText, fracText = ""] = text.split(".");
  if (fracText.length > 2) {
    return { ok: false, code: "amount_precision", message: `金额超过两位小数：${raw}` };
  }
  const centsText = `${intText}${(fracText + "00").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const centsBig = BigInt(centsText || "0");
  if (centsBig > BigInt(MAX_AMOUNT_CENTS)) {
    return { ok: false, code: "amount_overflow", message: `金额超过上限：${raw}` };
  }
  return { ok: true, cents: Number(centsBig), negative, empty: false };
}

/** 分 -> 十进制文本（整数分，两位小数）。 */
export function formatCents(cents) {
  const n = BigInt(cents ?? 0);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const yuan = abs / 100n;
  const frac = abs % 100n;
  return `${negative ? "-" : ""}${yuan}.${String(frac).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ 字段映射
const COLUMN_KEYS = Object.freeze([
  "date", "summary", "refId", "debit", "credit", "amount", "direction", "currency", "balance",
]);

/**
 * 规范化并校验字段映射。映射决定银行原文件各列的业务含义，本模块不做任何猜测。
 *
 * 支持两种金额模式：
 *   - debit_credit：借 / 贷两列（银行对账单口径由映射确认，统一换算为企业视角方向）；
 *   - amount_direction：金额 + 收付方向（方向标签必须显式列在 directionLabels 中）。
 */
export function normalizeMapping(raw = {}) {
  const errors = [];
  const addError = (code, message, details = {}) => errors.push({ code, message, ...details });
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (!source.columns || typeof source.columns !== "object" || Array.isArray(source.columns)) {
    addError("mapping_columns_required", "映射必须提供 columns 对象");
    return { ok: false, errors, mapping: null, fingerprint: null };
  }

  const columns = {};
  const usedHeaders = new Map();
  for (const key of Object.keys(source.columns)) {
    if (!COLUMN_KEYS.includes(key)) {
      addError("mapping_unknown_column", `未知的列映射键：${key}`, { key });
      continue;
    }
    const value = source.columns[key];
    if (typeof value !== "string" || value.trim() === "") {
      addError("mapping_column_invalid", `列映射 ${key} 必须是非空表头名`, { key });
      continue;
    }
    const header = value.trim();
    const lower = header.toLowerCase();
    if (usedHeaders.has(lower)) {
      addError("mapping_duplicate_column", `同一列被映射多次：${header}`, {
        key, duplicateOf: usedHeaders.get(lower),
      });
      continue;
    }
    usedHeaders.set(lower, key);
    columns[key] = header;
  }

  const amountMode = source.amountMode;
  if (!["debit_credit", "amount_direction"].includes(amountMode)) {
    addError("mapping_amount_mode_invalid", "amountMode 必须是 debit_credit 或 amount_direction");
  }
  if (!columns.date) addError("mapping_column_required", "缺少日期列映射（columns.date）", { key: "date" });
  if (amountMode === "debit_credit") {
    if (!columns.debit) addError("mapping_column_required", "借 / 贷模式必须映射 columns.debit", { key: "debit" });
    if (!columns.credit) addError("mapping_column_required", "借 / 贷模式必须映射 columns.credit", { key: "credit" });
    if (columns.amount || columns.direction) {
      addError("mapping_mode_conflict", "借 / 贷模式不得同时映射 amount / direction");
    }
  } else if (amountMode === "amount_direction") {
    if (!columns.amount) addError("mapping_column_required", "金额 + 方向模式必须映射 columns.amount", { key: "amount" });
    if (!columns.direction) addError("mapping_column_required", "金额 + 方向模式必须映射 columns.direction", { key: "direction" });
    if (columns.debit || columns.credit) {
      addError("mapping_mode_conflict", "金额 + 方向模式不得同时映射 debit / credit");
    }
  }

  const dateFormat = source.dateFormat ?? "YYYY-MM-DD";
  if (!DATE_FORMATS[dateFormat]) {
    addError("mapping_date_format_invalid", `dateFormat 只支持 ${Object.keys(DATE_FORMATS).join(" / ")}`);
  }

  const currency = source.currency ?? null;
  if (currency !== null && currency !== undefined) {
    if (typeof currency !== "string" || currency.trim().toUpperCase() !== "CNY") {
      addError("mapping_currency_unsupported", "首版只支持人民币 CNY（分）");
    }
  }
  if (!columns.currency && !currency) {
    addError("mapping_currency_required", "无币种列时必须在整批映射里显式声明 currency: CNY");
  }

  const negativeAmount = source.negativeAmount ?? "reject";
  if (!["reject", "reverse_direction"].includes(negativeAmount)) {
    addError("mapping_negative_rule_invalid", "negativeAmount 必须是 reject 或 reverse_direction");
  }
  if (negativeAmount === "reverse_direction" && amountMode !== "amount_direction") {
    addError("mapping_negative_rule_invalid", "借 / 贷模式下不允许用负号翻转方向");
  }

  const thousandsSeparator = source.thousandsSeparator ?? null;
  if (![null, ",", " "].includes(thousandsSeparator)) {
    addError("mapping_thousands_invalid", "thousandsSeparator 只支持 null / \",\" / 空格");
  }
  const allowCurrencySymbol = source.allowCurrencySymbol === true;
  const ignoreBlankRows = source.ignoreBlankRows !== false;
  const summaryMaxChars = source.summaryMaxChars ?? BANK_CSV_LIMITS.maxSummaryChars;
  if (!Number.isInteger(summaryMaxChars) || summaryMaxChars < 1 || summaryMaxChars > 1000) {
    addError("mapping_summary_limit_invalid", "summaryMaxChars 必须是 1..1000 的整数");
  }
  const refIdMaxChars = source.refIdMaxChars ?? BANK_CSV_LIMITS.maxRefIdChars;
  if (!Number.isInteger(refIdMaxChars) || refIdMaxChars < 1 || refIdMaxChars > 200) {
    addError("mapping_ref_id_limit_invalid", "refIdMaxChars 必须是 1..200 的整数");
  }

  let directionIndex = null;
  if (amountMode === "amount_direction") {
    const labels = source.directionLabels;
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
      addError("mapping_direction_labels_required", "金额 + 方向模式必须显式声明 directionLabels.inflow / outflow");
    } else {
      const inflow = Array.isArray(labels.inflow) ? labels.inflow : null;
      const outflow = Array.isArray(labels.outflow) ? labels.outflow : null;
      if (!inflow || !inflow.length || !outflow || !outflow.length) {
        addError("mapping_direction_labels_required", "directionLabels.inflow / outflow 必须是非空数组");
      } else {
        directionIndex = new Map();
        const addLabels = (list, direction, labelName) => {
          for (const raw of list) {
            if (typeof raw !== "string" || raw.trim() === "") {
              addError("mapping_direction_labels_invalid", `${labelName} 含空标签`);
              continue;
            }
            const key = raw.trim().toLowerCase();
            const existing = directionIndex.get(key);
            if (existing && existing !== direction) {
              addError("mapping_direction_labels_conflict", `方向标签同时映射到收 / 付：${raw}`);
              continue;
            }
            directionIndex.set(key, direction);
          }
        };
        addLabels(inflow, DIRECTIONS.INFLOW, "inflow");
        addLabels(outflow, DIRECTIONS.OUTFLOW, "outflow");
      }
    }
  }

  if (errors.length) return { ok: false, errors, mapping: null, fingerprint: null };

  const mapping = Object.freeze({
    normalizationVersion: NORMALIZATION_VERSION,
    columns: Object.freeze({ ...columns }),
    dateFormat,
    amountMode,
    currency: columns.currency ? (currency ? String(currency).trim().toUpperCase() : null) : String(currency).trim().toUpperCase(),
    negativeAmount,
    thousandsSeparator,
    allowCurrencySymbol,
    ignoreBlankRows,
    summaryMaxChars,
    refIdMaxChars,
    directionIndex,
  });
  return { ok: true, errors: [], mapping, fingerprint: mappingFingerprint(mapping) };
}

/** 映射指纹：只包含影响规范化结果的确定性字段。 */
export function mappingFingerprint(mapping) {
  const m = mapping || {};
  const labels = m.directionIndex instanceof Map
    ? [...m.directionIndex.entries()].map(([label, dir]) => [label, dir]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    : null;
  return sha256(canonicalJson({
    v: m.normalizationVersion ?? NORMALIZATION_VERSION,
    columns: m.columns ?? null,
    dateFormat: m.dateFormat ?? null,
    amountMode: m.amountMode ?? null,
    currency: m.currency ?? null,
    negativeAmount: m.negativeAmount ?? null,
    thousandsSeparator: m.thousandsSeparator ?? null,
    allowCurrencySymbol: m.allowCurrencySymbol === true,
    summaryMaxChars: m.summaryMaxChars ?? null,
    refIdMaxChars: m.refIdMaxChars ?? null,
    directionLabels: labels,
  }));
}

// ------------------------------------------------------------------ 行规范化
function headerIndexFor(headers, mapping) {
  const index = new Map();
  const missing = [];
  for (const [key, header] of Object.entries(mapping.columns)) {
    const at = headers.findIndex((h) => h.trim() === header);
    if (at < 0) missing.push({ key, header });
    else index.set(key, at);
  }
  return { index, missing };
}

/**
 * 单行规范化（预检与正式导入共用）。
 * 返回 { ok:true, row } 或 { ok:false, errors:[{field,code,message}] }。
 */
export function normalizeBankRow({ cells, headerIndex, mapping, period, rowNumber = 0, lineNumber = 0 }) {
  const errors = [];
  const addError = (field, code, message) => errors.push({ field, code, message });
  const cell = (key) => {
    const at = headerIndex.get(key);
    if (at === undefined) return "";
    return String(cells[at] ?? "");
  };
  const amountOptions = {
    thousandsSeparator: mapping.thousandsSeparator,
    allowCurrencySymbol: mapping.allowCurrencySymbol,
  };

  const dateParsed = parseDateByFormat(cell("date"), mapping.dateFormat);
  if (!dateParsed.ok) addError("date", dateParsed.code, dateParsed.message);
  const date = dateParsed.ok ? dateParsed.date : null;

  let direction = null;
  let amountCents = null;
  if (mapping.amountMode === "debit_credit") {
    const debit = parseAmountText(cell("debit"), amountOptions);
    const credit = parseAmountText(cell("credit"), amountOptions);
    if (!debit.ok) addError("debit", debit.code, debit.message);
    if (!credit.ok) addError("credit", credit.code, credit.message);
    if (debit.ok && credit.ok) {
      if (debit.negative || credit.negative) {
        addError("debit", "row_amount_negative", "借 / 贷模式不接受负号金额，请显式映射方向或用金额 + 方向模式");
      } else if (debit.cents > 0 && credit.cents > 0) {
        addError("amount", "row_amount_both_sides", "借方与贷方同时有发生额，方向不明确");
      } else if (debit.cents === 0 && credit.cents === 0) {
        addError("amount", "row_amount_missing", "本行没有发生额（借贷两列都为空或 0）");
      } else if (debit.cents > 0) {
        direction = DIRECTIONS.INFLOW; // 银行存款借方 = 银行余额增加 = 企业收款
        amountCents = debit.cents;
      } else {
        direction = DIRECTIONS.OUTFLOW;
        amountCents = credit.cents;
      }
    }
  } else {
    const amount = parseAmountText(cell("amount"), amountOptions);
    if (!amount.ok) addError("amount", amount.code, amount.message);
    if (amount.ok) {
      if (amount.empty) {
        addError("amount", "row_amount_missing", "缺少金额");
      } else if (amount.cents === 0) {
        addError("amount", "row_amount_zero", "金额不能为 0");
      } else if (amount.negative && mapping.negativeAmount === "reject") {
        addError("amount", "row_amount_negative", "金额为负数；映射未声明 negativeAmount: reverse_direction");
      } else {
        const label = cell("direction").trim();
        if (!label) {
          addError("direction", "row_direction_missing", "缺少收付方向");
        } else {
          const mapped = mapping.directionIndex?.get(label.toLowerCase()) ?? null;
          if (!mapped) {
            addError("direction", "row_direction_invalid", `未声明的收付方向：${label}`);
          } else {
            direction = amount.negative
              ? (mapped === DIRECTIONS.INFLOW ? DIRECTIONS.OUTFLOW : DIRECTIONS.INFLOW)
              : mapped;
            amountCents = amount.cents;
          }
        }
      }
    }
  }

  const summaryRaw = cell("summary").trim();
  const summary = summaryRaw;
  if (summary.length > (mapping.summaryMaxChars ?? BANK_CSV_LIMITS.maxSummaryChars)) {
    addError("summary", "row_summary_too_long", `摘要超过 ${mapping.summaryMaxChars} 字符上限`);
  }

  const refRaw = cell("refId").trim();
  let refId = null;
  if (refRaw) {
    if (refRaw.length > (mapping.refIdMaxChars ?? BANK_CSV_LIMITS.maxRefIdChars)) {
      addError("refId", "row_ref_id_too_long", `银行流水 ID 超过 ${mapping.refIdMaxChars} 字符上限`);
    } else if (!REF_ID_RE.test(refRaw)) {
      addError("refId", "row_ref_id_invalid", `银行流水 ID 含非法字符：${refRaw}`);
    } else {
      refId = refRaw;
    }
  }

  let currency = mapping.currency;
  if (mapping.columns.currency) {
    const raw = cell("currency").trim();
    if (!raw) {
      addError("currency", "row_currency_missing", "币种列为空");
      currency = null;
    } else {
      currency = raw.toUpperCase();
    }
  }
  if (currency && !SUPPORTED_CURRENCIES.includes(currency)) {
    addError("currency", "row_currency_unsupported", `本版本只支持 CNY，遇到 ${currency}`);
  }

  let balanceCents = null;
  if (mapping.columns.balance) {
    const raw = cell("balance").trim();
    if (raw) {
      const parsed = parseAmountText(raw, amountOptions);
      if (!parsed.ok) addError("balance", parsed.code, parsed.message);
      else if (parsed.empty) addError("balance", "row_balance_invalid", "余额列为空");
      else balanceCents = parsed.negative ? -parsed.cents : parsed.cents;
    }
  }

  if (date && period && date.slice(0, 7) !== period) {
    addError("date", "row_date_period_mismatch", `日期 ${date} 不属于声明的账务期间 ${period}`);
  }

  if (errors.length) return { ok: false, errors };

  const rowFingerprint = sha256(`v1|${date}|${direction}|${amountCents}|${summary}`);
  const contentFingerprint = sha256(canonicalJson({
    v: NORMALIZATION_VERSION,
    refId,
    date,
    period,
    direction,
    amountCents,
    summary,
    currency,
    balanceCents,
  }));
  return {
    ok: true,
    row: {
      rowNumber,
      lineNumber,
      date,
      period: date.slice(0, 7),
      direction,
      amountCents,
      summary,
      refId,
      currency,
      balanceCents,
      rowFingerprint,
      contentFingerprint,
    },
  };
}

/**
 * 预检：解析文件 + 校验映射 + 规范化每一行。任何错误都返回结构化行级 / 表级错误，
 * 不做部分导入。本函数不接触数据库。
 *
 * 错误列表总条数上限 = `BANK_CSV_LIMITS.maxErrors`：CSV 解析、缺失列、期间、行级规范化、
 * 文件内重复流水号**共用同一个上限**；超限只置 `errorsTruncated: true`，不无限增长，
 * 也不因截断把有错误的文件报成 ok。
 */
export function previewCsvImport({ csvText, mapping: rawMapping, period }) {
  const mappingResult = normalizeMapping(rawMapping);
  if (!mappingResult.ok) {
    return {
      ok: false,
      stage: "mapping",
      mapping: null,
      mappingFingerprint: null,
      fileDigest: null,
      headers: [],
      rows: [],
      stats: { dataRows: 0, validRows: 0, errorCount: mappingResult.errors.length, skippedBlankRows: 0 },
      errors: mappingResult.errors,
      errorsTruncated: false,
    };
  }
  const mapping = mappingResult.mapping;
  const parsed = parseBankCsv(csvText, { ignoreBlankRows: mapping.ignoreBlankRows });
  // 错误列表总上限与 CSV 解析共用同一上限：任何追加路径（行级错误、缺列、期间、
  // 文件内重复流水号）都只能追加到上限，超过就置 errorsTruncated，不能再无限增长。
  const maxErrors = BANK_CSV_LIMITS.maxErrors;
  const errors = [];
  let errorsTruncated = parsed.errorsTruncated;
  const addError = (error) => {
    if (errors.length < maxErrors) {
      errors.push(error);
      return;
    }
    errorsTruncated = true;
  };
  for (const error of parsed.errors) addError(error);
  const fileDigest = sha256(typeof csvText === "string" ? csvText : String(csvText ?? ""));

  if (!isValidPeriod(period)) {
    addError({ code: "period_invalid", message: "必须显式提供账务期间 YYYY-MM" });
  }
  const { index: headerIndex, missing } = headerIndexFor(parsed.headers, mapping);
  for (const item of missing) {
    addError({
      code: "csv_missing_column",
      message: `CSV 缺少映射声明的列：${item.header}`,
      field: item.key,
      header: item.header,
    });
  }

  const rows = [];
  const seenRefIds = new Map();
  if (!missing.length && !parsed.errors.length && isValidPeriod(period)) {
    for (const raw of parsed.rows) {
      const normalized = normalizeBankRow({
        cells: raw.cells,
        headerIndex,
        mapping,
        period,
        rowNumber: raw.rowNumber,
        lineNumber: raw.lineNumber,
      });
      if (!normalized.ok) {
        for (const err of normalized.errors) {
          addError({ ...err, rowNumber: raw.rowNumber, lineNumber: raw.lineNumber });
        }
        continue;
      }
      const row = normalized.row;
      if (row.refId) {
        const existing = seenRefIds.get(row.refId);
        if (existing !== undefined) {
          addError({
            code: "row_duplicate_ref_id",
            message: `同一文件内银行流水 ID 重复：${row.refId}（第 ${existing} 行与第 ${raw.rowNumber} 行）`,
            field: "refId",
            rowNumber: raw.rowNumber,
            lineNumber: raw.lineNumber,
          });
          continue;
        }
        seenRefIds.set(row.refId, raw.rowNumber);
      }
      rows.push(row);
    }
  }

  const sortedErrors = errors.slice().sort((a, b) => {
    const ra = a.rowNumber ?? 0;
    const rb = b.rowNumber ?? 0;
    if (ra !== rb) return ra - rb;
    return String(a.code).localeCompare(String(b.code));
  });
  return {
    ok: sortedErrors.length === 0 && rows.length > 0,
    stage: "rows",
    normalizationVersion: NORMALIZATION_VERSION,
    mapping: publicMapping(mapping),
    mappingFingerprint: mappingResult.fingerprint,
    fileDigest,
    headers: parsed.headers,
    rows,
    stats: {
      dataRows: parsed.rows.length,
      validRows: rows.length,
      errorCount: sortedErrors.length,
      skippedBlankRows: parsed.skippedBlankRows,
    },
    errors: sortedErrors,
    errorsTruncated,
  };
}

/** 公开映射（不含内部查找结构，便于 JSON 输出与文档核对）。 */
export function publicMapping(mapping) {
  if (!mapping) return null;
  return {
    normalizationVersion: mapping.normalizationVersion,
    columns: { ...mapping.columns },
    dateFormat: mapping.dateFormat,
    amountMode: mapping.amountMode,
    currency: mapping.currency,
    negativeAmount: mapping.negativeAmount,
    thousandsSeparator: mapping.thousandsSeparator,
    allowCurrencySymbol: mapping.allowCurrencySymbol,
    ignoreBlankRows: mapping.ignoreBlankRows,
    summaryMaxChars: mapping.summaryMaxChars,
    refIdMaxChars: mapping.refIdMaxChars,
    directionLabels: mapping.directionIndex
      ? {
        inflow: [...mapping.directionIndex.entries()].filter(([, d]) => d === DIRECTIONS.INFLOW).map(([l]) => l),
        outflow: [...mapping.directionIndex.entries()].filter(([, d]) => d === DIRECTIONS.OUTFLOW).map(([l]) => l),
      }
      : null,
  };
}
