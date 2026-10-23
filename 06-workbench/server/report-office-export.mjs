// Internal report office exports (XLSX / PDF). This module only reformats the stable
// report DTO produced by report-export.mjs; it never recalculates bookkeeping amounts
// and never claims tax-filing readiness or verified completeness.
//
// IMPORTANT: report-export.mjs (and through it db.mjs) must NOT be imported at module
// load time. db.mjs opens (and creates) the workbench database as an import side effect,
// so a static import here would make a pure DTO renderer (buildReportDocument /
// buildReportXlsx / buildReportPdf) open the default database or run migrations just by
// being loaded. The dependency is therefore loaded lazily inside buildOfficeExport, the
// only entry point that legitimately needs account-set validation and the DTO itself.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

const KINDS = ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"];
const KINDS_TITLE = {
  "balance-sheet": "资产负债表",
  "income-statement": "利润表",
  "cash-flow-statement": "现金流量表",
  "trial-balance": "科目余额表",
  ledger: "明细账",
};
const MONEY_FIELDS = ["opening_debit", "opening_credit", "period_debit", "period_credit", "ytd_debit", "ytd_credit", "closing_debit", "closing_credit"];
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MIME = "application/pdf";
const PDF_FONT_ENV = "REPORT_PDF_FONT";
const PDF_FONT_FAMILY_ENV = "REPORT_PDF_FONT_FAMILY";
const MONEY_FORMAT = "#,##0.00";
// Excel rejects (and silently repairs) string cells longer than 32767 characters.
// PDF metadata is held to the same published single-field limit so both formats
// describe exactly the same representable data instead of diverging.
export const MAX_TEXT_FIELD_LENGTH = 32767;
const PDF_NUM_FORMAT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const formatMoney = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value ?? "");
  const normalized = Object.is(value, -0) ? 0 : value;
  return PDF_NUM_FORMAT.format(normalized);
};
const yesNo = (value) => (value === true ? "是" : value === false ? "否" : String(value ?? ""));
const directionLabel = (value) => (value === "debit" ? "借" : value === "credit" ? "贷" : String(value ?? ""));
const periodStatusLabel = (value) => (value === "closed" ? "已封账（只读导出）" : value === "open" ? "未封账" : String(value ?? ""));
const CASH_KEY_LABELS = {
  净利润: "净利润",
  加_折旧与摊销: "加：折旧与摊销",
  减_经营性应收的增加: "减：经营性应收的增加",
  减_存货的增加: "减：存货的增加",
  加_经营性应付的增加: "加：经营性应付的增加",
  经营活动产生的现金流量净额: "经营活动产生的现金流量净额",
};
const INCOME_STRONG = new Set(["营业利润", "利润总额", "净利润"]);
// These two lines are already folded into 营业收入 / 营业成本 by the existing algorithm;
// label them so a reader does not add them twice.
const INCOME_ROW_LABELS = {
  其他收入: "其他收入（已并入营业收入）",
  其他费用: "其他费用（已并入营业成本）",
};

function safeSegment(value, max = 64) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, max);
}

function assertTextFieldLimit(value, field, extra = {}) {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.length <= MAX_TEXT_FIELD_LENGTH) return;
  fail("office_text_too_long", {
    field,
    length: text.length,
    limit: MAX_TEXT_FIELD_LENGTH,
    ...extra,
    message: `字段 ${field} 共 ${text.length} 字符，超过单格 / 单字段上限 ${MAX_TEXT_FIELD_LENGTH} 字符；请缩短或拆分该字段后重新导出，不会静默截断。`,
  });
}

function assertDocumentTextLimits(report, model) {
  // Check named fields first so the reported location is the user-visible field.
  assertTextFieldLimit(report.accountSet.name, "accountSet.name", { label: "账套名称" });
  assertTextFieldLimit(report.accountSet.accountingStandard, "accountSet.accountingStandard", { label: "会计准则" });
  assertTextFieldLimit(model.title, "title", { label: "报表标题" });
  assertTextFieldLimit(model.subtitle, "subtitle", { label: "报表副标题" });
  model.meta.forEach(([label, value], index) => {
    assertTextFieldLimit(label, `meta[${index}].label`, { label: "元数据标签" });
    assertTextFieldLimit(value, `meta[${index}].value`, { label: "元数据值" });
  });
  model.warnings.forEach((warning, index) => {
    assertTextFieldLimit(warning.code, `warnings[${index}].code`, { label: "限制代码" });
    assertTextFieldLimit(warning.message, `warnings[${index}].message`, { label: "限制说明" });
  });
  model.sections.forEach((section, sectionIndex) => {
    if (section.title) assertTextFieldLimit(section.title, `sections[${sectionIndex}].title`, { label: "表块标题" });
    section.columns.forEach((column, columnIndex) => {
      assertTextFieldLimit(column.header, `sections[${sectionIndex}].columns[${columnIndex}].header`, { label: "列标题" });
    });
    section.rows.forEach((row, rowIndex) => {
      row.cells.forEach((value, cellIndex) => {
        const column = section.columns[cellIndex];
        // Numeric money cells are rendered as numbers; anything else becomes cell text and
        // must satisfy the same single-cell limit.
        if (column?.kind === "money" && typeof value === "number") return;
        assertTextFieldLimit(value, `sections[${sectionIndex}].rows[${rowIndex}].cells[${cellIndex}]`, {
          row: rowIndex + 1,
          column: column?.header ?? "",
        });
      });
    });
  });
  model.notes.forEach((note, index) => {
    assertTextFieldLimit(note, `notes[${index}]`, { label: "补充说明" });
  });
}

function normalizedForDuplicateCheck(text) {
  return String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "");
}

// The DTO warnings already carry the authoritative limitation text. Drop end notes that
// only restate a warning so the PDF does not end on a page of duplicated footnotes.
function dedupeNotes(notes, warnings) {
  const warningTexts = warnings.map((warning) => normalizedForDuplicateCheck(warning.message)).filter(Boolean);
  const seen = new Set();
  const kept = [];
  for (const note of notes) {
    const normalized = normalizedForDuplicateCheck(note);
    if (!normalized || seen.has(normalized)) continue;
    if (warningTexts.some((warning) => warning.includes(normalized) || normalized.includes(warning))) continue;
    seen.add(normalized);
    kept.push(note);
  }
  return kept;
}

