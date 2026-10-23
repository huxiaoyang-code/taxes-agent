// Internal report downloads. Reading existing books is not a completeness or tax-filing certification.
import { db } from "./db.mjs";
import { storedCents, centsToNumber, formatCents } from "./money.mjs";
import { balanceSheet, incomeStatement, cashFlowStatement, accountSetProfile } from "./accounting.mjs";

const KINDS = ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"];
const TITLES = { "balance-sheet": "资产负债表", "income-statement": "利润表", "cash-flow-statement": "现金流量表", "trial-balance": "科目余额表", ledger: "明细账" };
const MONEY_FIELDS = ["opening_debit", "opening_credit", "period_debit", "period_credit", "ytd_debit", "ytd_credit", "closing_debit", "closing_credit"];
// Read every amount before adding/subtracting; SQL SUM and Number arithmetic can lose cents.
const cents = value => { try { return storedCents(value); } catch { fail("report_data_invalid"); } };
const number = value => { try { return centsToNumber(value); } catch { fail("report_data_invalid"); } };
const sum = values => number(values.reduce((total, value) => total + cents(value), 0n));
const difference = (a, b) => number(cents(a) - cents(b));
const split = net => ({ debit: number(net > 0n ? net : 0n), credit: number(net < 0n ? -net : 0n) });
const all = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function previousPeriod(period) {
  const year = Number(period.slice(0, 4)), month = Number(period.slice(5));
  return month === 1 ? `${String(year - 1).padStart(4, "0")}-12` : `${period.slice(0, 4)}-${String(month - 1).padStart(2, "0")}`;
}

// No roll-up rows: each account's own postings occur exactly once in the totals.
// Existing trialBalance.period_debit is inception-to-date, so do not relabel its fields.
function buildTrial(setId, period, startPeriod, yearStart, accounts) {
  const openings = new Map(all("SELECT code,debit,credit FROM opening_balances WHERE account_set_id=?", setId).map((item) => [item.code, item]));
  const movements = new Map();
  for (const entry of all(`SELECT e.code,e.debit,e.credit,v.period
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE v.account_set_id=? AND v.status='posted' AND v.period BETWEEN ? AND ?`, setId, startPeriod, period)) {
    if (!movements.has(entry.code)) movements.set(entry.code, {
      prior_debit: 0n, prior_credit: 0n, period_debit: 0n, period_credit: 0n, ytd_debit: 0n, ytd_credit: 0n,
    });
    const movement = movements.get(entry.code);
    const debit = cents(entry.debit), credit = cents(entry.credit);
    if (entry.period < period) { movement.prior_debit += debit; movement.prior_credit += credit; }
    if (entry.period === period) { movement.period_debit += debit; movement.period_credit += credit; }
    if (entry.period >= yearStart) { movement.ytd_debit += debit; movement.ytd_credit += credit; }
  }
  const lines = accounts.map((account) => {
    const opening = openings.get(account.code), movement = movements.get(account.code);
    const openingNet = cents(opening?.debit ?? 0) - cents(opening?.credit ?? 0)
      + (movement?.prior_debit ?? 0n) - (movement?.prior_credit ?? 0n);
    const beginning = split(openingNet);
    const debit = movement?.period_debit ?? 0n, credit = movement?.period_credit ?? 0n;
    const closing = split(openingNet + debit - credit);
    return {
      code: account.code, name: account.name, category: account.category, direction: account.direction,
      opening_debit: beginning.debit, opening_credit: beginning.credit,
      period_debit: number(debit), period_credit: number(credit),
      ytd_debit: number(movement?.ytd_debit ?? 0n), ytd_credit: number(movement?.ytd_credit ?? 0n),
      closing_debit: closing.debit, closing_credit: closing.credit,
    };
  });
  return { period, lines, totals: Object.fromEntries(MONEY_FIELDS.map((field) => [field, sum(lines.map((item) => item[field]))])) };
}

function trialChecks(totals) {
  return Object.fromEntries([["opening", "opening"], ["current", "period"], ["ytd", "ytd"], ["closing", "closing"]].map(([name, prefix]) => {
    const debit = totals[`${prefix}_debit`], credit = totals[`${prefix}_credit`], difference = number(cents(debit) - cents(credit));
    return [name, { balanced: Math.abs(difference) < 0.005, debit, credit, difference }];
  }));
}

