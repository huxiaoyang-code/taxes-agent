#!/usr/bin/env node
// Fixed synthetic test identities, independent of display names and production defaults.
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-report-office-export-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
// LOCAL-05a (Issue #45) acceptance for real XLSX / PDF internal report exports.
// All amounts below are hand-calculated synthetic fixtures; no real account set or credential is used.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';

const dataDir = mkdtempSync(join(tmpdir(), 'wb-office-export-'));
process.env.WORKBENCH_DATA_DIR = dataDir;
const qaDir = mkdtempSync(join(tmpdir(), 'wb-office-qa-'));
console.log(`Office QA: ${qaDir}`);
// Regenerate the whole QA directory so page counts and visual artifacts always match this run.

mkdirSync(qaDir, { recursive: true });
let db;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  PASS ${name}`);
  } catch (error) {
    results.push(false);
    console.error(`  FAIL ${name}\n${error.stack}`);
  }
}
const e = (code, debit = 0, credit = 0, summary) => ({ code, debit, credit, summary });
const MONEY = '#,##0.00';

// Independent PDF text extraction: inflate PDFKit streams, parse the ToUnicode CMap and
// read Tj/TJ glyph strings. This verifies real extractable text without reusing the exporter.
function inflateStreams(buffer) {
  const text = buffer.toString('latin1');
  const streams = [];
  for (const match of text.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = buffer.subarray(start, end);
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        streams.push(inflate(raw).toString('latin1'));
        break;
      } catch { /* not a compressed stream */ }
    }
  }
  return streams;
}
function parseToUnicode(cmap) {
  const map = new Map();
  const unicode = (hex) => {
    let out = '';
    for (let index = 0; index < hex.length; index += 4) out += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
    return out;
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(pair[1], 16), unicode(pair[2]));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F]+>)/g)) {
      const start = parseInt(range[1], 16);
      const end = parseInt(range[2], 16);
      if (range[3].startsWith('[')) {
        [...range[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((match, index) => map.set(start + index, unicode(match[1])));
      } else {
        const base = parseInt(range[3].slice(1, -1), 16);
        for (let code = start; code <= end; code++) map.set(code, String.fromCharCode(base + code - start));
      }
    }
  }
  return map;
}
function glyphText(digits, map) {
  let out = '';
  for (let index = 0; index + 4 <= digits.length; index += 4) out += map.get(parseInt(digits.slice(index, index + 4), 16)) ?? "";
  return out;
}
function extractPdf(buffer) {
  const streams = inflateStreams(buffer);
  const cmapText = streams.find((stream) => stream.includes('beginbfrange') || stream.includes('beginbfchar')) || "";
  const map = parseToUnicode(cmapText);
  assert.ok(map.size > 20, 'PDF must contain a usable ToUnicode CMap');
  const pages = [];
  for (const stream of streams) {
    if (!/\bT[Jj]\b/.test(stream) || !stream.includes('BT')) continue;
    let text = '';
    for (const array of stream.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      for (const hex of array[1].matchAll(/<([0-9a-fA-F]+)>/g)) text += glyphText(hex[1], map);
    }
    for (const single of stream.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) text += glyphText(single[1], map);
    pages.push(text);
  }
  const latin = buffer.toString('latin1');
  const media = latin.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  return {
    pages,
    text: pages.join('\n'),
    squash: pages.join('\n').replace(/\s+/g, ''),
    pageCount: pages.length,
    width: media ? Number(media[1]) : 0,
    height: media ? Number(media[2]) : 0,
    embeddedFont: /\/FontFile2/.test(latin),
    hasStandardFont: /\/BaseFont\s*\/Helvetica/.test(latin),
  };
}

function findRow(worksheet, firstValue) {
  for (let row = 1; row <= worksheet.rowCount; row++) {
    if (String(worksheet.getRow(row).getCell(1).value ?? "") === firstValue) return row;
  }
  return 0;
}
function cellNumber(worksheet, row, column, expected, label) {
  const cell = worksheet.getRow(row).getCell(column);
  assert.equal(typeof cell.value, "number", `${label} must be a numeric cell, got ${typeof cell.value} (${cell.value})`);
  assert.ok(Math.abs(cell.value - expected) < 0.005, `${label} expected ${expected}, got ${cell.value}`);
  assert.equal(cell.numFmt, MONEY, `${label} must use two-decimal money format`);
}
function assertTextCell(worksheet, row, column, expected, label) {
  const cell = worksheet.getRow(row).getCell(column);
  assert.equal(cell.value, expected, `${label} text must be preserved exactly`);
  assert.notEqual(cell.type, ExcelJS.ValueType.Formula, `${label} must not become a formula`);
  assert.equal(cell.formula, undefined, `${label} must not carry a formula`);
}
async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

const artifacts = [];
function save(name, body) {
  const path = join(qaDir, name);
  writeFileSync(path, body);
  artifacts.push(path);
  return path;
}
function toolAvailable(name, args = ["-v"]) {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 20000 });
  return !result.error;
}

function csvRows(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(field); field = ''; }
    else if (!quoted && ch === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i++;
    } else field += ch;
  }
  assert.equal(quoted, false, 'CSV quotes must close');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

try {
  ({ db } = await import("../server/db.mjs"));
  const A = await import("../server/accounting.mjs");
  const { buildOfficeExport, buildReportDocument } = await import("../server/report-office-export.mjs");
  const { buildReportExport } = await import("../server/report-export.mjs");
  const make = (name = "合成验收账套", start_period = "2025-12") => identityFixtureCreate(A, { name, start_period }).id;
  const voucher = (setId, period, entries, extra = {}) => A.createVoucher(setId, { period, status: "posted", entries, ...extra });
  const office = (setId, kind, period, format, extra = {}) => buildOfficeExport(setId, { kind, period, format, ...extra });
  const dto = (setId, kind, period, extra = {}) => buildReportExport(setId, { kind, period, ...extra }).report;

  const s = make();
  A.addAccount(s, { code: "100201", name: "银行中文明细", category: "资产", direction: "debit" });
  A.setOpeningBalances(s, [e("1002", 1000), e("100201", 200), e("1601", 1200), e("3001", 0, 2400)]);
  voucher(s, "2025-12", [e("1002", 300), e("5001", 0, 300)]);
  voucher(s, "2025-12", [e("5602", 60), e("1002", 0, 60)]);
  A.carryForwardProfit(s, "2025-12", { yearEnd: true });
  voucher(s, "2026-01", [e("100201", 400), e("5001", 0, 400)]);
  voucher(s, "2026-01", [e("1403", 120), e("1601", 180), e("1002", 0, 300)]);
  voucher(s, "2026-01", [e("5602", 50), e("1002", 0, 50)]);
  A.addAssetCard(s, { name: "期初设备", original_cost: 1200, residual_rate: 0, useful_life_months: 12, start_period: "2026-01" });
  A.generateDepreciation(s, "2026-01");
  voucher(s, "2026-02", [e("100201", 200), e("5001", 0, 200)]);
  voucher(s, "2026-02", [e("5602", 20), e("1002", 0, 20)]);

  // ---------------------------------------------------------------- CSV compatibility
  await test("CSV stays available through the office entry point and keeps its DTO", async () => {
    const file = await office(s, "trial-balance", "2026-02", "csv");
    assert.equal(file.filename, "trial-balance-1-2026-02.csv");
    assert.match(file.contentType, /text\/csv.*utf-8/i);
    assert.equal(file.body.charCodeAt(0), 0xfeff);
    assert.equal(file.report.schemaVersion, 1);
    assert.deepEqual(file.report, dto(s, "trial-balance", "2026-02"));
  });


  await test("B2: two persistent profiles, three months, all five CSV/XLSX/PDF exports match independent amounts", async () => {
const SMALL = "小企业会计准则";
const ENTERPRISE = "企业会计准则";
const SMALL_SOURCE = { system: "local-book", enterpriseKey: "91350000SMALL0001X", enterpriseName: "合成小企" };
const ENTERPRISE_SOURCE = { system: "local-book", enterpriseKey: "91350000ENT00001Y", enterpriseName: "合成企业" };

const SMALL_OPENINGS = [e("1002", 10000), e("1405", 2000), e("3001", 0, 12000)];
const ENTERPRISE_OPENINGS = [e("1002", 20000), e("1405", 3000), e("5001", 1000), e("4001", 0, 24000)];

const smallMonths = {
  "2025-11": [
    [e("1002", 3000), e("5001", 0, 3000)],
    [e("5401", 1200), e("1405", 0, 1200)],
    [e("5602", 200), e("1002", 0, 200)],
  ],
  "2025-12": [
    [e("1122", 1500), e("5001", 0, 1500)],
    [e("5401", 600), e("1405", 0, 600)],
    [e("1002", 1000), e("1122", 0, 1000)],
    [e("5602", 100), e("1002", 0, 100)],
  ],
  "2026-01": [
    [e("1002", 500), e("1122", 0, 500)],
    [e("1405", 800), e("1002", 0, 800)],
    [e("1002", 1200), e("5001", 0, 1200)],
    [e("5401", 500), e("1405", 0, 500)],
    [e("5602", 100), e("1002", 0, 100)],
  ],
};

const enterpriseMonths = {
  "2025-11": [
    [e("1002", 5000), e("6001", 0, 5000)],
    [e("6401", 2000), e("1405", 0, 2000)],
    [e("6602", 500), e("1002", 0, 500)],
  ],
  "2025-12": [
    [e("1122", 2400), e("6001", 0, 2400)],
    [e("6401", 900), e("1405", 0, 900)],
    [e("1002", 1600), e("1122", 0, 1600)],
    [e("6602", 200), e("1002", 0, 200)],
  ],
  "2026-01": [
    [e("1002", 800), e("1122", 0, 800)],
    [e("1405", 1500), e("1002", 0, 1500)],
    [e("1002", 2000), e("6001", 0, 2000)],
    [e("6401", 1000), e("1405", 0, 1000)],
    [e("6602", 300), e("1002", 0, 300)],
  ],
};

// 表格中的独立手算预期（元）。
const SMALL_EXPECT = {
  "2025-11": { revenue: 3000, profit: 1600, ytdProfit: 1600, cash: 12800, receivable: 0, inventory: 800, total: 13600, operating: 2800 },
  "2025-12": { revenue: 1500, profit: 800, ytdProfit: 2400, cash: 13700, receivable: 500, inventory: 200, total: 14400, operating: 900 },
  "2026-01": { revenue: 1200, profit: 600, ytdProfit: 600, cash: 14500, receivable: 0, inventory: 500, total: 15000, operating: 800 },
};
const ENTERPRISE_EXPECT = {
  "2025-11": { revenue: 5000, profit: 2500, ytdProfit: 2500, cash: 24500, receivable: 0, inventory: 2000, total: 26500, operating: 4500 },
  "2025-12": { revenue: 2400, profit: 1300, ytdProfit: 3800, cash: 25900, receivable: 800, inventory: 1100, total: 27800, operating: 1400 },
  "2026-01": { revenue: 2000, profit: 700, ytdProfit: 700, cash: 26900, receivable: 0, inventory: 1600, total: 28500, operating: 1000 },
};


    const evidence = [];
    const kinds = ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"];
    for (const [tag, standard, openings, months, expectations, profile, openingCash, bankDebits, bankCredits, ytdDebits, ytdCredits] of [
      ["small", SMALL, SMALL_OPENINGS, smallMonths, SMALL_EXPECT, "small-2011-basic-v1", 10000, [3000, 1000, 1700], [200, 100, 900], [3000, 4000, 1700], [200, 300, 900]],
      ["enterprise", ENTERPRISE, ENTERPRISE_OPENINGS, enterpriseMonths, ENTERPRISE_EXPECT, "enterprise-2019-general-basic-v1", 20000, [5000, 1600, 2800], [500, 200, 1800], [5000, 6600, 2800], [500, 700, 1800]],
    ]) {
      const id = identityFixtureCreate(A, { name: `合成B2-${tag}`, accounting_standard: standard, start_period: "2025-11" }).id;
      A.setOpeningBalances(id, openings);
      let priorCash = openingCash;
      for (const [index, period] of Object.keys(months).entries()) {
        for (const entries of months[period]) voucher(id, period, entries);
        A.carryForwardProfit(id, period, { yearEnd: period.endsWith("-12") });
        const expected = expectations[period];
        assert.equal(A.incomeStatement(id, period).current["净利润"], expected.profit);
        assert.equal(A.incomeStatement(id, period).ytd["净利润"], expected.ytdProfit);
        const ytdBegin = index === 2 ? expectations["2025-12"].cash : openingCash;
        for (const kind of kinds) {
          const extra = kind === "ledger" ? { code: "1002" } : {};
          const csv = await office(id, kind, period, "csv", extra);
          const report = csv.report;
          assert.equal(report.accountingContext.profileId, profile);
          assert.equal(report.reportStatus.status, ["trial-balance", "ledger"].includes(kind) ? "not_applicable" : "complete");
          const rows = csvRows(csv.body);
          const csvRow = (label, column = 0) => rows.find(row => row[column] === label
            && (kind !== "ledger" || !["期间期初", "本期发生", "本年累计", "期末"].includes(label) || row.length === 3));
          assert.equal(csvRow("持久profile")[1], profile);
          const checks = kind === "balance-sheet" ? [["货币资金", 2, priorCash], ["货币资金", 3, expected.cash]]
            : kind === "income-statement" ? [["净利润", 2, expected.profit], ["净利润", 3, expected.ytdProfit]]
            : kind === "cash-flow-statement" ? [["现金净增加额", 3, expected.operating], ["现金净增加额", 4, expected.cash-ytdBegin], ["现金期初余额", 3, priorCash], ["现金期末余额", 3, expected.cash], ["现金期初余额", 4, ytdBegin]]
            : kind === "trial-balance" ? [["1002", 4, priorCash], ["1002", 6, bankDebits[index]], ["1002", 7, bankCredits[index]], ["1002", 8, ytdDebits[index]], ["1002", 9, ytdCredits[index]], ["1002", 10, expected.cash]]
            : [["期间期初", 2, priorCash], ["本期发生", 2, bankDebits[index]], ["本期发生", 3, bankCredits[index]], ["本年累计", 2, ytdDebits[index]], ["本年累计", 3, ytdCredits[index]], ["期末", 2, expected.cash]];
          for (const [label, col, amount] of checks) {
            const row = csvRow(label, kind === "balance-sheet" ? 1 : 0);
            const csvColumn = kind === "balance-sheet" ? col : kind === "cash-flow-statement" ? col + 0 : col - 1;
            assert.equal(Number(row[csvColumn]), amount, `${tag}/${period}/${kind} CSV ${label}/${col}`);
          }
          const xlsx = await office(id, kind, period, "xlsx", extra);
          const sheet = (await loadWorkbook(xlsx.body)).worksheets[0];
          for (const [label, col, amount] of checks) cellNumber(sheet, findRow(sheet, kind === "ledger" && label === "期末" ? "期末余额" : label), col, amount, `${tag}/${period}/${kind} XLSX ${label}/${col}`);
          assert.equal(sheet.getRow(findRow(sheet, "持久profile")).getCell(2).value, profile);
          const pdf = await office(id, kind, period, "pdf", extra);
          const extracted = extractPdf(pdf.body);
          assert.equal(extracted.pageCount, pdf.pageCount);
          assert.ok(extracted.embeddedFont);
          assert.ok(extracted.squash.includes(profile));
          assert.ok(extracted.squash.includes("内部报表"));
          for (let page = 0; page < extracted.pageCount; page++) {
            assert.ok(extracted.pages[page].includes("第"), `${tag}/${kind} page ${page+1} has Chinese footer`);
          }
          for (const amount of new Set(checks.map(check => check[2]))) {
            const text = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
            assert.ok(extracted.squash.includes(text), `${tag}/${period}/${kind} PDF missing ${text}`);
          }
          const base = `b2-${tag}-${period}-${kind}`;
          save(`${base}.csv`, csv.body);
          save(`${base}.xlsx`, xlsx.body);
          const path = save(`${base}.pdf`, pdf.body);
          const rendered = spawnSync("pdftoppm", ["-r", "60", "-png", path, join(qaDir, `${base}-page`)], { encoding: "utf8", timeout: 60000 });
          assert.equal(rendered.status, 0, rendered.stderr);
          const pngs = readdirSync(qaDir).filter(name => name.startsWith(`${base}-page-`) && name.endsWith(".png"));
          assert.equal(pngs.length, pdf.pageCount);
          for (const png of pngs) assert.ok(readFileSync(join(qaDir, png)).length > 1000);
          evidence.push({ tag, period, kind, profile, reportStatus: report.reportStatus, checks, pageCount: pdf.pageCount, pngs });
        }
        priorCash = expected.cash;
      }
    }
    save("b2-independent-evidence.json", JSON.stringify(evidence, null, 2));
    assert.equal(evidence.length, 30);
  });

  await test("B2: stable IDs survive reordered opening rows and renamed display labels", () => {
    const report = structuredClone(dto(s, "balance-sheet", "2026-01"));
    report.data.assets = [{ id: "cash", label: "新名称", value: 120 }, { id: "stock", label: "存货", value: 50 }];
    report.data.opening.assets = [{ id: "stock", label: "存货", value: 30 }, { id: "cash", label: "旧名称", value: 100 }];
    const document = buildReportDocument(report);
    assert.deepEqual(document.sections[0].rows.map(row => row.cells), [["新名称", 100, 120], ["存货", 30, 50]]);
  });
  await test("B2: ambiguous construction cash payments and earlier partial months remain partial in all formats", async () => {
    for (const standard of ["小企业会计准则", "企业会计准则"]) {
      const id = identityFixtureCreate(A, { name: "合成在建用途待核", accounting_standard: standard, start_period: "2026-01" }).id;
      A.setOpeningBalances(id, [e("1002", 1000), e(standard === "小企业会计准则" ? "3001" : "4001", 0, 1000)]);
      voucher(id, "2026-01", [e("1604", 100), e("1002", 0, 100)]);
      voucher(id, "2026-02", [e("1002", 20), e(standard === "小企业会计准则" ? "5001" : "6001", 0, 20)]);
      const current = dto(id, "cash-flow-statement", "2026-02");
      assert.equal(current.data.reportStatus.complete, true);
      assert.equal(current.data.ytd.reportStatus.complete, false);
      assert.equal(current.reportStatus.partialValues, true);
      assert.deepEqual(current.data.ytd.cash, { begin: 1000, end: 920, change: -80 });
      assert.equal(current.data.ytd.totals.net_increase, 20);
      const january = dto(id, "cash-flow-statement", "2026-01");
      assert.equal(january.data.unknown.length, 1);
      assert.equal(january.data.cash.change, -100);
      assert.equal(january.data.totals.net_increase, 0);
      assert.equal(january.reportStatus.complete, false);
      assert.ok(january.reportStatus.diagnostics.some(item => item.code === "cash_flow_classification_incomplete"));
      for (const format of ["csv", "xlsx", "pdf"]) {
        const file = await office(id, "cash-flow-statement", "2026-02", format);
        assert.equal(file.report.reportStatus.status, "incomplete");
        if (format === "csv") {
          assert.ok(csvRows(file.body).some(row => row[0] === "部分金额" && row[1] === "是"));
          assert.ok(csvRows(file.body).some(row => row[0] === "现金余额变动" && row[4] === "-80.00"));
        } else if (format === "xlsx") {
          const sheet = (await loadWorkbook(file.body)).worksheets[0];
          assert.equal(sheet.getRow(findRow(sheet, "部分金额")).getCell(2).value, "是");
          cellNumber(sheet, findRow(sheet, "现金余额变动"), 4, -80, "unclassified historical cash retained");
        } else {
          const pdf = extractPdf(file.body);
          assert.ok(pdf.squash.includes("incomplete"));
          assert.ok(pdf.squash.includes("-80.00"));
          save(`b2-partial-${id}.pdf`, file.body);
        }
        if (format !== "pdf") save(`b2-partial-${id}.${format}`, file.body);
      }
    }
  });
  await test("B2: legacy mixed COA stays partial and keeps legacy folded-income labels in real Office files", async () => {
    const legacy = make("合成迁移旧账企业标签", "2026-01");
    A.addAccount(legacy, { code: "6602", name: "旧账管理费用", category: "损益", direction: "debit" });
    A.setOpeningBalances(legacy, [e("1002", 1000), e("3001", 0, 1000)]);
    db.prepare("UPDATE account_sets SET accounting_profile_id='legacy-small-coa-v1',accounting_standard='企业会计准则' WHERE id=?").run(legacy);
    voucher(legacy, "2026-01", [e("1002", 100), e("5001", 0, 100)]);
    voucher(legacy, "2026-01", [e("6602", 30), e("1002", 0, 30)]);
    const file = await office(legacy, "income-statement", "2026-01", "xlsx");
    assert.equal(file.report.reportStatus.status, "legacy_compatibility");
    assert.equal(file.report.reportStatus.complete, false);
    const sheet = (await loadWorkbook(file.body)).worksheets[0];
    cellNumber(sheet, findRow(sheet, "净利润"), 2, 70, "legacy income");
    assert.ok(findRow(sheet, "其他收入（已并入营业收入）") > 0, "legacy folded-in rows must stay labelled");
    save("b2-legacy-income.xlsx", file.body);
    const pdf = await office(legacy, "income-statement", "2026-01", "pdf");
    assert.ok(extractPdf(pdf.body).squash.includes("legacy_compatibility"));
    save("b2-legacy-income.pdf", pdf.body);
    voucher(legacy, "2026-01", [e("1002", 100), e("1601", 60), e("2001", 0, 160)]);
    const cash = await office(legacy, "cash-flow-statement", "2026-01", "xlsx");
    const cashSheet = (await loadWorkbook(cash.body)).worksheets[0];
    cellNumber(cashSheet, findRow(cashSheet, "现金余额变动"), 3, 170, "legacy mixed cash movement preserved");
    assert.ok(cash.report.warnings.some(w => w.message.includes("比例分摊") && w.message.includes("可能净额抵销")));
    assert.ok(String(cashSheet.getRow(findRow(cashSheet, "现金流编制方法")).getCell(2).value).includes("比例分摊"));
    save("b2-legacy-cash.xlsx", cash.body);
    const cashPdf = await office(legacy, "cash-flow-statement", "2026-01", "pdf");
    assert.ok(extractPdf(cashPdf.body).squash.includes("可能净额抵销"));
    save("b2-legacy-cash.pdf", cashPdf.body);
  });

  // ---------------------------------------------------------------- XLSX structure and values
  await test("XLSX: five report kinds produce real workbooks with text, numeric cells and print setup", async () => {
    const expectations = [
      ["balance-sheet", "2026-01", "货币资金", 2, 1440, 1490],
      ["income-statement", "2026-02", "净利润", 2, 180, 430],
      ["cash-flow-statement", "2026-02", "现金净增加额", 3, 180, 530],
      ["trial-balance", "2026-02", "100201", 4, 600, 0],
      ["ledger", "2026-02", "期间期初", 2, 1490, 0],
    ];
    for (const [kind, period, label, valueColumn, current, ytd] of expectations) {
      const extra = kind === "ledger" ? { code: "1002" } : {};
      const file = await office(s, kind, period, "xlsx", extra);
      assert.equal(file.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      assert.match(file.filename, new RegExp(`^${kind}-1-${period}${kind === "ledger" ? "-1002" : ""}\\.xlsx$`));
      assert.ok(Buffer.isBuffer(file.body));
      assert.equal(file.body.subarray(0, 2).toString(), "PK", "XLSX must be a zip container");
      save(file.filename, file.body);
      const workbook = await loadWorkbook(file.body);
      const worksheet = workbook.worksheets[0];
      assert.ok(["资产负债表", "利润表", "现金流量表", "科目余额表", "明细账"].includes(worksheet.name));
      assert.equal(String(worksheet.getCell(1, 1).value), worksheet.name);
      assert.equal(worksheet.getCell(2, 1).value.includes("人民币元"), true, "subtitle must state the currency");
      assert.equal(worksheet.getCell(2, 1).value.includes("内部报表"), true);
      const row = findRow(worksheet, label);
      assert.ok(row > 0, `${kind} must contain a row named ${label}`);
      cellNumber(worksheet, row, valueColumn, current, `${kind} ${label}`);
      if (valueColumn + 1 <= worksheet.columnCount) cellNumber(worksheet, row, valueColumn + 1, ytd, `${kind} ${label} second amount`);
      assert.equal(worksheet.views[0].state, "frozen");
      assert.ok(worksheet.views[0].ySplit > 0, "header row must be frozen");
      assert.match(String(worksheet.pageSetup.printArea), /^A1:[A-Z]+\d+$/);
      assert.equal(worksheet.pageSetup.paperSize, 9);
      assert.match(String(worksheet.pageSetup.printTitlesRow), /^(\d+):\1$/);
    }
  });
  await test("XLSX balance sheet: opening and closing columns match independent amounts", async () => {
    const file = await office(s, "balance-sheet", "2026-01", "xlsx");
    const worksheet = (await loadWorkbook(file.body)).worksheets[0];
    const assetRow = findRow(worksheet, "资产总计");
    cellNumber(worksheet, assetRow, 2, 2640, "资产负债表期初资产总计");
    cellNumber(worksheet, assetRow, 3, 2890, "资产负债表期末资产总计");
    const row = findRow(worksheet, "固定资产原价");
    cellNumber(worksheet, row, 2, 1200, "固定资产原价期初");
    cellNumber(worksheet, row, 3, 1380, "固定资产原价期末");
    assert.equal(findRow(worksheet, "期末：资产 = 负债 + 所有者权益") > 0, true);
    const balanced = worksheet.getRow(findRow(worksheet, "期末：资产 = 负债 + 所有者权益")).getCell(2).value;
    assert.equal(balanced, "是");
    assert.equal(worksheet.pageSetup.orientation, "portrait");
  });
  await test("XLSX income statement and cash flow expose current/YTD columns and the indirect-method limit", async () => {
    const income = (await loadWorkbook((await office(s, "income-statement", "2026-02", "xlsx")).body)).worksheets[0];
    const net = findRow(income, "净利润");
    cellNumber(income, net, 2, 180, "利润表本期净利润");
    cellNumber(income, net, 3, 430, "利润表本年累计净利润");
    assert.equal(income.getRow(net).getCell(2).font.bold, true);
    assert.ok(findRow(income, "营业外收入") > 0, "the persisted profile's separate income row must remain visible");
    assert.equal(findRow(income, "其他收入（已并入营业收入）"), 0, "new profiles must not claim legacy folding");
    assert.ok(String(income.getRow(1 + 1).getCell(1).value).includes("2026-02"));
    const cash = (await loadWorkbook((await office(s, "cash-flow-statement", "2026-02", "xlsx")).body)).worksheets[0];
    const increase = findRow(cash, "现金净增加额");
    cellNumber(cash, increase, 3, 180, "现金流本期净增加额");
    cellNumber(cash, increase, 4, 530, "现金流已分类本年累计净增加额");
    cellNumber(cash, findRow(cash, "现金余额变动"), 4, 230, "独立现金余额本年变动，含未分类复合采购支出300");
    assert.equal(dto(s, "cash-flow-statement", "2026-02").reportStatus.partialValues, true);
    const indirect = findRow(cash, "间接法独立勾稽");
    assert.equal(cash.getRow(indirect).getCell(3).value, "否（末行复用直接法经营活动净额）");
    let indirectCheckRow = 0;
    cash.eachRow((row, rowNumber) => {
      if (row.getCell(1).value === "间接法独立勾稽" && String(row.getCell(3).value).includes("不是独立勾稽")) indirectCheckRow = rowNumber;
    });
    assert.ok(indirectCheckRow > 0, "checks section must state that indirect cash flow is not independent");
    assert.equal(cash.getRow(indirectCheckRow).getCell(2).value, "否");
    const texts = [];
    cash.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "string") texts.push(cell.value); }));
    assert.ok(texts.some((text) => text.includes("复合或未知分类明确列为部分金额")), "classification limitation must stay visible");
  });
  await test("XLSX trial balance: eleven columns, own-account amounts, totals and checks", async () => {
    const file = await office(s, "trial-balance", "2026-02", "xlsx");
    const worksheet = (await loadWorkbook(file.body)).worksheets[0];
    assert.equal(worksheet.pageSetup.orientation, "landscape");
    const headerRow = findRow(worksheet, "科目编码");
    assert.ok(headerRow > 0);
    const headers = worksheet.getRow(headerRow).values.slice(1, 12);
    assert.deepEqual(headers, ["科目编码", "科目名称", "方向", "期初借方", "期初贷方", "本期借方", "本期贷方", "本年借方", "本年贷方", "期末借方", "期末贷方"]);
    const child = findRow(worksheet, "100201");
    const amounts = [4, 5, 6, 7, 8, 9, 10, 11].map((column) => worksheet.getRow(child).getCell(column).value);
    assert.deepEqual(amounts, [600, 0, 200, 0, 600, 0, 800, 0]);
    assert.equal(worksheet.getRow(child).getCell(3).value, "借");
    const total = findRow(worksheet, "合计");
    assert.ok(total > 0);
    assert.equal(worksheet.getRow(total).getCell(2).value, "不含父级重复汇总");
    assert.equal(worksheet.getRow(total).getCell(8).value, 1070);
    assert.equal(worksheet.getRow(total).getCell(9).value, 1070);
    const check = findRow(worksheet, "期末");
    assert.equal(worksheet.getRow(check).getCell(5).value, "是");
  });
  await test("XLSX ledger: summary, provenance columns and item rows use the same DTO", async () => {
    const file = await office(s, "ledger", "2026-02", "xlsx", { code: "1002" });
    const worksheet = (await loadWorkbook(file.body)).worksheets[0];
    const opening = findRow(worksheet, "期间期初");
    cellNumber(worksheet, opening, 2, 1490, "明细账期初借方");
    const current = findRow(worksheet, "本期发生");
    cellNumber(worksheet, current, 2, 200, "明细账本期借方");
    cellNumber(worksheet, current, 3, 20, "明细账本期贷方");
    const closing = findRow(worksheet, "期末余额");
    cellNumber(worksheet, closing, 2, 1670, "明细账期末借方");
    const itemHeader = findRow(worksheet, "日期");
    assert.ok(itemHeader > 0);
    const header = worksheet.getRow(itemHeader).values.slice(1, 12);
    assert.deepEqual(header, ["日期", "凭证字", "凭证号", "凭证ID", "分录ID", "科目编码", "科目名称", "摘要", "借方", "贷方", "余额（借减贷）"]);
    assert.equal(worksheet.views[0].ySplit, itemHeader, "detail header must be the frozen row");
    assert.equal(worksheet.pageSetup.printTitlesRow, `${itemHeader}:${itemHeader}`);
    assert.equal(worksheet.pageSetup.orientation, "landscape");
    const firstItem = worksheet.getRow(itemHeader + 1);
    assert.equal(firstItem.getCell(6).value, "100201");
    assert.ok(Number(firstItem.getCell(4).value) > 0);
    assert.ok(Number(firstItem.getCell(5).value) > 0);
    cellNumber(worksheet, itemHeader + 1, 9, 200, "明细账第一笔借方");
    assert.equal(worksheet.getRow(itemHeader + 2).getCell(6).value, "1002");
    cellNumber(worksheet, itemHeader + 2, 10, 20, "明细账第二笔贷方");
    cellNumber(worksheet, itemHeader + 2, 11, 1670, "明细账第二笔余额");
    const ledgerTexts = [];
    worksheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "string") ledgerTexts.push(cell.value); }));
    assert.ok(ledgerTexts.some((text) => text.includes("负数表示贷方余额")), "ledger must keep the debit-credit balance meaning note");
    const report = dto(s, "ledger", "2026-02", { code: "1002" });
    assert.equal(report.data.items.length, 2);
  });
  await test("XLSX: untrusted names and summaries stay text, never formulas", async () => {
    const injected = make('=SUM(1,2)', "2026-01");
    A.addAccount(injected, { code: "100201", name: "@危险科目", category: "资产", direction: "debit" });
    const samples = ["=1+1", "+SUM(1,2)", "-1+2", "@SUM(1,2)", "=HYPERLINK(\"http://example.invalid\")"];
    for (const summary of samples) voucher(injected, "2026-01", [e("100201", 1, 0, summary), e("3001", 0, 1)]);
    const file = await office(injected, "ledger", "2026-01", "xlsx", { code: "100201" });
    save(file.filename, file.body);
    const worksheet = (await loadWorkbook(file.body)).worksheets[0];
    const accountSetRow = findRow(worksheet, "账套名称");
    assertTextCell(worksheet, accountSetRow, 2, "=SUM(1,2)", "账套名称");
    const itemHeader = findRow(worksheet, "日期");
    let formulas = 0;
    const found = [];
    worksheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula || cell.formula) formulas++;
      if (typeof cell.value === "string") found.push(cell.value);
    }));
    assert.equal(formulas, 0, "no cell may be written as a formula");
    for (const sample of samples) assert.ok(found.includes(sample), `summary text preserved: ${JSON.stringify(sample)}`);
    assert.ok(found.includes("@危险科目"));
    const summaryCell = worksheet.getRow(itemHeader + 1).getCell(8);
    assert.equal(summaryCell.value, samples[0]);
    assert.notEqual(summaryCell.type, ExcelJS.ValueType.Formula);
    assert.equal(summaryCell.numFmt, "@");
  });
  await test("XLSX: draft and unposted vouchers never reach exported amounts", async () => {
    const before = await office(s, "balance-sheet", "2026-02", "xlsx");
    voucher(s, "2026-02", [e("1002", 8888), e("5001", 0, 8888)], { status: "draft" });
    const unposted = voucher(s, "2026-02", [e("1002", 7777), e("5001", 0, 7777)]);
    A.unpostVoucher(s, unposted.id);
    const after = await office(s, "balance-sheet", "2026-02", "xlsx");
    const worksheet = (await loadWorkbook(after.body)).worksheets[0];
    cellNumber(worksheet, findRow(worksheet, "货币资金"), 3, 1670, "草稿与反过账不入表");
    assert.deepEqual(after.report.data.assets, before.report.data.assets);
  });
  await test("XLSX: Excel 32767-character single-cell limit is enforced with stable field errors", async () => {
    const limitSet = make("单格长度边界合成账套", "2026-04");
    A.addAccount(limitSet, { code: "100201", name: "边界科目", category: "资产", direction: "debit" });
    const boundary = "边".repeat(32767);
    voucher(limitSet, "2026-04", [e("100201", 1, 0, boundary), e("5001", 0, 1)]);
    const file = await office(limitSet, "ledger", "2026-04", "xlsx", { code: "100201" });
    const worksheet = (await loadWorkbook(file.body)).worksheets[0];
    const itemHeader = findRow(worksheet, "日期");
    const summaryCell = worksheet.getRow(itemHeader + 1).getCell(8);
    assert.equal(summaryCell.value, boundary, "exactly 32767 characters must be stored without truncation");
    assert.equal(summaryCell.value.length, 32767);
    assert.equal(summaryCell.numFmt, "@");
    let itemRows = 0;
    let sameSummaryRows = 0;
    let oneAmounts = 0;
    worksheet.eachRow((row) => {
      if (row.getCell(6).value === "100201") itemRows++;
      if (row.getCell(8).value === boundary) sameSummaryRows++;
      row.eachCell((cell) => {
        if (typeof cell.value === "string") assert.ok(cell.value.length <= 32767, "every final text cell must fit the Excel limit");
        if (cell.value === 1) oneAmounts++;
      });
    });
    assert.equal(itemRows, 1, "one DTO item stays one row; no continuation row may duplicate it");
    assert.equal(sameSummaryRows, 1, "the boundary summary must exist in exactly one cell");
    assert.equal(oneAmounts, 5, "continuation rows must not duplicate ledger amounts");

    for (const [summary, length] of [["格".repeat(32768), 32768], ["长".repeat(40000), 40000]]) {
      const code = length === 32768 ? "100202" : "100203";
      A.addAccount(limitSet, { code, name: `超限科目${length}`, category: "资产", direction: "debit" });
      voucher(limitSet, "2026-04", [e(code, 1, 0, summary), e("5001", 0, 1)]);
      for (const format of ["xlsx", "pdf"]) {
        await assert.rejects(() => office(limitSet, "ledger", "2026-04", format, { code }), (error) => {
          assert.equal(error.code, "office_text_too_long");
          assert.match(String(error.details.field), /^sections\[\d+\]\.rows\[\d+\]\.cells\[\d+\]$/);
          assert.equal(error.details.column, "摘要");
          assert.equal(error.details.limit, 32767);
          assert.equal(error.details.length, length);
          assert.ok(!error.message.includes(summary.slice(0, 8)), "the error must not echo the original field text");
          return true;
        });
      }
    }

    const overName = make("超长名称".repeat(10000), "2026-01");
    for (const format of ["xlsx", "pdf"]) {
      await assert.rejects(() => office(overName, "balance-sheet", "2026-01", format), (error) => {
        assert.equal(error.code, "office_text_too_long");
        assert.equal(error.details.field, "accountSet.name");
        assert.equal(error.details.length, 40000);
        assert.equal(error.details.limit, 32767);
        assert.ok(!error.message.includes("超长名称"), "the error must not echo the account name");
        return true;
      });
    }
    A.addAccount(limitSet, { code: "100204", name: "科".repeat(40000), category: "资产", direction: "debit" });
    await assert.rejects(() => office(limitSet, "ledger", "2026-04", "pdf", { code: "100204" }), (error) => {
      assert.equal(error.code, "office_text_too_long");
      assert.match(String(error.details.field), /^meta\[\d+\]\.value$/);
      assert.equal(error.details.length, 40007);
      assert.equal(error.details.limit, 32767);
      assert.ok(!error.message.includes("科".repeat(8)), "the error must not echo the account name");
      return true;
    });
  });
  await test("XLSX: document model is built from the same DTO without recalculating", async () => {
    for (const [kind, period, extra] of [
      ["balance-sheet", "2026-01", {}],
      ["income-statement", "2026-02", {}],
      ["cash-flow-statement", "2026-02", {}],
      ["trial-balance", "2026-02", {}],
      ["ledger", "2026-02", { code: "1002" }],
    ]) {
      const report = dto(s, kind, period, extra);
      const model = buildReportDocument(report);
      assert.equal(model.dto, report);
      assert.equal(model.period, report.period);
      assert.equal(model.accountSetName, report.accountSet.name);
      assert.equal(model.warnings.length, report.warnings.length);
      if (kind === "trial-balance") assert.equal(model.sections[0].rows.length, report.data.lines.length + 1);
      if (kind === "ledger") assert.equal(model.sections[1].rows.length, report.data.items.length);
      if (kind === "balance-sheet") assert.equal(model.sections[0].rows.length, report.data.assets.length);
    }
  });

  // ---------------------------------------------------------------- PDF structure and text
  await test("PDF: five report kinds are real A4 PDFs with embedded Chinese font and extractable text", async () => {
    const kinds = ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"];
    const titles = { "balance-sheet": "资产负债表", "income-statement": "利润表", "cash-flow-statement": "现金流量表", "trial-balance": "科目余额表", ledger: "明细账" };
    for (const kind of kinds) {
      const period = kind === "balance-sheet" ? "2026-01" : "2026-02";
      const extra = kind === "ledger" ? { code: "1002" } : {};
      const file = await office(s, kind, period, "pdf", extra);
      assert.equal(file.contentType, "application/pdf");
      assert.match(file.filename, new RegExp(`\\.pdf$`));
      assert.ok(Buffer.isBuffer(file.body));
      assert.equal(file.body.subarray(0, 5).toString(), "%PDF-");
      save(file.filename, file.body);
      const pdf = extractPdf(file.body);
      assert.ok(pdf.pageCount >= 1, "PDF must contain at least one page");
      assert.equal(pdf.pageCount, file.pageCount);
      assert.equal(pdf.embeddedFont, true, "Chinese font must be embedded as a font file");
      assert.equal(pdf.hasStandardFont, false, "PDF must not fall back to unembedded Helvetica");
      const squash = pdf.squash;
      assert.ok(squash.includes(titles[kind]), `PDF must contain the Chinese title ${titles[kind]}`);
      assert.ok(squash.includes("人民币元"));
      assert.ok(squash.includes("内部报表"));
      assert.ok(squash.includes("未核实"), "completeness must stay explicitly unverified");
      assert.ok(squash.includes("不是税局申报文件") || squash.includes("非税局申报文件"));
      for (let index = 1; index <= pdf.pageCount; index++) {
        assert.ok(pdf.pages[index - 1].replace(/\s+/g, "").includes(`第${index}页/共${pdf.pageCount}页`), `page ${index} footer missing`);
      }
      if (kind === "balance-sheet") {
        assert.ok(squash.includes("1,440.00") && squash.includes("1,490.00") && squash.includes("2,890.00"));
        assert.ok(pdf.width < pdf.height, "three-column balance sheet should be portrait");
      }
      if (kind === "income-statement") assert.ok(squash.includes("180.00") && squash.includes("430.00"));
      if (kind === "cash-flow-statement") {
        assert.ok(squash.includes("现金净增加额") && squash.includes("180.00") && squash.includes("230.00"));
        assert.ok(squash.includes("间接法补充资料") && squash.includes("不是独立勾稽"));
      }
      if (kind === "trial-balance") {
        assert.ok(squash.includes("100201") && squash.includes("期初借方") && squash.includes("期末贷方"));
        assert.ok(pdf.width > pdf.height, "eleven-column trial balance should be landscape");
      }
      if (kind === "ledger") {
        assert.ok(squash.includes("余额（借减贷）") && squash.includes("1,670.00"));
        assert.ok(squash.includes("负数表示贷方余额"), "ledger PDF must keep the balance meaning note");
        assert.ok(pdf.width > pdf.height, "ledger detail should be landscape");
      }
    }
  });
  await test("PDF: long Chinese names and 230 detail rows paginate with repeated headers and no lost text", async () => {
    const longSet = make("超长合成企业名称用于版式检查（含中文括号与数字1234567890）有限公司", "2026-03");
    A.addAccount(longSet, { code: "100201", name: "银行存款下设明细科目名称非常长用于验证换行与列宽是否足够", category: "资产", direction: "debit" });
    const summaries = [];
    for (let index = 1; index <= 230; index++) {
      const summary = `第${String(index).padStart(3, "0")}笔长摘要：客户名称与业务说明用于验证中文自动换行、分页重复表头且不裁切任何内容`;
      summaries.push(summary);
      voucher(longSet, "2026-03", [e("100201", 1, 0, summary), e("5001", 0, 1)]);
    }
    const file = await office(longSet, "ledger", "2026-03", "pdf", { code: "1002" });
    save(file.filename, file.body);
    const pdf = extractPdf(file.body);
    assert.ok(file.pageCount >= 3, `expected several pages, got ${file.pageCount}`);
    assert.equal(pdf.pageCount, file.pageCount);
    assert.ok(pdf.width > pdf.height);
    const squash = pdf.squash;
    for (let index = 0; index < summaries.length; index++) {
      const marker = `第${String(index + 1).padStart(3, "0")}笔长摘要`;
      assert.ok(squash.includes(marker), `missing summary ${marker}; content must not be truncated`);
    }
    assert.ok(squash.includes("超长合成企业名称用于版式检查"));
    assert.ok(squash.includes("银行存款下设明细科目名称非常长"));
    assert.ok(squash.includes("230.00"), "ledger closing balance must be visible");
    for (let index = 0; index < pdf.pageCount; index++) {
      const page = pdf.pages[index].replace(/\s+/g, "");
      assert.ok(page.includes("余额（借减贷）"), `page ${index + 1} must repeat the detail header`);
      assert.ok(page.includes("日期") && page.includes("摘要"));
      assert.ok(page.includes(`第${index + 1}页/共${pdf.pageCount}页`));
    }
    artifacts.push({ longLedger: file.filename, pages: pdf.pageCount });
  });
  await test("PDF: oversized metadata/name fields paginate inside the page or fail with a stable field error", async () => {
    const repeated = "超长名称".repeat(1000);
    const longSet = make(repeated, "2026-01");
    const file = await office(longSet, "balance-sheet", "2026-01", "pdf");
    save("qa-long-name-balance-sheet.pdf", file.body);
    const pdf = extractPdf(file.body);
    assert.ok(pdf.pageCount >= 3, `an oversized subtitle/meta value must continue on later pages, got ${pdf.pageCount}`);
    assert.equal(pdf.pageCount, file.pageCount);
    assert.ok((pdf.squash.match(/超长名称/g) || []).length >= 1000, "all repeated name characters must be rendered");
    for (let index = 1; index <= pdf.pageCount; index++) {
      assert.ok(pdf.pages[index - 1].replace(/\s+/g, "").includes(`第${index}页/共${pdf.pageCount}页`), `page ${index} footer missing`);
    }
    const xlsx = await office(longSet, "balance-sheet", "2026-01", "xlsx");
    const sheet = (await loadWorkbook(xlsx.body)).worksheets[0];
    assert.equal(sheet.getRow(findRow(sheet, "账套名称")).getCell(2).value, repeated, "XLSX must keep the long name in one valid cell");

    const ascii = "A".repeat(3000);
    const asciiSet = make(ascii, "2026-01");
    const asciiFile = await office(asciiSet, "trial-balance", "2026-01", "pdf");
    save("qa-long-ascii-name-trial-balance.pdf", asciiFile.body);
    const asciiPdf = extractPdf(asciiFile.body);
    assert.ok(asciiPdf.pageCount >= 2, "a single unbroken token must hard-wrap onto later pages");
    assert.ok((asciiPdf.squash.match(/A/g) || []).length >= 3000, "the unbroken token must not be clipped");

    const ledgerName = "科".repeat(4000);
    const ledgerSet = make("长科目名元数据账套", "2026-01");
    A.addAccount(ledgerSet, { code: "100209", name: ledgerName, category: "资产", direction: "debit" });
    const ledgerFile = await office(ledgerSet, "ledger", "2026-01", "pdf", { code: "100209" });
    save("qa-long-account-name-ledger.pdf", ledgerFile.body);
    const ledgerPdf = extractPdf(ledgerFile.body);
    assert.ok((ledgerPdf.squash.match(/科/g) || []).length >= 4000, "the long ledger account name must not be truncated");
    for (let index = 1; index <= ledgerPdf.pageCount; index++) {
      assert.ok(ledgerPdf.pages[index - 1].replace(/\s+/g, "").includes(`第${index}页/共${ledgerPdf.pageCount}页`), `long account name page ${index} footer missing`);
    }
  });
  await test("PDF/XLSX: an oversized single summary splits across pages without dropping text", async () => {
    const giantSet = make("超长单行摘要合成账套", "2026-03");
    A.addAccount(giantSet, { code: "100201", name: "超长摘要科目", category: "资产", direction: "debit" });
    const giant = `前段标记${"长".repeat(1000)}中段标记${"文".repeat(1000)}后段结束标记`;
    voucher(giantSet, "2026-03", [e("100201", 1, 0, giant), e("5001", 0, 1)]);
    const pdfFile = await office(giantSet, "ledger", "2026-03", "pdf", { code: "100201" });
    save(pdfFile.filename, pdfFile.body);
    const pdf = extractPdf(pdfFile.body);
    assert.ok(pdf.pageCount >= 2, "an oversized row must continue on later pages");
    assert.equal(pdf.pageCount, pdfFile.pageCount);
    const squash = pdf.squash;
    assert.ok(squash.includes("前段标记") && squash.includes("中段标记") && squash.includes("后段结束标记"), "all parts of the split summary must remain extractable");
    assert.ok((squash.match(/长/g) || []).length >= 1000, "the long run of characters must not be truncated");
    assert.ok((squash.match(/文/g) || []).length >= 1000);
    for (let index = 1; index < pdf.pageCount; index++) {
      assert.ok(pdf.pages[index].replace(/\s+/g, "").includes("余额（借减贷）"), `page ${index + 1} must stay a detail page; notes must not create an orphan page`);
    }
    const xlsxFile = await office(giantSet, "ledger", "2026-03", "xlsx", { code: "100201" });
    const worksheet = (await loadWorkbook(xlsxFile.body)).worksheets[0];
    const itemHeader = findRow(worksheet, "日期");
    assert.equal(worksheet.getRow(itemHeader + 1).getCell(8).value, giant, "XLSX must store the full summary text");
    let itemRows = 0;
    worksheet.eachRow((row) => { if (row.getCell(6).value === "100201") itemRows++; });
    assert.equal(itemRows, 1, "the long summary must not create merged/continuation item rows");
    artifacts.push({ giantLedger: pdfFile.filename, pages: pdf.pageCount });
  });
  await test("PDF: missing or unusable fonts fail explicitly instead of drawing boxed text", async () => {
    const previous = process.env.REPORT_PDF_FONT;
    const previousFamily = process.env.REPORT_PDF_FONT_FAMILY;
    try {
      process.env.REPORT_PDF_FONT = join(dataDir, "does-not-exist.ttf");
      await assert.rejects(() => office(s, "trial-balance", "2026-02", "pdf"), (error) => error.code === "pdf_font_unavailable");
      process.env.REPORT_PDF_FONT = join(process.cwd(), "package.json");
      await assert.rejects(() => office(s, "trial-balance", "2026-02", "pdf"), (error) => error.code === "pdf_font_unavailable");
    } finally {
      if (previous === undefined) delete process.env.REPORT_PDF_FONT;
      else process.env.REPORT_PDF_FONT = previous;
      if (previousFamily === undefined) delete process.env.REPORT_PDF_FONT_FAMILY;
      else process.env.REPORT_PDF_FONT_FAMILY = previousFamily;
    }
    const rare = make("含缺字𠀀的合成账套", "2026-01");
    await assert.rejects(() => office(rare, "balance-sheet", "2026-01", "pdf"), (error) => error.code === "pdf_font_glyph_missing");
  });
  await test("PDF: cash-flow keeps unique content per page and does not duplicate end notes", async () => {
    const file = await office(s, "cash-flow-statement", "2026-02", "pdf");
    save("qa-cash-flow-notes.pdf", file.body);
    const pdf = extractPdf(file.body);
    assert.equal((pdf.squash.match(/复合或未知分类明确列为部分金额/g) || []).length, 1, "the classification limitation must appear once, not be duplicated as an end note");
    for (let index = 0; index < pdf.pageCount; index++) {
      const page = pdf.pages[index].replace(/\s+/g, "");
      assert.ok(page.includes("项目") || page.includes("检查项"), `cash-flow page ${index + 1} must carry a table header`);
      assert.match(page, /\d+\.\d{2}/, `cash-flow page ${index + 1} must not be a notes-only page`);
      assert.ok(page.includes(`第${index + 1}页/共${pdf.pageCount}页`));
    }
    const xlsx = await office(s, "cash-flow-statement", "2026-02", "xlsx");
    const sheet = (await loadWorkbook(xlsx.body)).worksheets[0];
    const allocationRows = new Set();
    sheet.eachRow((row, rowNumber) => {
      if (String(row.getCell(2).value ?? "").includes("复合或未知分类明确列为部分金额")) allocationRows.add(rowNumber);
    });
    assert.equal(allocationRows.size, 1, "the cash-flow XLSX must state the allocation limit once");
  });
  await test("empty account sets keep the empty-book limitation in both formats", async () => {
    const empty = make("空账合成账套", "2026-01");
    const xlsx = await office(empty, "trial-balance", "2026-01", "xlsx");
    const sheet = (await loadWorkbook(xlsx.body)).worksheets[0];
    const texts = [];
    sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "string") texts.push(cell.value); }));
    assert.ok(texts.some((text) => text.includes("空账")), "empty-book warning must stay in XLSX");
    const pdf = extractPdf((await office(empty, "trial-balance", "2026-01", "pdf")).body);
    assert.ok(pdf.squash.includes("空账"), "empty-book warning must stay in PDF");
    const ledgerPdf = extractPdf((await office(empty, "ledger", "2026-01", "pdf", { code: "1002" })).body);
    assert.ok(ledgerPdf.squash.includes("负数表示贷方余额"), "ledger balance meaning must stay for an empty ledger");
    for (let index = 0; index < ledgerPdf.pageCount; index++) {
      const page = ledgerPdf.pages[index].replace(/\s+/g, "");
      assert.ok(page.includes("逐笔明细") || page.includes("余额（借减贷）"), `empty-ledger page ${index + 1} must not be a notes-only page`);
    }
  });
  await test("invalid office requests fail with stable codes and never register periods", async () => {
    const before = A.listPeriods(s);
    await assert.rejects(() => office(s, "trial-balance", "2026-02", "docx"), (error) => error.code === "report_format_unsupported");
    await assert.rejects(() => buildOfficeExport(s, null), (error) => error.code === "report_options_invalid");
    await assert.rejects(() => office(s, "unknown", "2026-02", "xlsx"), (error) => error.code === "report_kind_unsupported");
    await assert.rejects(() => office(s, "trial-balance", "2026-04", "pdf"), (error) => error.code === "period_not_registered");
    await assert.rejects(() => office(s, "ledger", "2026-02", "xlsx"), (error) => error.code === "account_code_required");
    await assert.rejects(() => office(999999, "trial-balance", "2026-02", "pdf"), (error) => error.code === "account_set_not_found");
    assert.deepEqual(A.listPeriods(s), before);
  });

  // ---------------------------------------------------------------- import-side-effect isolation
  await test("pure DTO rendering never opens or creates a database in an isolated data dir", async () => {
    // A separate Node process is required: this test file already imported db.mjs above, so any
    // in-process check would be masked by the module cache and by the already-open temporary DB.
    const isolationRoot = join(tmpdir(), `wb-office-isolation-${process.pid}-${Date.now()}`);
    const isolationDataDir = join(isolationRoot, "data");
    const dtoTmpDir = mkdtempSync(join(tmpdir(), 'wb-office-dto-'));
    const dtoPath = join(dtoTmpDir, "synthetic-report-dto.json");
    const moduleUrl = pathToFileURL(join(process.cwd(), "server", "report-office-export.mjs")).href;
    const defaultDataDir = join(process.cwd(), "data");
    const defaultDataDirExisted = existsSync(defaultDataDir);
    assert.equal(existsSync(isolationRoot), false, "the isolated data dir must not exist before the child starts");
    // Reuse the same synthetic DTO the exporter consumes: no real book, only the stable schema.
    writeFileSync(dtoPath, JSON.stringify(dto(s, "balance-sheet", "2026-01")), "utf8");
    const script = [
      `import { existsSync, readFileSync } from "node:fs";`,
      `const root = ${JSON.stringify(isolationRoot)};`,
      `const dataDir = ${JSON.stringify(isolationDataDir)};`,
      `const moduleUrl = ${JSON.stringify(moduleUrl)};`,
      `const dtoPath = ${JSON.stringify(dtoPath)};`,
      `const bail = (code) => { console.error(code); process.exit(2); };`,
      `if (process.env.WORKBENCH_DATA_DIR !== dataDir) bail("data_dir_env_not_applied");`,
      `if (existsSync(root) || existsSync(dataDir)) bail("isolation_root_pre_exists");`,
      // Importing the renderer alone must not touch the filesystem or the database module.
      `const mod = await import(moduleUrl);`,
      `if (existsSync(root) || existsSync(dataDir)) bail("import_created_data_dir");`,
      `const report = JSON.parse(readFileSync(dtoPath, "utf8"));`,
      `const document = mod.buildReportDocument(report);`,
      `if (document.sections.length < 2 || document.sections[0].rows.length < 1) bail("document_model_empty");`,
      `const xlsx = await mod.buildReportXlsx(report, document);`,
      `if (Buffer.from(xlsx.subarray(0, 2)).toString("latin1") !== "PK") bail("xlsx_not_zip");`,
      `const pdf = await mod.buildReportPdf(report, document);`,
      `if (Buffer.from(pdf.buffer.subarray(0, 5)).toString("latin1") !== "%PDF-") bail("pdf_not_pdf");`,
      `if (!(pdf.pageCount >= 1)) bail("pdf_page_count");`,
      `if (existsSync(root) || existsSync(dataDir)) bail("render_created_data_dir");`,
      `if (existsSync(dataDir + "/workbench.db") || existsSync(dataDir + "/workbench.db-wal") || existsSync(dataDir + "/workbench.db-shm")) bail("sqlite_files_created");`,
      `process.stdout.write(JSON.stringify({ ok: true, xlsxBytes: xlsx.length, pdfBytes: pdf.buffer.length, pdfPages: pdf.pageCount, rows: document.sections[0].rows.length }));`,
    ].join("\n");
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, WORKBENCH_DATA_DIR: isolationDataDir },
        encoding: "utf8",
        timeout: 180000,
      });
      assert.equal(child.status, 0, `isolated render child failed (status ${child.status}): ${child.stderr || child.stdout}`);
      const summary = JSON.parse(child.stdout.trim());
      assert.equal(summary.ok, true, "the isolated child must report a completed pure render");
      assert.ok(summary.rows >= 1, "the child must render real document rows from the DTO");
      assert.ok(summary.xlsxBytes > 1000, "the isolated child must produce a real XLSX buffer");
      assert.ok(summary.pdfBytes > 1000 && summary.pdfPages >= 1, "the isolated child must produce a real PDF buffer");
    } finally {
      rmSync(dtoTmpDir, { recursive: true, force: true });
      rmSync(isolationRoot, { recursive: true, force: true });
    }
    assert.equal(existsSync(isolationRoot), false, "pure DTO rendering must not create WORKBENCH_DATA_DIR or its parent");
    assert.equal(existsSync(defaultDataDir), defaultDataDirExisted, "pure DTO rendering must not fall back to the default 06-workbench/data directory");
  });

  // ---------------------------------------------------------------- independent external PDF QA
  await test("external poppler PDF QA: page count matches and pages render to non-empty PNGs", async () => {
    if (!toolAvailable("pdfinfo") || !toolAvailable("pdftoppm")) {
      console.log("    SKIP poppler not found on PATH; internal structural/text checks above still ran");
      return;
    }
    const pdfs = artifacts.filter((item) => typeof item === "string" && item.endsWith(".pdf"));
    assert.ok(pdfs.length >= 5, "expected saved PDF artifacts");
    for (const path of pdfs) {
      const info = spawnSync("pdfinfo", [path], { encoding: "utf8", timeout: 30000 });
      assert.equal(info.status, 0, info.stderr);
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] || 0);
      assert.ok(pages >= 1);
    }
    const longPdf = artifacts.find((item) => typeof item === "object" && item.longLedger);
    const giantPdf = artifacts.find((item) => typeof item === "object" && item.giantLedger);
    assert.ok(longPdf);
    assert.ok(giantPdf);
    const longPath = join(qaDir, longPdf.longLedger);
    const renders = [
      [join(qaDir, "balance-sheet-1-2026-01.pdf"), "qa-balance-sheet", "1", "1"],
      [join(qaDir, "trial-balance-1-2026-02.pdf"), "qa-trial-balance", "1", "1"],
      [longPath, "qa-ledger-first", "1", "2"],
      [longPath, "qa-ledger-last", String(longPdf.pages - 1), String(longPdf.pages)],
      [join(qaDir, "qa-cash-flow-notes.pdf"), "qa-cash-flow-notes", "1", "1"],
      [join(qaDir, "qa-long-name-balance-sheet.pdf"), "qa-long-name", "1", "5"],
      [join(qaDir, "qa-long-ascii-name-trial-balance.pdf"), "qa-long-ascii", "1", "1"],
      [join(qaDir, "qa-long-account-name-ledger.pdf"), "qa-long-account-name", "1", "3"],
      [join(qaDir, giantPdf.giantLedger), "qa-giant-summary", String(giantPdf.pages - 1), String(giantPdf.pages)],
    ];
    for (const [path, prefix, first, last] of renders) {
      assert.ok(existsSync(path), `missing artifact ${path}`);
      const expectedPages = Number(last) - Number(first) + 1;
      for (const name of readdirSync(qaDir)) {
        if (name.startsWith(prefix) && name.endsWith(".png")) rmSync(join(qaDir, name), { force: true });
      }
      const rendered = spawnSync("pdftoppm", ["-f", first, "-l", last, "-r", "110", "-png", path, join(qaDir, prefix)], { encoding: "utf8", timeout: 120000 });
      assert.equal(rendered.status, 0, rendered.stderr);
      const produced = readdirSync(qaDir).filter((name) => name.startsWith(prefix) && name.endsWith(".png"));
      assert.ok(produced.length >= expectedPages, `pdftoppm produced ${produced.length}/${expectedPages} pages for ${prefix}`);
      for (const name of produced) {
        const bytes = readFileSync(join(qaDir, name));
        assert.equal(bytes.subarray(1, 4).toString(), "PNG");
        assert.ok(bytes.length > 10000, `rendered page ${name} must not be blank`);
        artifacts.push(join(qaDir, name));
      }
    }
    console.log(`    rendered PNG QA artifacts: ${renders.map(([, prefix]) => join(qaDir, `${prefix}*.png`)).join(", ")}`);
  });
  await test("optional pdfplumber geometry QA: no overlapping or out-of-page text", async () => {
    const python = process.env.REPORT_OFFICE_PYTHON;
    if (!python) {
      console.log("    SKIP REPORT_OFFICE_PYTHON not set; set it to an acceptance-only Python with pdfplumber to run geometry checks");
      return;
    }
    const pdfs = artifacts.filter((item) => typeof item === "string" && item.endsWith(".pdf"));
    const script = [
      "import json, sys, pdfplumber",
      "out = {}",
      "for path in sys.argv[1:]:",
      "    with pdfplumber.open(path) as pdf:",
      "        details = []",
      "        for index, page in enumerate(pdf.pages):",
      "            words = page.extract_words(use_text_flow=False, keep_blank_chars=False)",
      "            overlaps = 0",
      "            for i in range(len(words)):",
      "                a = words[i]",
      "                for j in range(i + 1, len(words)):",
      "                    b = words[j]",
      "                    if a['x0'] < b['x1'] - 0.6 and b['x0'] < a['x1'] - 0.6 and a['top'] < b['bottom'] - 0.6 and b['top'] < a['bottom'] - 0.6:",
      "                        overlaps += 1",
      "            outside = sum(1 for w in words if w['x0'] < 0 or w['x1'] > page.width + 0.5 or w['top'] < 0 or w['bottom'] > page.height + 0.5)",
      "            details.append({'page': index + 1, 'words': len(words), 'overlaps': overlaps, 'outside': outside, 'text': (page.extract_text() or '')[:40]})",
      "        out[path] = {'pages': len(pdf.pages), 'width': pdf.pages[0].width, 'height': pdf.pages[0].height, 'details': details}",
      "print(json.dumps(out))",
    ].join("\n");
    const result = spawnSync(python, ["-c", script, ...pdfs], { encoding: "utf8", timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const geometry = JSON.parse(result.stdout);
    for (const [path, info] of Object.entries(geometry)) {
      assert.ok(info.pages >= 1, `${path} pages`);
      for (const page of info.details) {
        assert.ok(page.words > 0, `${path} page ${page.page} has no text`);
        assert.equal(page.overlaps, 0, `${path} page ${page.page} has overlapping text`);
        assert.equal(page.outside, 0, `${path} page ${page.page} draws text outside the page`);
      }
    }
    console.log(`    pdfplumber geometry verified for ${Object.keys(geometry).length} PDFs`);
  });
} finally {
  db?.close();
  if (results.every(Boolean)) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`Failed fixture retained: ${dataDir}`);
}
console.log(`\nOffice export acceptance: ${results.filter(Boolean).length}/${results.length} passed`);
console.log(`QA artifacts (gitignored): ${qaDir}`);
if (results.some((value) => !value)) process.exitCode = 1;