function periodEnd(period) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

// The document model is deliberately independent of both renderers so the XLSX and PDF
// outputs always describe identical rows, periods and money fields of the same DTO.
export function buildReportDocument(report) {
  if (!report || typeof report !== "object") fail("report_data_invalid", { field: "report" });
  const { kind } = report;
  if (!KINDS.includes(kind)) fail("report_kind_unrecognised", { kind });
  const title = KINDS_TITLE[kind];
  const period = report.period;
  const data = report.data;
  const meta = [
    ["报表类型", `${title}（内部管理报表）`],
    ["账套名称", report.accountSet.name],
    ["账套ID", String(report.accountSet.id)],
    ["会计准则（账套登记值）", report.accountSet.accountingStandard],
    ["所属期间", `${period}（${periodStatusLabel(report.scope.periodStatus)}）`],
    ["期间起止", `${report.scope.periodStart} 至 ${periodEnd(period)}`],
    ["本年累计起点", report.scope.yearStart],
    ["金额单位", "人民币元（金额保留两位小数）"],
    ["数据范围", "仅建账期初及已过账凭证；草稿、反过账凭证不入表"],
    ["数据完整性", "未核实"],
    ["空账标记", report.dataStatus.empty ? "是（范围内无金额，不代表已确认无业务）" : "否"],
    ["税局申报文件", "否（本文件不是税局申报模板）"],
  ];
  if (kind === "cash-flow-statement") {
    meta.push(["现金流编制方法", report.accountingContext?.legacy ? `${data.method}（旧账兼容，按对方科目金额比例分摊）` : data.method]);
    meta.push(["间接法独立勾稽", "否（末行复用直接法经营活动净额）"]);
  }
  if (kind === "ledger") {
    meta.push(["明细账科目", `${data.code} ${data.name}`]);
    meta.push(["科目方向", directionLabel(data.direction)]);
    meta.push(["明细范围", "本科目及编码前缀下级；仅所选期间的已过账逐笔分录"]);
  }

  if (report.accountingContext) {
    const context = report.accountingContext;
    meta.push(["持久profile", context.profileId], ["科目版本", context.coaVersion], ["映射版本", context.reportMappingVersion], ["旧账兼容", yesNo(context.legacy)]);
  }
  if (report.reportStatus) {
    meta.push(["报表映射状态", report.reportStatus.status], ["映射完整", yesNo(report.reportStatus.complete)], ["部分金额", yesNo(report.reportStatus.partialValues)]);
    for (const diagnostic of report.reportStatus.diagnostics) meta.push(["映射诊断", diagnostic.code]);
  }
  const paired = (current, opening) => {
    const key = line => line.id ?? line.label;
    const a = new Map(current.map(line => [key(line), line]));
    const b = new Map(opening.map(line => [key(line), line]));
    return [...new Set([...a.keys(), ...b.keys()])].map(id => ({ ...(a.get(id) ?? b.get(id)),
      opening: b.get(id)?.value ?? "", value: a.get(id)?.value ?? "" }));
  };
  const incomeRows = data.rows?.current?.length
    ? data.rows.current.map(row => ({ label: row.label, current: row.valueMinor / 100,
      ytd: data.rows.ytd.find(other => other.id === row.id)?.valueMinor / 100 }))
    : Object.keys(data.current ?? {}).map(label => ({ label: INCOME_ROW_LABELS[label] || label, current: data.current[label], ytd: data.ytd[label] }));
  const notes = [];
  const sections = [];
  if (kind === "balance-sheet") {
    const columns = balanceColumns();
    sections.push({
      title: "资产",
      columns,
      freeze: true,
      rows: paired(data.assets, data.opening.assets).map((line) => ({
        cells: [line.label, line.opening, line.value],
        strong: line.strong === true,
      })),
    });
    sections.push({
      title: "负债和所有者权益",
      columns,
      rows: paired(data.liabilities, data.opening.liabilities).map((line) => ({
        cells: [line.label, line.opening, line.value],
        strong: line.strong === true,
      })),
    });
    sections.push({
      title: "平衡检查",
      columns: [
        { header: "检查项", minPt: 180, flex: 40, width: 44, kind: "text" },
        { header: "结果", minPt: 60, flex: 10, width: 14, kind: "text", align: "center" },
      ],
      rows: [
        { cells: ["期末：资产 = 负债 + 所有者权益", yesNo(data.balanced)] },
        { cells: ["期间期初：资产 = 负债 + 所有者权益", yesNo(data.opening.balanced)] },
      ],
    });
  } else if (kind === "income-statement") {
    const columns = [
      { header: "项目", minPt: 150, flex: 30, width: 32, kind: "text" },
      { header: `本期发生（${period}）`, minPt: 90, flex: 16, width: 18, kind: "money" },
      { header: `本年累计（自 ${report.scope.yearStart} 起）`, minPt: 110, flex: 20, width: 24, kind: "money" },
    ];
    sections.push({
      title: "利润表",
      columns,
      freeze: true,
      rows: incomeRows.map((line) => ({
        cells: [line.label, line.current, line.ytd],
        strong: INCOME_STRONG.has(line.label),
      })),
    });
    notes.push(report.accountingContext?.legacy === false
      ? "收入、费用按持久profile的已核实项目列示；损益结转凭证不重复计入收入费用。"
      : "旧账兼容：其他收入已并入营业收入、其他费用已并入营业成本；损益结转凭证不重复计入收入费用。");
  } else if (kind === "cash-flow-statement") {
    const columns = [
      { header: "项目", minPt: 130, flex: 32, width: 34, kind: "text" },
      { header: "对方科目编码", minPt: 56, flex: 12, width: 14, kind: "text" },
      { header: `本期发生（${period}）`, minPt: 86, flex: 16, width: 18, kind: "money" },
      { header: `本年累计（自 ${report.scope.yearStart} 起）`, minPt: 100, flex: 20, width: 24, kind: "money" },
    ];
    let first = true;
    for (const [key, label] of [["operating", "经营活动"], ["investing", "投资活动"], ["financing", "筹资活动"]]) {
      const current = new Map(data[key].map((line) => [line.code, line]));
      const ytd = new Map(data.ytd[key].map((line) => [line.code, line]));
      const codes = [...new Set([...current.keys(), ...ytd.keys()])].sort();
      const rows = codes.map((code) => ({
        cells: [(current.get(code) || ytd.get(code)).name, code, current.get(code)?.value || 0, ytd.get(code)?.value || 0],
      }));
      rows.push({ cells: [`${label}产生的现金流量净额`, "", data.totals[key], data.ytd.totals[key]], strong: true });
      sections.push({ title: `${label}现金流量`, columns, freeze: first, rows });
      first = false;
    }
    sections.push({
      title: "现金及现金等价物",
      columns,
      rows: [
        { cells: ["现金净增加额", "", data.totals.net_increase, data.ytd.totals.net_increase], strong: true },
        { cells: ["现金期初余额", "", data.cash.begin, data.ytd.cash.begin] },
        { cells: ["现金期末余额", "", data.cash.end, data.ytd.cash.end] },
        { cells: ["现金余额变动", "", data.cash.change, data.ytd.cash.change] },
      ],
    });
    sections.push({
      title: "现金流量勾稽检查",
      columns: [
        { header: "检查项", minPt: 170, flex: 38, width: 40, kind: "text" },
        { header: "结果", minPt: 46, flex: 8, width: 10, kind: "text", align: "center" },
        { header: "说明", minPt: 150, flex: 34, width: 42, kind: "text" },
      ],
      rows: [
        { cells: ["本期现金流净增加额 = 现金余额变动", yesNo(data.reconciles), "同时核对直接法经营、投资、筹资净额"] },
        { cells: ["本年累计现金流净增加额 = 现金余额变动", yesNo(data.ytd.reconciles), "各月现金流相加，现金期初期末取区间边界"] },
        { cells: ["间接法独立勾稽", yesNo(report.checks.indirectIndependent), "否：间接法末行复用直接法经营活动净额，不是独立勾稽"] },
      ],
    });
    sections.push({
      title: "间接法补充资料（非独立勾稽）",
      columns: [
        { header: "项目", minPt: 150, flex: 30, width: 36, kind: "text" },
        { header: `本期发生（${period}）`, minPt: 90, flex: 16, width: 18, kind: "money" },
        { header: "本年累计", minPt: 88, flex: 16, width: 18, kind: "money" },
      ],
      rows: Object.keys(data.supplement_indirect).map((key) => ({
        cells: [CASH_KEY_LABELS[key] || key, data.supplement_indirect[key], data.ytd.supplement_indirect[key]],
        strong: key === "经营活动产生的现金流量净额",
      })),
    });
    // The DTO cash-flow warnings already carry these two limitations verbatim; keeping
    // them as end notes only produced duplicated trailing pages in the rendered PDF.
  } else if (kind === "trial-balance") {
    const columns = [
      { header: "科目编码", minPt: 50, flex: 12, width: 14, kind: "text" },
      { header: "科目名称", minPt: 80, flex: 24, width: 30, kind: "text" },
      { header: "方向", minPt: 26, flex: 6, width: 7, kind: "text", align: "center" },
      { header: "期初借方", minPt: 48, flex: 10, width: 13, kind: "money" },
      { header: "期初贷方", minPt: 48, flex: 10, width: 13, kind: "money" },
      { header: "本期借方", minPt: 48, flex: 10, width: 13, kind: "money" },
      { header: "本期贷方", minPt: 48, flex: 10, width: 13, kind: "money" },
      { header: "本年借方", minPt: 48, flex: 10, width: 13, kind: "money" },
      { header: "本年贷方", minPt: 48, flex: 10, width: 13, kind: "money" },
      { header: "期末借方", minPt: 48, flex: 10, width: 13, kind: "money" },
      { header: "期末贷方", minPt: 48, flex: 10, width: 13, kind: "money" },
    ];
    sections.push({
      title: "科目余额表（各科目自身发生额）",
      columns,
      freeze: true,
      rows: [
        ...data.lines.map((line) => ({
          cells: [line.code, line.name, directionLabel(line.direction), ...MONEY_FIELDS.map((field) => line[field])],
        })),
        { cells: ["合计", "不含父级重复汇总", "", ...MONEY_FIELDS.map((field) => data.totals[field])], strong: true },
      ],
    });
    sections.push({
      title: "试算平衡检查",
      columns: [
        { header: "试算口径", minPt: 80, flex: 18, width: 18, kind: "text" },
        { header: "借方", minPt: 56, flex: 12, width: 14, kind: "money" },
        { header: "贷方", minPt: 56, flex: 12, width: 14, kind: "money" },
        { header: "差额", minPt: 52, flex: 10, width: 13, kind: "money" },
        { header: "平衡", minPt: 40, flex: 8, width: 9, kind: "text", align: "center" },
      ],
      rows: [
        ["opening", "期间期初"], ["current", "本期发生"], ["ytd", "本年累计"], ["closing", "期末"],
      ].map(([key, label]) => {
        const check = report.checks.trialBalance[key];
        return { cells: [label, check.debit, check.credit, check.difference, yesNo(check.balanced)], strong: key === "closing" };
      }),
    });
    notes.push("余额表每个科目仅列自身发生额，父级不叠加明细汇总；发生额包含已过账结转凭证，与利润表、现金流量表口径不同。");
  } else {
    sections.push({
      title: "明细账汇总",
      columns: [
        { header: "项目", minPt: 110, flex: 26, width: 28, kind: "text" },
        { header: "借方", minPt: 90, flex: 18, width: 20, kind: "money" },
        { header: "贷方", minPt: 90, flex: 18, width: 20, kind: "money" },
      ],
      rows: [
        { cells: ["期间期初", data.opening.debit, data.opening.credit] },
        { cells: ["本期发生", data.current.debit, data.current.credit] },
        { cells: ["本年累计", data.ytd.debit, data.ytd.credit] },
        { cells: ["期末余额", data.closing.debit, data.closing.credit], strong: true },
      ],
    });
    sections.push({
      title: "逐笔明细",
      columns: [
        { header: "日期", minPt: 50, flex: 11, width: 12, kind: "text" },
        { header: "凭证字", minPt: 24, flex: 5, width: 6, kind: "text" },
        { header: "凭证号", minPt: 26, flex: 6, width: 7, kind: "text" },
        { header: "凭证ID", minPt: 34, flex: 8, width: 9, kind: "text" },
        { header: "分录ID", minPt: 34, flex: 8, width: 9, kind: "text" },
        { header: "科目编码", minPt: 44, flex: 10, width: 12, kind: "text" },
        { header: "科目名称", minPt: 60, flex: 16, width: 20, kind: "text" },
        { header: "摘要", minPt: 90, flex: 32, width: 40, kind: "text" },
        { header: "借方", minPt: 48, flex: 11, width: 13, kind: "money" },
        { header: "贷方", minPt: 48, flex: 11, width: 13, kind: "money" },
        { header: "余额（借减贷）", minPt: 58, flex: 14, width: 16, kind: "money" },
      ],
      freeze: true,
      rows: data.items.map((item) => ({
        cells: [item.voucher_date, item.word, String(item.number), String(item.voucher_id), String(item.entry_id), item.code, item.name, item.summary, item.debit, item.credit, item.balance],
      })),
    });
    notes.push("逐笔余额按借减贷计算，负数表示贷方余额；仅含所选期间的已过账凭证分录，含真实凭证ID与分录ID。");
  }

  const columnCount = Math.max(...sections.map((section) => section.columns.length));
  const orientation = columnCount >= 6 ? "landscape" : "portrait";
  const fileBase = `${kind}-${safeSegment(report.accountSet.id, 20)}-${period}${kind === "ledger" ? `-${safeSegment(data.code, 64)}` : ""}`;
  const model = {
    kind,
    title,
    period,
    accountSetName: report.accountSet.name,
    accountSetId: report.accountSet.id,
    accountingStandard: report.accountSet.accountingStandard,
    subtitle: `${report.accountSet.name} · ${period} · 人民币元 · 内部报表`,
    meta,
    warnings: report.warnings,
    sections,
    notes: dedupeNotes(notes, report.warnings),
    orientation,
    sheetName: title.slice(0, 31),
    fileBase,
    columnCount,
    dto: report,
  };
  // Reject anything a single Excel cell / PDF field cannot represent before writing bytes.
  assertDocumentTextLimits(report, model);
  return model;
}