function buildLedger(setId, period, account, trial) {
  const lines = trial.lines.filter((line) => line.code.startsWith(account.code));
  const group = new Set(lines.map((line) => line.code));
  const total = (field) => sum(lines.map((line) => line[field]));
  const opening = split(cents(total("opening_debit")) - cents(total("opening_credit")));
  const current = { debit: total("period_debit"), credit: total("period_credit") };
  const ytd = { debit: total("ytd_debit"), credit: total("ytd_credit") };
  let running = cents(opening.debit) - cents(opening.credit);
  const names = new Map(lines.map((line) => [line.code, line.name]));
  const items = all(`SELECT e.id entry_id,v.id voucher_id,v.period,v.voucher_date,v.word,v.number,e.code,
      COALESCE(NULLIF(e.summary,''),v.summary,'') summary,e.debit,e.credit
    FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
    WHERE v.account_set_id=? AND v.status='posted' AND v.period=?
    ORDER BY v.voucher_date,v.number,v.id,e.line_no,e.id`, setId, period)
    .filter((item) => group.has(item.code)).map((item) => {
      running += cents(item.debit) - cents(item.credit);
      return { ...item, name: names.get(item.code), debit: number(cents(item.debit)), credit: number(cents(item.credit)), balance: number(running) };
    });
  return { code: account.code, name: account.name, direction: account.direction, period, opening, current, ytd, closing: split(running), items };
}

// Combine every included window; arithmetic reconciliation never certifies mapping completeness.
function aggregateStatus(statuses) {
  if (!statuses.length || statuses.some(s => !s || !["complete", "incomplete", "legacy_compatibility"].includes(s.status)
    || typeof s.complete !== "boolean" || typeof s.partialValues !== "boolean" || !Array.isArray(s.diagnostics))) fail("report_data_invalid");
  const diagnostics = [...new Map(statuses.flatMap(s => s.diagnostics).map(d => [JSON.stringify(d), d])).values()];
  const complete = statuses.every(s => s.complete);
  return { status: complete ? "complete" : statuses.some(s => s.status === "legacy_compatibility") ? "legacy_compatibility" : "incomplete",
    complete, partialValues: statuses.some(s => s.partialValues), diagnostics };
}
const rowKey = line => line.id ?? line.label;
export function pairedBalanceRows(current, opening) {
  const a = new Map(current.map(line => [rowKey(line), line]));
  const b = new Map(opening.map(line => [rowKey(line), line]));
  return [...new Set([...a.keys(), ...b.keys()])].map(id => ({
    ...(a.get(id) ?? b.get(id)), opening: b.get(id)?.value ?? null, value: a.get(id)?.value ?? null,
  }));
}
export function incomeExportRows(data) {
  if (data.rows?.current?.length) {
    const ytd = new Map(data.rows.ytd.map(row => [row.id, row]));
    return data.rows.current.map(row => ({ id: row.id, label: row.label,
      current: row.valueMinor / 100, ytd: ytd.has(row.id) ? ytd.get(row.id).valueMinor / 100 : null }));
  }
  return Object.keys(data.current).map(label => ({ id: label, label, current: data.current[label], ytd: data.ytd[label] }));
}

