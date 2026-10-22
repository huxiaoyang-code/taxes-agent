#!/usr/bin/env node
/**
 * LOCAL-04 银行流水 CSV / 字段映射 / 规范化回归（纯函数，不接触数据库）。
 *
 * 覆盖：UTF-8 BOM、CRLF、引号 / 转义引号 / 字段内逗号与换行、重复表头、畸形引号、
 * 文件 / 行 / 字段限制；映射模式与重复列；严格日期（真实日历）；金额整数分
 * （空值 / 零 / 负号 / 千分位 / 超精度 / 指数 / 超界 / 混杂文本）；业务方向映射；
 * 行级预检错误与文件摘要稳定性；以及「导入本模块不创建任何数据库」。
 *
 * 运行：node test/bank-import.test.mjs（在 06-workbench 目录）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as I from "../server/bank-import.mjs";

const BASE_MAPPING = {
  columns: { date: "日期", summary: "摘要", amount: "金额", direction: "方向" },
  amountMode: "amount_direction",
  directionLabels: { inflow: ["收"], outflow: ["付"] },
  currency: "CNY",
};
const map = (over = {}) => ({ ...BASE_MAPPING, ...over, columns: { ...BASE_MAPPING.columns, ...(over.columns || {}) } });
const preview = (csv, mapping = map(), period = "2026-01") => I.previewCsvImport({ csvText: csv, mapping, period });
const codes = (result) => result.errors.map((e) => e.code);

test("CSV：BOM / CRLF / 引号 / 字段内逗号与换行 / 转义引号", () => {
  const csv = "\uFEFF日期,摘要,金额,方向\r\n"
    + "2026-01-02,\"付款,含逗号\",100.00,付\r\n"
    + "2026-01-03,\"多行\n摘要\",200.00,收\r\n"
    + "2026-01-04,\"他说\"\"好\"\"\",300.00,收\r\n";
  const parsed = I.parseBankCsv(csv);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.deepEqual(parsed.headers, ["日期", "摘要", "金额", "方向"]);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[0].cells, ["2026-01-02", "付款,含逗号", "100.00", "付"]);
  assert.equal(parsed.rows[0].lineNumber, 2);
  assert.deepEqual(parsed.rows[1].cells, ["2026-01-03", "多行\n摘要", "200.00", "收"]);
  assert.equal(parsed.rows[1].lineNumber, 3);
  assert.deepEqual(parsed.rows[2].cells, ["2026-01-04", '他说"好"', "300.00", "收"]);
  assert.equal(parsed.rows[2].lineNumber, 5);
});

test("CSV：孤立 CR 换行与结尾无换行都能解析", () => {
  const parsed = I.parseBankCsv("a,b\r1,2\r3,4");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[1].cells, ["3", "4"]);
});

test("CSV：重复 / 空表头、畸形引号、字段过多、空文件都结构化报错", () => {
  assert.deepEqual(codes(I.parseBankCsv("日期,日期\n2026-01-01,2026-01-02")), ["csv_duplicate_header"]);
  assert.deepEqual(codes(I.parseBankCsv("日期,,金额\n2026-01-01,x,1")), ["csv_empty_header"]);
  assert.deepEqual(codes(I.parseBankCsv("日期,摘要\n2026-01-01,\"未闭合")), ["csv_unclosed_quote"]);
  assert.deepEqual(codes(I.parseBankCsv("日期,摘要\n2026-01-01,a\"b")), ["csv_stray_quote"]);
  assert.deepEqual(codes(I.parseBankCsv("日期,摘要\n\"2026-01-01\"x,a")), ["csv_trailing_characters"]);
  assert.deepEqual(codes(I.parseBankCsv("a,b\n1,2,3")), ["csv_row_too_many_fields"]);
  assert.deepEqual(codes(I.parseBankCsv("")), ["csv_empty"]);
  assert.deepEqual(codes(I.parseBankCsv("\uFEFF")), ["csv_empty"]);
});

test("CSV：文件 / 行 / 字段上限显式生效", () => {
  assert.deepEqual(codes(I.parseBankCsv("a,b\n1,2", { limits: { maxBytes: 3 } })), ["csv_too_large"]);
  assert.deepEqual(codes(I.parseBankCsv("a\n" + "1\n".repeat(5), { limits: { maxRows: 3 } })), ["csv_too_many_rows"]);
  assert.deepEqual(codes(I.parseBankCsv("a\n0123456", { limits: { maxFieldChars: 3 } })), ["csv_field_too_long"]);
  assert.deepEqual(codes(I.parseBankCsv("a,b,c\n1,2,3", { limits: { maxColumns: 2 } })), ["csv_too_many_columns"]);
});

test("CSV：空数据行默认跳过并计数，可显式拒绝", () => {
  const parsed = I.parseBankCsv("a,b\n1,2\n,\n \n3,4");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.skippedBlankRows, 2);
  const strict = I.parseBankCsv("a,b\n1,2\n,", { ignoreBlankRows: false });
  assert.ok(codes(strict).includes("csv_blank_row"));
});

test("映射：模式、必需列、重复列、未知键、币种、方向标签都严格校验", () => {
  const bad = (mapping) => I.normalizeMapping(mapping);
  assert.equal(bad({}).errors[0].code, "mapping_columns_required");
  assert.ok(bad({ columns: {}, amountMode: "x" }).errors.some((e) => e.code === "mapping_amount_mode_invalid"));
  assert.ok(bad({
    columns: { date: "d", debit: "x", credit: "y", amount: "z" },
    amountMode: "debit_credit",
  }).errors.some((e) => e.code === "mapping_mode_conflict"));
  assert.ok(bad({
    columns: { date: "d", debit: "d", credit: "c" },
    amountMode: "debit_credit",
  }).errors.some((e) => e.code === "mapping_duplicate_column"));
  assert.ok(bad({
    columns: { date: "d", debit: "a", credit: "b" },
    amountMode: "debit_credit",
  }).errors.some((e) => e.code === "mapping_currency_required"));
  assert.ok(bad({
    columns: { date: "d", debit: "a", credit: "b" },
    amountMode: "debit_credit",
    currency: "USD",
  }).errors.some((e) => e.code === "mapping_currency_unsupported"));
  assert.ok(bad({
    columns: { date: "d", amount: "a", direction: "dir" },
    amountMode: "amount_direction",
    currency: "CNY",
    directionLabels: { inflow: ["收", "付"], outflow: ["付"] },
  }).errors.some((e) => e.code === "mapping_direction_labels_conflict"));
  assert.ok(bad({
    columns: { date: "d", debit: "a", credit: "b", unknownKey: "c" },
    amountMode: "debit_credit",
    currency: "CNY",
  }).errors.some((e) => e.code === "mapping_unknown_column"));
  assert.ok(bad({
    columns: { date: "d", debit: "a", credit: "b" },
    amountMode: "debit_credit",
    currency: "CNY",
    negativeAmount: "reverse_direction",
  }).errors.some((e) => e.code === "mapping_negative_rule_invalid"));
  assert.ok(bad({
    columns: { date: "d", amount: "a", direction: "dir" },
    amountMode: "amount_direction",
    currency: "CNY",
    dateFormat: "DD/MM/YYYY",
    directionLabels: { inflow: ["收"], outflow: ["付"] },
  }).errors.some((e) => e.code === "mapping_date_format_invalid"));
});

test("映射：规范映射指纹稳定，规则版本变化会改变指纹", () => {
  const a = I.normalizeMapping(map());
  const b = I.normalizeMapping(map());
  assert.equal(a.ok, true);
  assert.equal(a.fingerprint, b.fingerprint);
  const c = I.normalizeMapping(map({ summaryMaxChars: 100 }));
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.equal(a.mapping.normalizationVersion, I.NORMALIZATION_VERSION);
});

test("日期：严格格式与真实日历，同一日期不同声明格式都规范为 YYYY-MM-DD", () => {
  assert.deepEqual(I.parseDateByFormat("2026-01-05", "YYYY-MM-DD"), { ok: true, date: "2026-01-05" });
  assert.deepEqual(I.parseDateByFormat("2026/01/05", "YYYY/MM/DD"), { ok: true, date: "2026-01-05" });
  assert.deepEqual(I.parseDateByFormat("20260105", "YYYYMMDD"), { ok: true, date: "2026-01-05" });
  assert.equal(I.parseDateByFormat("2026-02-30", "YYYY-MM-DD").ok, false);
  assert.equal(I.parseDateByFormat("2026-13-01", "YYYY-MM-DD").ok, false);
  assert.equal(I.parseDateByFormat("2026-1-5", "YYYY-MM-DD").ok, false);
  assert.equal(I.parseDateByFormat("", "YYYY-MM-DD").code, "row_date_missing");
  assert.equal(I.parseDateByFormat("2026-01-05", "YYYY/MM/DD").ok, false);
  assert.equal(I.parseDateByFormat("2026-01-05", "BAD").code, "mapping_date_format_invalid");
});

test("金额：整数分、空值 / 零、负号、千分位、超精度、指数、超界、混杂文本", () => {
  assert.deepEqual(I.parseAmountText("100"), { ok: true, cents: 10000, negative: false, empty: false });
  assert.deepEqual(I.parseAmountText("0.05"), { ok: true, cents: 5, negative: false, empty: false });
  assert.deepEqual(I.parseAmountText("  "), { ok: true, cents: 0, negative: false, empty: true });
  assert.deepEqual(I.parseAmountText(undefined), { ok: true, cents: 0, negative: false, empty: true });
  assert.deepEqual(I.parseAmountText("0"), { ok: true, cents: 0, negative: false, empty: false });
  assert.deepEqual(I.parseAmountText("-12.34"), { ok: true, cents: 1234, negative: true, empty: false });
  assert.equal(I.parseAmountText("1.234").code, "amount_precision");
  assert.equal(I.parseAmountText("1.2.3").code, "amount_invalid");
  assert.equal(I.parseAmountText("1e3").code, "amount_exponent");
  assert.equal(I.parseAmountText("abc").code, "amount_invalid");
  assert.equal(I.parseAmountText("12abc").code, "amount_invalid");
  assert.equal(I.parseAmountText("NaN").code, "amount_invalid");
  assert.equal(I.parseAmountText("Infinity").code, "amount_invalid");
  assert.equal(I.parseAmountText("1,000").code, "amount_invalid");
  assert.equal(I.parseAmountText("1,000.00", { thousandsSeparator: "," }).cents, 100000);
  assert.equal(I.parseAmountText("1000.00", { thousandsSeparator: "," }).cents, 100000);
  assert.equal(I.parseAmountText("1,00.00", { thousandsSeparator: "," }).code, "amount_invalid");
  assert.equal(I.parseAmountText("¥1,234.50", { thousandsSeparator: ",", allowCurrencySymbol: true }).cents, 123450);
  assert.equal(I.parseAmountText("1000000000000").code, "amount_overflow");
  assert.equal(I.formatCents(123450), "1234.50");
  assert.equal(I.formatCents(-5), "-0.05");
});

test("预检：借贷两列模式的空 / 零 / 双边非零 / 负数规则", () => {
  const mapping = {
    columns: { date: "日期", summary: "摘要", debit: "借方", credit: "贷方" },
    amountMode: "debit_credit",
    currency: "CNY",
  };
  const ok = preview("日期,摘要,借方,贷方\n2026-01-05,收款,100.00,\n2026-01-06,付款,0.00,50.00", mapping);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.rows[0].direction, "inflow");
  assert.equal(ok.rows[0].amountCents, 10000);
  assert.equal(ok.rows[1].direction, "outflow");
  assert.equal(ok.rows[1].amountCents, 5000);

  assert.ok(codes(preview("日期,摘要,借方,贷方\n2026-01-05,空行,,\n", mapping)).includes("row_amount_missing"));
  assert.ok(codes(preview("日期,摘要,借方,贷方\n2026-01-05,双边,1.00,1.00\n", mapping)).includes("row_amount_both_sides"));
  assert.ok(codes(preview("日期,摘要,借方,贷方\n2026-01-05,负数,-1.00,\n", mapping)).includes("row_amount_negative"));
});

test("预检：金额 + 方向模式、未声明方向、负号翻转规则、零金额", () => {
  const mapping = map();
  const ok = preview("日期,摘要,金额,方向\n2026-01-05,收款,100.00,收\n2026-01-06,付款,50.00,付");
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.rows[0].direction, "inflow");
  assert.equal(ok.rows[1].direction, "outflow");

  assert.ok(codes(preview("日期,摘要,金额,方向\n2026-01-05,x,100.00,未知")).includes("row_direction_invalid"));
  assert.ok(codes(preview("日期,摘要,金额,方向\n2026-01-05,x,,收")).includes("row_amount_missing"));
  assert.ok(codes(preview("日期,摘要,金额,方向\n2026-01-05,x,0,收")).includes("row_amount_zero"));
  assert.ok(codes(preview("日期,摘要,金额,方向\n2026-01-05,x,-1.00,收")).includes("row_amount_negative"));

  const flip = preview("日期,摘要,金额,方向\n2026-01-05,冲正,-100.00,收", map({ negativeAmount: "reverse_direction" }));
  assert.equal(flip.ok, true, JSON.stringify(flip.errors));
  assert.equal(flip.rows[0].direction, "outflow");
  assert.equal(flip.rows[0].amountCents, 10000);
});

test("预检：期间一致、币种、摘要 / 流水号上限、文件内重复流水号", () => {
  assert.ok(codes(preview("日期,摘要,金额,方向\n2026-02-01,x,1.00,收")).includes("row_date_period_mismatch"));
  assert.ok(codes(preview("日期,摘要,金额,方向,币种\n2026-01-01,x,1.00,收,USD",
    map({ columns: { currency: "币种" } }))).includes("row_currency_unsupported"));
  assert.ok(codes(preview("日期,摘要,金额,方向,币种\n2026-01-01,x,1.00,收,",
    map({ columns: { currency: "币种" } }))).includes("row_currency_missing"));
  assert.ok(codes(preview(`日期,摘要,金额,方向\n2026-01-01,${"x".repeat(201)},1.00,收`))
    .includes("row_summary_too_long"));
  assert.ok(codes(preview("日期,摘要,金额,方向,流水号\n2026-01-01,x,1.00,收,A1\n2026-01-02,x,2.00,收,A1",
    map({ columns: { refId: "流水号" } }))).includes("row_duplicate_ref_id"));
  assert.ok(codes(preview("日期,摘要,金额,方向,流水号\n2026-01-01,x,1.00,收,含空格 的号",
    map({ columns: { refId: "流水号" } }))).includes("row_ref_id_invalid"));
});

test("预检：缺列、空文件、映射错误都阻止导入，并保持行级证据", () => {
  const missing = preview("日期,摘要,金额\n2026-01-01,x,1.00");
  assert.equal(missing.ok, false);
  assert.ok(codes(missing).includes("csv_missing_column"));
  const empty = preview("日期,摘要,金额,方向\n");
  assert.equal(empty.ok, false);
  const badMapping = preview("日期,摘要\n2026-01-01,x", { columns: { date: "日期" }, amountMode: "amount_direction" });
  assert.equal(badMapping.ok, false);
  assert.equal(badMapping.stage, "mapping");
  assert.ok(badMapping.errors.length > 0);
});

test("预检：文件摘要稳定、行指纹只用于疑似重复、内容指纹包含稳定 ID", () => {
  const csv = "日期,摘要,金额,方向,流水号\n2026-01-05,收款,100.00,收,A-1\n";
  const mapping = map({ columns: { refId: "流水号" } });
  const first = preview(csv, mapping);
  const second = preview(csv, mapping);
  assert.equal(first.fileDigest, second.fileDigest);
  assert.equal(first.rows[0].rowFingerprint, second.rows[0].rowFingerprint);
  assert.equal(first.rows[0].contentFingerprint, second.rows[0].contentFingerprint);
  const noRef = preview("日期,摘要,金额,方向\n2026-01-05,收款,100.00,收\n");
  assert.equal(first.rows[0].rowFingerprint, noRef.rows[0].rowFingerprint, "行指纹不包含稳定 ID（只作疑似重复信号）");
  assert.notEqual(first.rows[0].contentFingerprint, noRef.rows[0].contentFingerprint);
  const changed = preview("日期,摘要,金额,方向,流水号\n2026-01-05,收款,100.01,收,A-1\n", mapping);
  assert.notEqual(first.rows[0].contentFingerprint, changed.rows[0].contentFingerprint);
  assert.equal(preview("日期,摘要,金额,方向\n2026-01-05,收款,100.00,收\n").fileDigest,
    preview("日期,摘要,金额,方向\n2026-01-05,收款,100.00,收\n").fileDigest);
});

test("无数据库副作用：导入并使用本模块不会创建默认库", () => {
  const dir = mkdtempSync(join(tmpdir(), "bank-import-nodb-"));
  const previous = process.env.WORKBENCH_DATA_DIR;
  process.env.WORKBENCH_DATA_DIR = dir;
  try {
    preview("日期,摘要,金额,方向\n2026-01-05,收款,100.00,收\n");
    I.parseBankCsv("a\n1");
    I.normalizeMapping(map());
    assert.deepEqual(readdirSync(dir), [], "纯解析模块不得创建数据库或任何文件");
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_DATA_DIR;
    else process.env.WORKBENCH_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