function balanceColumns() {
  return [
    { header: "项目", minPt: 130, flex: 30, width: 36, kind: "text" },
    { header: "期间期初（上期末）", minPt: 92, flex: 16, width: 20, kind: "money" },
    { header: "期末", minPt: 80, flex: 14, width: 18, kind: "money" },
  ];
}

// ------------------------------------------------------------------ XLSX

function textCell(cell, value) {
  // Always assign a string; ExcelJS stores it as a shared/inline string, never a formula.
  cell.value = String(value ?? "");
  cell.numFmt = "@";
}

function moneyCell(cell, value) {
  const number = value === "" || value === null || value === undefined ? NaN : Number(value);
  if (Number.isFinite(number)) {
    cell.value = round2(number);
    cell.numFmt = MONEY_FORMAT;
    cell.alignment = { horizontal: "right", vertical: "top", wrapText: false };
  } else {
    textCell(cell, value);
  }
}

function columnWidthsFor(model) {
  const widths = [];
  for (const section of model.sections) {
    section.columns.forEach((column, index) => {
      widths[index] = Math.max(widths[index] || 0, column.width || 12);
    });
  }
  return widths;
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0);
    // Conservative double-width estimate for CJK ranges; ASCII counts as one cell.
    width += code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1;
  }
  return width;
}