// Cash flow is a flow measure: sum each month's existing classifications, never sum cash balances.
function yearCashFlow(setId, period, yearStart) {
  const months = [];
  for (let month = Number(yearStart.slice(5)); month <= Number(period.slice(5)); month++) {
    months.push(cashFlowStatement(setId, `${period.slice(0, 4)}-${String(month).padStart(2, "0")}`));
  }
  const result = { period, method: months[0].method, accountingContext: months[0].accountingContext, reportStatus: aggregateStatus(months.map(month => month.reportStatus)) };
  for (const category of ["operating", "investing", "financing"]) {
    const values = new Map();
    for (const month of months) for (const line of month[category]) {
      const previous = values.get(line.code);
      values.set(line.code, { ...line, value: (previous?.value ?? 0n) + cents(line.value) });
    }
    result[category] = [...values.values()].filter((line) => line.value !== 0n).map(line => ({ ...line, value: number(line.value) })).sort((a, b) => a.code.localeCompare(b.code));
  }
  result.totals = Object.fromEntries(["operating", "investing", "financing"].map((category) => [category, sum(result[category].map((line) => line.value))]));
  result.totals.net_increase = sum(Object.values(result.totals));
  result.cash = { begin: months[0].cash.begin, end: months.at(-1).cash.end, change: difference(months.at(-1).cash.end, months[0].cash.begin) };
  result.reconciles = Math.abs(result.totals.net_increase - result.cash.change) < 0.005;
  result.supplement_indirect = Object.fromEntries(Object.keys(months[0].supplement_indirect).map((key) => [key, sum(months.map((month) => month.supplement_indirect[key]))]));
  return result;
}

// Numeric cells are generated internally. Untrusted text is quoted and formula-neutralized,
// including leading whitespace, tabs, CR/LF, and BOM before a spreadsheet formula marker.
function csvCell(value) {
  if (typeof value === "number") return formatCents(cents(value));
  let text = typeof value === "boolean" ? (value ? "是" : "否") : String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function requireFiniteNumbers(value, field = "report") {
  if (typeof value === "number" && !Number.isFinite(value)) fail("report_data_invalid", { field });
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) requireFiniteNumbers(item, `${field}.${key}`);
  }
}