function estimatedLines(text, widthChars) {
  const width = Math.max(4, widthChars - 1);
  let lines = 0;
  for (const paragraph of String(text ?? "").split(/\r?\n/)) lines += Math.max(1, Math.ceil(displayWidth(paragraph) / width));
  return Math.max(1, lines);
}

function fitRowHeight(worksheet, rowNumber, lines) {
  worksheet.getRow(rowNumber).height = Math.min(409, Math.max(15, lines * 12.5 + 2));
}

export async function buildReportXlsx(report, document = buildReportDocument(report)) {
  const model = document;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "有数云财税工作台";
  workbook.company = "有数云财税工作台";
  workbook.title = `${model.title} ${model.period}`;
  workbook.subject = "内部报表 · 非税局申报文件";
  workbook.created = new Date();
  workbook.modified = new Date();
  const worksheet = workbook.addWorksheet(model.sheetName);
  const widths = columnWidthsFor(model);
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });
  const maxColumns = Math.max(widths.length, model.columnCount);
  const mergedWidth = (fromColumn) => widths.slice(fromColumn - 1, maxColumns).reduce((total, width) => total + (width || 10), 0);
  let rowNumber = 0;
  const nextRow = () => ++rowNumber;

  // Title
  const titleRow = nextRow();
  worksheet.mergeCells(titleRow, 1, titleRow, maxColumns);
  const titleCell = worksheet.getCell(titleRow, 1);
  titleCell.value = model.title;
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getRow(titleRow).height = 24;

  // Subtitle
  const subtitleRow = nextRow();
  worksheet.mergeCells(subtitleRow, 1, subtitleRow, maxColumns);
  const subtitleCell = worksheet.getCell(subtitleRow, 1);
  textCell(subtitleCell, model.subtitle);
  subtitleCell.font = { size: 10, color: { argb: "FF444444" } };
  subtitleCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  fitRowHeight(worksheet, subtitleRow, estimatedLines(model.subtitle, mergedWidth(1)));

  // Metadata
  for (const [label, value] of model.meta) {
    const row = nextRow();
    const labelCell = worksheet.getCell(row, 1);
    textCell(labelCell, label);
    labelCell.font = { bold: true, size: 9 };
    labelCell.alignment = { vertical: "top", wrapText: true };
    worksheet.mergeCells(row, 2, row, maxColumns);
    const valueCell = worksheet.getCell(row, 2);
    textCell(valueCell, value);
    valueCell.font = { size: 9 };
    valueCell.alignment = { vertical: "top", wrapText: true };
    fitRowHeight(worksheet, row, Math.max(estimatedLines(label, widths[0] || 10), estimatedLines(value, mergedWidth(2))));
  }

  // Limitations / warnings
  for (const warning of model.warnings) {
    const row = nextRow();
    const labelCell = worksheet.getCell(row, 1);
    textCell(labelCell, "限制");
    labelCell.font = { bold: true, size: 9, color: { argb: "FF8A5A00" } };
    labelCell.alignment = { vertical: "top", wrapText: true };
    worksheet.mergeCells(row, 2, row, maxColumns);
    const valueCell = worksheet.getCell(row, 2);
    textCell(valueCell, warning.message);
    valueCell.font = { size: 9, color: { argb: "FF8A5A00" } };
    valueCell.alignment = { vertical: "top", wrapText: true };
    fitRowHeight(worksheet, row, Math.max(estimatedLines("限制", widths[0] || 10), estimatedLines(warning.message, mergedWidth(2))));
  }

  nextRow(); // spacer

  let freezeRow = 0;
  let firstDetailHeaderRow = 0;
  for (const section of model.sections) {
    if (section.title) {
      const row = nextRow();
      worksheet.mergeCells(row, 1, row, maxColumns);
      const cell = worksheet.getCell(row, 1);
      textCell(cell, section.title);
      cell.font = { bold: true, size: 11, color: { argb: "FF1F3864" } };
      cell.alignment = { vertical: "middle" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF2FA" } };
      fitRowHeight(worksheet, row, Math.max(1, estimatedLines(section.title, mergedWidth(1))));
    }
    const headerRow = nextRow();
    section.columns.forEach((column, index) => {
      const cell = worksheet.getCell(headerRow, index + 1);
      textCell(cell, column.header);
      cell.font = { bold: true, size: 9 };
      cell.alignment = { horizontal: column.kind === "money" ? "right" : "center", vertical: "middle", wrapText: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } };
      cell.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
    });
    fitRowHeight(worksheet, headerRow, Math.max(...section.columns.map((column, index) => estimatedLines(column.header, widths[index] || 12))));
    if (!firstDetailHeaderRow) firstDetailHeaderRow = headerRow;
    if (section.freeze && !freezeRow) freezeRow = headerRow;
    for (const dataRow of section.rows) {
      const row = nextRow();
      let rowLines = 1;
      section.columns.forEach((column, index) => {
        const cell = worksheet.getCell(row, index + 1);
        const value = dataRow.cells[index];
        if (column.kind === "money") moneyCell(cell, value);
        else {
          textCell(cell, value);
          cell.alignment = { vertical: "top", wrapText: true, horizontal: column.align || "left" };
          rowLines = Math.max(rowLines, estimatedLines(value, widths[index] || 12));
        }
        cell.border = { top: { style: "hair" }, left: { style: "hair" }, bottom: { style: "hair" }, right: { style: "hair" } };
        if (dataRow.strong) {
          cell.font = { bold: true, size: 9 };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
        } else {
          cell.font = { size: 9 };
        }
      });
      fitRowHeight(worksheet, row, rowLines);
    }
    nextRow(); // spacer between sections
  }

  // Footnotes
  for (const note of model.notes) {
    const row = nextRow();
    worksheet.mergeCells(row, 1, row, maxColumns);
    const cell = worksheet.getCell(row, 1);
    textCell(cell, note);
    cell.font = { size: 8, italic: true, color: { argb: "FF555555" } };
    cell.alignment = { vertical: "top", wrapText: true };
    fitRowHeight(worksheet, row, estimatedLines(note, mergedWidth(1)));
  }

  const lastColumnLetter = worksheet.getColumn(maxColumns).letter;
  const printTitleRow = freezeRow || firstDetailHeaderRow;
  worksheet.pageSetup = {
    paperSize: 9, // A4
    orientation: model.orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    printArea: `A1:${lastColumnLetter}${rowNumber}`,
    printTitlesRow: `${printTitleRow}:${printTitleRow}`,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.2 },
    oddFooter: '&L内部报表 · 非税局申报文件&C&"宋体"&A&R第 &P 页 / 共 &N 页',
  };
  worksheet.views = [{ state: "frozen", ySplit: freezeRow || firstDetailHeaderRow, xSplit: 0, topLeftCell: `A${(freezeRow || firstDetailHeaderRow) + 1}` }];
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