function toCsv(report) {
  const rows = [
    ["报表", TITLES[report.kind]], ["账套", report.accountSet.name], ["账套ID", String(report.accountSet.id)],
    ["期间", report.period], ["期间状态", report.scope.periodStatus], ["会计准则（账套登记值）", report.accountSet.accountingStandard],
    ["持久profile", report.accountingContext.profileId], ["科目版本", report.accountingContext.coaVersion], ["映射版本", report.accountingContext.reportMappingVersion], ["旧账兼容", report.accountingContext.legacy],
    ["报表映射状态", report.reportStatus.status], ["映射完整", report.reportStatus.complete], ["部分金额", report.reportStatus.partialValues],
    ["数据范围", "仅已过账凭证及建账期初"], ["本年累计起点", report.scope.yearStart],
    ["无期初金额且无已过账记录", report.dataStatus.empty], ["数据完整性", "未核实"], ["可申报文件", false],
  ];
  for (const diagnostic of report.reportStatus.diagnostics) rows.push(["映射诊断", diagnostic.code, diagnostic.reportKind]);
  for (const warning of report.warnings) rows.push(["限制", warning.code, warning.message]);
  rows.push([], ["试算口径", "借方", "贷方", "差额", "平衡"]);
  for (const [key, label] of [["opening", "期间期初"], ["current", "本期发生"], ["ytd", "本年累计"], ["closing", "期末"]]) {
    const check = report.checks.trialBalance[key];
    rows.push([label, check.debit, check.credit, check.difference, check.balanced]);
  }
  const data = report.data;
  if (report.kind === "trial-balance") {
    rows.push([], ["科目编码", "科目名称", "方向", "期初借方", "期初贷方", "本期借方", "本期贷方", "本年借方", "本年贷方", "期末借方", "期末贷方"]);
    for (const line of data.lines) rows.push([line.code, line.name, line.direction, ...MONEY_FIELDS.map((field) => line[field])]);
    rows.push(["合计", "各科目自身发生额，不含重复汇总", "", ...MONEY_FIELDS.map((field) => data.totals[field])]);
  } else if (report.kind === "ledger") {
    rows.push([], ["科目", data.code, data.name], ["范围", "本科目及编码前缀下级，逐笔且不重复"], ["摘要口径", "借方", "贷方"]);
    for (const [key, label] of [["opening", "期间期初"], ["current", "本期发生"], ["ytd", "本年累计"], ["closing", "期末"]]) rows.push([label, data[key].debit, data[key].credit]);
    rows.push([], ["日期", "凭证字", "凭证号", "凭证ID", "分录ID", "科目编码", "科目名称", "摘要", "借方", "贷方", "余额（借减贷）"]);
    for (const line of data.items) rows.push([line.voucher_date, line.word, String(line.number), String(line.voucher_id), String(line.entry_id), line.code, line.name, line.summary, line.debit, line.credit, line.balance]);
  } else if (report.kind === "balance-sheet") {
    rows.push([], ["资产负债表平衡", data.balanced], ["期间期初资产负债表平衡", data.opening.balanced], ["分类", "项目", "期间期初", "期末"]);
    for (const [section, label] of [["assets", "资产"], ["liabilities", "负债及权益"]]) {
      for (const line of pairedBalanceRows(data[section], data.opening[section])) rows.push([label, line.label, line.opening, line.value]);
    }
  } else if (report.kind === "income-statement") {
    rows.push([], ["项目", "本期发生", "本年累计"]);
    for (const line of incomeExportRows(data)) rows.push([line.label, line.current, line.ytd]);
  } else {
    rows.push([], ["现金流勾稽（本期）", data.reconciles], ["现金流勾稽（本年）", data.ytd.reconciles], ["间接法是否独立勾稽", false], ["分类", "科目编码", "科目名称", "本期发生", "本年累计"]);
    for (const [section, label] of [["operating", "经营活动"], ["investing", "投资活动"], ["financing", "筹资活动"]]) {
      const current = new Map(data[section].map((line) => [line.code, line]));
      const ytd = new Map(data.ytd[section].map((line) => [line.code, line]));
      for (const code of [...new Set([...current.keys(), ...ytd.keys()])].sort()) rows.push([label, code, (current.get(code) || ytd.get(code)).name, current.get(code)?.value || 0, ytd.get(code)?.value || 0]);
      rows.push([`${label}净额`, "", "", data.totals[section], data.ytd.totals[section]]);
    }
    rows.push(["现金净增加额", "", "", data.totals.net_increase, data.ytd.totals.net_increase]);
    rows.push(["现金期初余额", "", "", data.cash.begin, data.ytd.cash.begin], ["现金期末余额", "", "", data.cash.end, data.ytd.cash.end], ["现金余额变动", "", "", data.cash.change, data.ytd.cash.change]);
    rows.push([], ["间接法补充（非独立勾稽）", "本期发生", "本年累计"]);
    for (const key of Object.keys(data.supplement_indirect)) rows.push([key, data.supplement_indirect[key], data.ytd.supplement_indirect[key]]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Build a local, internal CSV download without writing bookkeeping data. */
export function buildReportExport(setId, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("report_options_invalid");
  const { kind, period, format = "csv", code } = options;
  if (!KINDS.includes(kind)) fail("report_kind_unsupported", { supported: KINDS });
  if (format !== "csv") fail("report_format_unsupported", { supported: ["csv"] });
  if (period === undefined || period === null || period === "") fail("period_required");
  if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || period.slice(0, 4) === "0000") fail("period_invalid");
  if (!((typeof setId === "number" && Number.isSafeInteger(setId)) || (typeof setId === "string" && /^\d+$/.test(setId))) || Number(setId) < 1 || !Number.isSafeInteger(Number(setId))) fail("account_set_not_found");
  const id = Number(setId);
  const accountSet = one("SELECT id,name,start_period,accounting_standard FROM account_sets WHERE id=?", id);
  if (!accountSet) fail("account_set_not_found", { accountSetId: id });
  if (period < accountSet.start_period) fail("period_before_start", { period, startPeriod: accountSet.start_period });
  const registered = one("SELECT status FROM periods WHERE account_set_id=? AND period=?", id, period);
  if (!registered) fail("period_not_registered", { period });
  const accounts = all("SELECT code,name,category,direction FROM accounts WHERE account_set_id=? ORDER BY code", id);
  let account;
  if (kind === "ledger") {
    if (typeof code !== "string" || !code.trim()) fail("account_code_required");
    account = accounts.find((item) => item.code === code);
    if (!account) fail("account_not_found", { code });
  }
  const yearStart = accountSet.start_period > `${period.slice(0, 4)}-01` ? accountSet.start_period : `${period.slice(0, 4)}-01`;
  const trial = buildTrial(id, period, accountSet.start_period, yearStart, accounts);
  const postedCount = one("SELECT COUNT(*) count FROM vouchers WHERE account_set_id=? AND status='posted' AND period BETWEEN ? AND ?", id, accountSet.start_period, period).count;
  const openingCount = one("SELECT COUNT(*) count FROM opening_balances WHERE account_set_id=? AND (debit<>0 OR credit<>0)", id).count;
  const report = {
    schemaVersion: 1, kind, period,
    accountingContext: accountSetProfile(id).context,
    reportStatus: { status: "not_applicable", complete: false, partialValues: false, diagnostics: [] },
    accountSet: { id, name: accountSet.name, startPeriod: accountSet.start_period, accountingStandard: accountSet.accounting_standard },
    scope: { status: "posted", periodStart: `${period}-01`, yearStart: `${yearStart}-01`, periodStatus: registered.status },
    dataStatus: { empty: postedCount === 0 && openingCount === 0, completeness: "unverified", taxFilingReady: false },
    warnings: [
      { code: "completeness_unverified", message: "仅导出现有账簿；数据来源、期间连续性及完整性未核实，零金额不证明来源完整。" },
      { code: "internal_report_only", message: "内部报表，不是税局申报模板；会计准则登记值不证明科目及报表口径符合该准则。" },

    ],
    checks: { trialBalance: trialChecks(trial.totals) },
    data: null,
  };
  if (report.dataStatus.empty) report.warnings.push({ code: "empty_book", message: "范围内无非零建账期初及已过账凭证；这是空账导出，不是数据完整性认证。" });
  if (yearStart > `${period.slice(0, 4)}-01`) report.warnings.push({ code: "partial_year", message: "账套年中启用，本年累计仅含启用期间起的已过账发生额，不含启用前业务。" });
  if (kind === "trial-balance") report.data = trial;
  if (kind === "ledger") report.data = buildLedger(id, period, account, trial);
  if (kind === "balance-sheet") {
    report.data = { ...balanceSheet(id, period), opening: balanceSheet(id, previousPeriod(period)) };
    report.checks.balanceSheet = report.data.balanced;
    report.checks.balanceSheetOpening = report.data.opening.balanced;
  }
  if (kind === "income-statement") report.data = incomeStatement(id, period);
  if (kind === "cash-flow-statement") {
    report.data = { ...cashFlowStatement(id, period), ytd: yearCashFlow(id, period, yearStart) };
    report.checks.cashFlow = report.data.reconciles;
    report.checks.cashFlowYtd = report.data.ytd.reconciles;
    report.checks.indirectIndependent = false;
    report.warnings.push({ code: "cash_flow_allocation_limited", message: report.accountingContext.legacy
      ? "旧账兼容：现金流按凭证现金净变动及对方科目金额比例分摊；复杂双向混合分录可能净额抵销或分类失真，勾稽不证明分类完整，间接法不是独立勾稽。"
      : "现金流分类可解释的单一对方，以及纯单向全额材料1403 / 设备1601复合收付；其它复合或未知分类明确列为部分金额。勾稽不证明分类完整，间接法不是独立勾稽。" });
  }
  if (!["trial-balance", "ledger"].includes(kind)) {
    const windows = [report.data.reportStatus];
    if (report.data.opening) windows.push(report.data.opening.reportStatus);
    if (report.data.ytd?.reportStatus) windows.push(report.data.ytd.reportStatus);
    report.reportStatus = aggregateStatus(windows);
    report.warnings.push({ code: "accounting_mapping_scope", message: report.accountingContext.legacy
      ? "旧账兼容路径；映射完整性未核实，请核对原账。"
      : "仅已核实的准则基础业务子集；映射状态与来源完整性分别列示，不代表法定完整财务报表。" });
    if (report.reportStatus.partialValues) report.warnings.push({ code: "report_partial_values", message: "本报表含部分金额；未分类或缺明细金额未计入相关合计，请查看映射诊断。" });
  }
  // JSON would silently turn Infinity/NaN into null; reject corrupt amounts before emitting any file.
  requireFiniteNumbers(report);
  const suffix = account ? `-${account.code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}` : "";
  return { filename: `${kind}-${id}-${period}${suffix}.csv`, contentType: "text/csv; charset=utf-8", body: toCsv(report), report };
}