// ------------------------------------------------------------------ PDF

function windowsFontCandidates() {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return [
    { path: join(root, "Fonts", "simsun.ttc"), family: "SimSun", label: "simsun.ttc (SimSun)" },
    { path: join(root, "Fonts", "simhei.ttf"), family: null, label: "simhei.ttf (SimHei)" },
    { path: join(root, "Fonts", "Deng.ttf"), family: null, label: "Deng.ttf (DengXian)" },
  ];
}

function otherFontCandidates() {
  return [
    { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "Noto Sans CJK SC", label: "NotoSansCJK-Regular.ttc" },
    { path: "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", family: "Noto Sans CJK SC", label: "NotoSansCJK-Regular.ttc" },
    { path: "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf", family: null, label: "NotoSansCJKsc-Regular.otf" },
    { path: "/System/Library/Fonts/PingFang.ttc", family: "PingFang SC", label: "PingFang.ttc" },
  ];
}

export function resolvePdfFontCandidates() {
  const explicit = process.env[PDF_FONT_ENV];
  if (explicit && explicit.trim()) {
    const fontPath = explicit.trim();
    if (!existsSync(fontPath)) {
      fail("pdf_font_unavailable", {
        envVar: PDF_FONT_ENV,
        message: `环境变量 ${PDF_FONT_ENV} 指向的字体文件不存在：${basename(fontPath)}。请改为本机已安装的中文字体文件路径。`,
      });
    }
    return [{ path: fontPath, family: process.env[PDF_FONT_FAMILY_ENV] || null, label: basename(fontPath), explicit: true }];
  }
  return [...windowsFontCandidates(), ...otherFontCandidates()].filter((candidate) => existsSync(candidate.path));
}

function collectDocumentStrings(model) {
  const strings = [model.title, model.subtitle, ...model.notes];
  for (const [label, value] of model.meta) strings.push(label, value);
  for (const warning of model.warnings) strings.push(warning.code, warning.message);
  for (const section of model.sections) {
    if (section.title) strings.push(section.title);
    for (const column of section.columns) strings.push(column.header);
    for (const row of section.rows) {
      for (const [index, value] of row.cells.entries()) {
        const column = section.columns[index];
        strings.push(column?.kind === "money" ? formatMoney(value) : String(value ?? ""));
      }
    }
  }
  strings.push("内部报表 · 非税局申报文件 · 数据完整性未核实 · 第 1 页 / 共 1 页");
  return strings;
}

function missingGlyphs(font, strings) {
  const missing = new Set();
  if (!font || typeof font.hasGlyphForCodePoint !== "function") return missing;
  for (const text of strings) {
    for (const char of String(text ?? "")) {
      const code = char.codePointAt(0);
      if (code <= 0x20 || code === 0x7f) continue;
      if (!font.hasGlyphForCodePoint(code)) missing.add(char);
    }
  }
  return missing;
}

function wrapText(doc, text, width) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const lines = [];
  for (const paragraph of value.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const tokens = paragraph.match(/[A-Za-z0-9][A-Za-z0-9_.'%\-/:]*|\s+|[\s\S]/gu) || [];
    let current = "";
    for (const token of tokens) {
      const candidate = current + token;
      if (current && doc.widthOfString(candidate) > width) {
        lines.push(current.replace(/\s+$/u, ""));
        current = "";
        if (token.trim() === "") continue;
      }
      if (!current && doc.widthOfString(token) > width) {
        // Hard-break a single oversized token without dropping any character.
        for (const char of token) {
          if (current && doc.widthOfString(current + char) > width) {
            lines.push(current);
            current = "";
          }
          current += char;
        }
        continue;
      }
      current += token;
    }
    lines.push(current.replace(/\s+$/u, ""));
  }
  return lines.length ? lines : [""];
}

function layoutColumns(columns, available) {
  const mins = columns.map((column) => column.minPt || 36);
  const totalMin = mins.reduce((total, value) => total + value, 0);
  if (available <= totalMin) return mins.map((min) => (available * min) / totalMin);
  const extra = available - totalMin;
  const flex = columns.map((column) => column.flex || 10);
  const totalFlex = flex.reduce((total, value) => total + value, 0);
  return mins.map((min, index) => min + (extra * flex[index]) / totalFlex);
}

async function renderPdf(model, candidate) {
  const doc = new PDFDocument({
    size: "A4",
    layout: model.orientation,
    margins: { top: 30, bottom: 40, left: 36, right: 36 },
    bufferPages: true,
    autoFirstPage: false,
    font: "",
    info: {
      Title: `${model.title} ${model.period}`,
      Author: "有数云财税工作台",
      Subject: "内部报表 · 非税局申报文件",
      Creator: "有数云财税工作台 report-office-export",
    },
  });
  const alias = "reportChinese";
  if (candidate.family) doc.registerFont(alias, candidate.path, candidate.family);
  else doc.registerFont(alias, candidate.path);
  doc.font(alias);
  const internalFont = doc._font && doc._font.font;
  const missing = missingGlyphs(internalFont, collectDocumentStrings(model));
  if (missing.size) {
    doc.end();
    fail("pdf_font_glyph_missing", {
      font: candidate.label,
      characters: [...missing].slice(0, 40),
      message: `所选字体 ${candidate.label} 缺少字符 ${[...missing].slice(0, 40).join("")}；请通过 ${PDF_FONT_ENV} 指定覆盖这些字符的中文字体，禁止以方框代替中文。`,
    });
  }

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  const pageWidth = model.orientation === "landscape" ? 841.89 : 595.28;
  const pageHeight = model.orientation === "landscape" ? 595.28 : 841.89;
  const margin = { left: 36, right: 36, top: 30, bottom: 42 };
  const contentWidth = pageWidth - margin.left - margin.right;
  const bottomLimit = pageHeight - margin.bottom;
  const baseSize = 7.6;
  const lineHeight = baseSize * 1.35;
  const padX = 3;
  const padY = 2.4;
  const state = { y: 0 };

  function setText(size, color = "#111111") {
    doc.font(alias).fontSize(size).fillColor(color);
  }

  function addPage(continuation) {
    doc.addPage({ size: "A4", layout: model.orientation, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    state.y = margin.top;
    if (continuation) drawContinuationHeader();
  }

  function drawContinuationHeader() {
    setText(10, "#1F3864");
    doc.text(model.title, margin.left, state.y, { width: contentWidth, align: "left", lineBreak: false });
    setText(7.5, "#666666");
    doc.text(`${model.period} · 人民币元 · 内部报表（续）`, margin.left, state.y + 13, { width: contentWidth, align: "right", lineBreak: false });
    state.y += 20;
    doc.save().lineWidth(0.6).strokeColor("#B4C6E7").moveTo(margin.left, state.y).lineTo(pageWidth - margin.right, state.y).stroke().restore();
    state.y += 6;
  }

  function drawFirstPageHeader() {
    setText(16, "#1F3864");
    for (const line of wrapText(doc, model.title, contentWidth)) {
      if (state.y + 20 > bottomLimit) addPage(true);
      setText(16, "#1F3864");
      const x = margin.left + (contentWidth - doc.widthOfString(line)) / 2;
      doc.text(line, x, state.y, { lineBreak: false });
      state.y += 20;
    }
    setText(9, "#333333");
    for (const line of wrapText(doc, model.subtitle, contentWidth)) {
      if (state.y + 12 > bottomLimit) addPage(true);
      setText(9, "#333333");
      const x = margin.left + (contentWidth - doc.widthOfString(line)) / 2;
      doc.text(line, x, state.y, { lineBreak: false });
      state.y += 12;
    }
    state.y += 4;
    // Two metadata pairs per row; label and value occupy separate horizontal bands.
    // Each field is paginated line by line so one oversized value can never be drawn
    // past the bottom margin, even when it needs more than a full page.
    const metaColWidth = (contentWidth - 12) / 2;
    const metaLabelWidth = 86;
    const metaValueWidth = metaColWidth - metaLabelWidth - 4;
    const metaLineHeight = 9.6;
    for (let index = 0; index < model.meta.length; index += 2) {
      const pairs = model.meta.slice(index, index + 2).map(([label, value], offset) => {
        setText(7.2, "#666666");
        const labelLines = wrapText(doc, label, metaLabelWidth - 4);
        setText(7.6, "#111111");
        const valueLines = wrapText(doc, value, metaValueWidth);
        return {
          x: margin.left + offset * (metaColWidth + 12),
          labelLines,
          valueLines,
          labelOffset: 0,
          valueOffset: 0,
        };
      });
      for (;;) {
        const needed = Math.max(...pairs.map((pair) => Math.max(
          pair.labelLines.length - pair.labelOffset,
          pair.valueLines.length - pair.valueOffset,
        )));
        if (needed <= 0) break;
        const availableLines = Math.floor((bottomLimit - state.y) / metaLineHeight);
        if (availableLines < 1) {
          addPage(true);
          continue;
        }
        const take = Math.min(availableLines, needed);
        for (const pair of pairs) {
          setText(7.2, "#666666");
          pair.labelLines.slice(pair.labelOffset, pair.labelOffset + take).forEach((line, lineIndex) => {
            doc.text(line, pair.x, state.y + lineIndex * metaLineHeight, { lineBreak: false });
          });
          setText(7.6, "#111111");
          pair.valueLines.slice(pair.valueOffset, pair.valueOffset + take).forEach((line, lineIndex) => {
            doc.text(line, pair.x + metaLabelWidth, state.y + lineIndex * metaLineHeight, { lineBreak: false });
          });
          pair.labelOffset += take;
          pair.valueOffset += take;
        }
        state.y += take * metaLineHeight;
      }
    }
    state.y += 6;
    let y = state.y;
    // Warnings box. When the full box cannot fit even on a fresh continuation page,
    // fall back to flowing lines so no warning is clipped or silently dropped.
    setText(7.6, "#7A4B00");
    const warningWidth = contentWidth - 16;
    const blocks = model.warnings.map((warning) => wrapText(doc, warning.message, warningWidth));
    const titleHeight = 12;
    const boxHeight = 8 + titleHeight + blocks.reduce((total, lines) => total + lines.length * 9.6 + 2, 0) + 4;
    const freshPageRoom = bottomLimit - (margin.top + 26);
    if (boxHeight > freshPageRoom) {
      if (y + titleHeight > bottomLimit) {
        addPage(true);
        y = state.y;
      }
      setText(8, "#7A4B00");
      doc.text("限制与提示（内部报表，非税局申报文件）", margin.left, y, { lineBreak: false });
      y += titleHeight;
      for (const lines of blocks) {
        for (const line of lines) {
          if (y + 9.6 > bottomLimit) {
            addPage(true);
            y = state.y;
          }
          setText(7.4, "#7A4B00");
          doc.text(line, margin.left + 4, y, { lineBreak: false });
          y += 9.6;
        }
        y += 2;
      }
      state.y = y + 10;
      return;
    }
    if (y + boxHeight > bottomLimit) {
      addPage(true);
      y = state.y;
    }
    doc.save().rect(margin.left, y, contentWidth, boxHeight).fillAndStroke("#FFF8E1", "#E0C97A").restore();
    setText(8, "#7A4B00");
    doc.text("限制与提示（内部报表，非税局申报文件）", margin.left + 8, y + 6, { lineBreak: false });
    let warnY = y + 6 + titleHeight;
    for (const lines of blocks) {
      for (const line of lines) {
        setText(7.4, "#7A4B00");
        doc.text(line, margin.left + 8, warnY, { lineBreak: false });
        warnY += 9.6;
      }
      warnY += 2;
    }
    state.y = y + boxHeight + 10;
  }

  function drawSectionHeader(section, widths) {
    setText(baseSize, "#111111");
    const headerLines = section.columns.map((column, index) => wrapText(doc, column.header, widths[index] - padX * 2));
    const headerHeight = Math.max(...headerLines.map((lines) => lines.length)) * lineHeight + padY * 2;
    const titleHeight = section.title ? 15 : 0;
    // Break before the section title so a title never ends up orphaned above a page break.
    if (state.y + titleHeight + headerHeight + lineHeight > bottomLimit) addPage(true);
    if (section.title) {
      setText(9.5, "#1F3864");
      doc.text(section.title, margin.left, state.y, { lineBreak: false });
      state.y += titleHeight;
    }
    let x = margin.left;
    headerLines.forEach((lines, index) => {
      const width = widths[index];
      doc.save().rect(x, state.y, width, headerHeight).fillAndStroke("#DDEBF7", "#9DB3D4").restore();
      setText(baseSize, "#111111");
      const column = section.columns[index];
      lines.forEach((line, lineIndex) => {
        const textWidth = doc.widthOfString(line);
        const textX = column.kind === "money" || column.align === "right"
          ? x + width - padX - textWidth
          : column.align === "center" ? x + (width - textWidth) / 2 : x + padX;
        doc.text(line, textX, state.y + padY + lineIndex * lineHeight, { lineBreak: false });
      });
      x += width;
    });
    state.y += headerHeight;
    return headerHeight;
  }

  function drawRowChunk(section, widths, row, chunks, height) {
    let x = margin.left;
    section.columns.forEach((column, index) => {
      const width = widths[index];
      const lines = chunks[index] || [];
      if (row.strong) doc.save().rect(x, state.y, width, height).fill("#F2F2F2").restore();
      doc.save().lineWidth(0.4).strokeColor("#BFBFBF").rect(x, state.y, width, height).stroke().restore();
      setText(baseSize, "#111111");
      lines.forEach((line, lineIndex) => {
        const textWidth = doc.widthOfString(line);
        const textX = column.kind === "money" ? x + width - padX - textWidth
          : column.align === "center" ? x + (width - textWidth) / 2
            : column.align === "right" ? x + width - padX - textWidth
              : x + padX;
        doc.text(line, textX, state.y + padY + lineIndex * lineHeight, { lineBreak: false });
      });
      x += width;
    });
  }

  function renderSection(section, reserve = 0) {
    const widths = layoutColumns(section.columns, contentWidth);
    drawSectionHeader(section, widths);
    if (!section.rows.length && reserve > 0 && state.y + reserve > bottomLimit) {
      // A header-only final section must still leave room for the end notes on the same page.
      addPage(true);
      drawSectionHeader(section, widths);
    }
    section.rows.forEach((row, rowIndex) => {
      const isFinalRow = rowIndex === section.rows.length - 1;
      const cellLines = row.cells.map((value, index) => {
        const column = section.columns[index];
        const text = column?.kind === "money" ? formatMoney(value) : String(value ?? "");
        return wrapText(doc, text, widths[index] - padX * 2);
      });
      const offsets = cellLines.map(() => 0);
      for (;;) {
        const remaining = cellLines.map((lines, index) => lines.slice(offsets[index]));
        if (remaining.every((lines) => lines.length === 0)) break;
        // Reserve room for the end notes on the page where the final row finishes, so
        // notes never spill onto a trailing page that contains nothing else.
        const reserveNow = isFinalRow ? reserve : 0;
        const available = bottomLimit - reserveNow - state.y;
        const maxLines = Math.floor((available - padY * 2) / lineHeight);
        if (maxLines < 1) {
          addPage(true);
          drawSectionHeader(section, widths);
          continue;
        }
        const needed = Math.max(...remaining.map((lines) => lines.length));
        const take = Math.min(maxLines, needed);
        const chunks = remaining.map((lines) => lines.slice(0, take));
        const chunkHeight = Math.max(...chunks.map((lines) => lines.length)) * lineHeight + padY * 2;
        drawRowChunk(section, widths, row, chunks, chunkHeight);
        state.y += chunkHeight;
        chunks.forEach((lines, index) => { offsets[index] += lines.length; });
        const stillRemaining = cellLines.some((lines, index) => offsets[index] < lines.length);
        if (stillRemaining) {
          addPage(true);
          drawSectionHeader(section, widths);
        }
      }
    });
    state.y += 8;
  }

  addPage(false);
  drawFirstPageHeader();
  setText(7.4, "#555555");
  const noteBlocks = model.notes.map((note) => wrapText(doc, note, contentWidth));
  const notesHeight = noteBlocks.reduce((total, lines) => total + lines.length * lineHeight + 2, 0);
  const noteReserve = noteBlocks.length
    ? Math.min(notesHeight + 10, Math.max(0, (bottomLimit - (margin.top + 26)) / 2))
    : 0;
  model.sections.forEach((section, index) => {
    renderSection(section, index === model.sections.length - 1 ? noteReserve : 0);
  });

  // Footnotes. They normally fit on the final content page thanks to the reservation
  // above; a note longer than a full page still flows without clipping.
  if (noteBlocks.length) {
    for (const lines of noteBlocks) {
      for (const line of lines) {
        if (state.y + lineHeight > bottomLimit) addPage(true);
        setText(7.4, "#555555");
        doc.text(line, margin.left, state.y, { lineBreak: false });
        state.y += lineHeight;
      }
      state.y += 2;
    }
  }

  // Page footers with page number / total, applied after all pages exist.
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) {
    doc.switchToPage(index);
    setText(7, "#666666");
    doc.text(
      `内部报表 · 非税局申报文件 · 数据完整性未核实 · 第 ${index + 1} 页 / 共 ${range.count} 页`,
      margin.left,
      pageHeight - 26,
      { width: contentWidth, align: "center", lineBreak: false },
    );
  }

  doc.end();
  await finished;
  return { buffer: Buffer.concat(chunks), pageCount: range.count };
}

export async function buildReportPdf(report, document = buildReportDocument(report)) {
  const model = document;
  const candidates = resolvePdfFontCandidates();
  if (!candidates.length) {
    fail("pdf_font_unavailable", {
      envVar: PDF_FONT_ENV,
      message: `未找到可嵌入的中文字体。请安装中文字体或设置 ${PDF_FONT_ENV} 指向字体文件（TTC 集合可再设 ${PDF_FONT_FAMILY_ENV} 指定字体族）。`,
    });
  }
  const failures = [];
  let glyphFailure = null;
  for (const candidate of candidates) {
    try {
      const result = await renderPdf(model, candidate);
      return { ...result, font: { label: candidate.label, family: candidate.family || null } };
    } catch (error) {
      if (error.code === "pdf_font_glyph_missing") {
        glyphFailure = error;
        failures.push({ label: candidate.label, message: "部分字符无字形" });
        if (candidate.explicit) break;
        continue;
      }
      failures.push({ label: candidate.label, message: error.message });
      if (candidate.explicit) break;
    }
  }
  if (glyphFailure) throw glyphFailure;
  fail("pdf_font_unavailable", {
    envVar: PDF_FONT_ENV,
    message: `中文字体无法嵌入 PDF：${failures.map((item) => `${item.label}（${item.message}）`).join("；")}。请设置 ${PDF_FONT_ENV} 指向可用中文字体。`,
  });
}

// ------------------------------------------------------------- entry point

/**
 * Build an internal report download in CSV, XLSX or PDF.
 * @returns {Promise<{filename:string,contentType:string,body:string|Buffer,report:object,font?:object}>}
 */
export async function buildOfficeExport(setId, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("report_options_invalid");
  const format = options.format ?? "csv";
  if (!OFFICE_FORMATS.includes(format)) fail("report_format_unsupported", { supported: OFFICE_FORMATS });
  // Reuse report-export.mjs for validation, scope checks, DTO building and CSV output.
  // Loaded lazily (not at module scope) so importing this renderer stays database-free.
  const { buildReportExport } = await import("./report-export.mjs");
  const base = buildReportExport(setId, { ...options, format: "csv" });
  if (format === "csv") return base;
  const document = buildReportDocument(base.report);
  if (format === "xlsx") {
    const body = await buildReportXlsx(base.report, document);
    return { ...base, filename: `${document.fileBase}.xlsx`, contentType: XLSX_MIME, body };
  }
  const { buffer, pageCount, font } = await buildReportPdf(base.report, document);
  return { ...base, filename: `${document.fileBase}.pdf`, contentType: PDF_MIME, body: buffer, pageCount, font };
}

export const OFFICE_FORMATS = ["csv", "xlsx", "pdf"];
export const OFFICE_REPORT_KINDS = KINDS;
