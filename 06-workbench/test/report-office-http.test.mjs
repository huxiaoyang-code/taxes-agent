#!/usr/bin/env node
// 固定的合成测试身份，不依赖显示名及生产默认值。
let identityFixtureSequence = 0;
const identityFixture = () => ({ enterpriseKey: 'SYNTHETIC-report-office-http-test-mjs-' + (++identityFixtureSequence) });
const identityFixtureCreate = (A, options) => A.createAccountSet({ enterprise: identityFixture(), ...options });
// LOCAL-05 传输（Issue #45）：对内部 CSV / XLSX / PDF 下载执行真实 HTTP 黑盒验收。
// 本测试启动本包自身服务作为子进程，使用随机回环端口及
// 一次性 WORKBENCH_DATA_DIR。绝不连接旧后端、税务门户或真实账套。
// 下方每个预期金额均从合成凭证手算，不从
// 导出器回读；通过 HTTP 覆盖导出，不模拟 buildOfficeExport。
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import ExcelJS from "exceljs";

const tempRoot = realpathSync(tmpdir());
const directory = mkdtempSync(join(tempRoot, "wb-report-office-http-"));
// 向临时目录写入或从中删除任何内容前，先证明拥有该目录。
assert.equal(dirname(realpathSync(directory)), tempRoot, "test data dir must live directly in the OS temp root");
process.env.WORKBENCH_DATA_DIR = directory;
const { db } = await import("../server/db.mjs");
const A = await import("../server/accounting.mjs");

// --------------------------------------------------------------------------- 合成账簿
const set = identityFixtureCreate(A, { name: "合成接线测试公司", start_period: "2026-01" });
A.setOpeningBalances(set.id, [{ code: "1002", debit: 1000 }, { code: "3001", credit: 1000 }]);
const posted = (period, summary, entries) => A.createVoucher(set.id, { period, status: "posted", summary, entries });
posted("2026-01", "一月合成收入", [{ code: "1002", debit: 800 }, { code: "5001", credit: 800 }]);
posted("2026-01", "一月合成费用", [{ code: "5602", debit: 300 }, { code: "1002", credit: 300 }]);
// 草稿凭证不得进入任何导出，也不能静默变成零值行。
A.createVoucher(set.id, { period: "2026-01", status: "draft", summary: "未过账不应出现", entries: [
  { code: "1002", debit: 5000 }, { code: "5001", credit: 5000 },
] });
posted("2026-02", "二月合成收入", [{ code: "1002", debit: 400 }, { code: "5001", credit: 400 }]);
posted("2026-02", "二月合成费用", [{ code: "5602", debit: 100 }, { code: "1002", credit: 100 }]);
// 长度超过 Excel 单元格/PDF 单字段限制（32767），用于真实失败路径。
const longName = "超长名称".repeat(9000);
const longSet = identityFixtureCreate(A, { name: longName, start_period: "2026-01" });

// 为窄范围组合契约提供独立、明确的合成企业身份。
const composite = identityFixtureCreate(A, { name: "合成复合附件公司", start_period: "2025-11" });
A.setOpeningBalances(composite.id, [{ code: "1002", debit: 1000 }, { code: "3001", credit: 1000 }]);
for (const [period, entries] of [
  ["2025-11", [{ code: "1403", debit: 120 }, { code: "1601", debit: 180 }, { code: "1002", credit: 300 }]],
  ["2025-12", [{ code: "1002", debit: 50 }, { code: "1403", credit: 20 }, { code: "1601", credit: 30 }]],
  ["2026-01", [{ code: "1403", debit: 12.01 }, { code: "1601", debit: 18.02 }, { code: "1002", credit: 30.03 }]],
  ["2026-02", [{ code: "1604", debit: 10 }, { code: "1002", credit: 10 }]],
]) A.createVoucher(composite.id, { period, status: "posted", entries });

const precise = identityFixtureCreate(A, { name: "合成HTTP分精度", start_period: "2026-01" });
const preciseOpenings = [];
for (let i = 0; i < 1000; i++) {
  const code = "1002" + String(i + 1).padStart(4, "0");
  A.addAccount(precise.id, { code, name: "合成分精度" + i, category: "资产", direction: "debit" });
  preciseOpenings.push({ code, debit: i === 0 ? 900000000000.01 : 0.01 });
}
preciseOpenings.push({ code: "3001", credit: 900000000010 }); A.setOpeningBalances(precise.id, preciseOpenings);
const precisionBad = [];
for (const [a, b] of [[45035996273704.95, 45035996273704.96], [45035996273704.96, 45035996273704.96]]) {
  const bad = identityFixtureCreate(A, { name: "合成HTTP不可表示", start_period: "2026-01" }); precisionBad.push(bad.id);
  for (const [code, amount] of [["1001", a], ["1002", b]]) db.prepare("INSERT INTO opening_balances(account_set_id,code,debit,credit) VALUES(?,?,?,0)").run(bad.id, code, amount);
}

const extreme = identityFixtureCreate(A, { name: "合成HTTP合法极界", start_period: "2026-01" });
const extremeOpening = [];
for (let i = 0; i < 100; i++) {
  const amount = i === 0 ? 900719925474.99 : 900719925474.09;
  for (const [prefix, category, direction] of [["1002", "资产", "debit"], ["3001", "权益", "credit"]]) {
    const code = prefix + String(i + 1).padStart(4, "0");
    A.addAccount(extreme.id, { code, name: "合成HTTP边界" + code, category, direction }); extremeOpening.push({ code, [direction]: amount });
  }
}
A.setOpeningBalances(extreme.id, extremeOpening);

// 基于上方凭证的独立手算：
// 2026-01：银行 1000 + 800 - 300 = 1500；收入 800；费用 300；利润 500；现金变动 500。
// 2026-02：银行 1500 + 400 - 100 = 1800；收入 400（年累计 1200）；费用 100（年累计 400）；
// 利润 300（年累计 800）；现金变动 300（年累计 800）；现金 1500 -> 1800。
const EXPECTED = {
  jan: { bankClosing: 1500, revenue: 800, expense: 300, profit: 500, cashChange: 500, cashBegin: 1000, cashEnd: 1500 },
  feb: {
    bankOpening: 1500, bankClosing: 1800, bankPeriodDebit: 400, bankPeriodCredit: 100,
    bankYtdDebit: 1200, bankYtdCredit: 400, ledgerItems: 2,
    revenue: 400, revenueYtd: 1200, expense: 100, expenseYtd: 400, profit: 300, profitYtd: 800,
    cashChange: 300, cashChangeYtd: 800, cashBegin: 1500, cashEnd: 1800,
  },
};

const snapshot = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
  assert.match(name, /^[a-z_]+$/i);
  return [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()];
}));
const beforeReads = snapshot();

// --------------------------------------------------------------------------- 子进程服务
function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "../server/server.mjs")], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", WORKBENCH_DATA_DIR: directory, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => { child.once("close", resolve); child.once("error", resolve); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => finish(new Error(`Server startup timed out: ${stderr}`)), 20000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, +match[1]);
    });
  });
  return {
    child, exited, ready,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}
async function stopQuietly(server) {
  if (!server) return;
  try { await server.stop(); } catch { /* 已不存在；退出断言不依赖于此。 */ }
}

let server, fontServer, base;
const pdfDir = join(directory, "pdf-info");

before(async () => {
  mkdirSync(pdfDir, { recursive: true });
  server = startServer();
  base = `http://127.0.0.1:${await server.ready}`;
});

after(async () => {
  await stopQuietly(fontServer);
  await stopQuietly(server);
  try {
    assert.deepEqual(snapshot(), beforeReads, "Every successful/failed download must leave the database unchanged");
  } finally {
    db.close();
    const resolved = realpathSync(directory);
    assert.equal(dirname(resolved), tempRoot, "refuse to delete anything outside the OS temp root");
    console.log(`Synthetic Office HTTP fixture retained: ${resolved}`);
  }
});

// --------------------------------------------------------------------------- 辅助函数
const KINDS = ["balance-sheet", "income-statement", "cash-flow-statement", "trial-balance", "ledger"];
const FORMATS = {
  csv: {
    mime: /^text\/csv;\s*charset=utf-8$/i,
    extension: ".csv",
    magic: (bytes) => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
  },
  xlsx: {
    mime: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/i,
    extension: ".xlsx",
    magic: (bytes) => bytes.length > 4 && bytes.subarray(0, 2).toString("latin1") === "PK" && bytes[2] === 3 && bytes[3] === 4,
  },
  pdf: {
    mime: /^application\/pdf$/i,
    extension: ".pdf",
    magic: (bytes) => bytes.length > 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-",
  },
};
const extraFor = (kind) => (kind === "ledger" ? { code: "1002" } : {});
const query = (period, extra = {}) => new URLSearchParams({ period, ...extra }).toString();
const downloadPath = (kind, format, period = "2026-02", extra = {}) =>
  `/api/account-sets/${set.id}/reports/${kind}/export?${query(period, { format, ...extraFor(kind), ...extra })}`;
const previewPath = (kind, period = "2026-02") =>
  `/api/account-sets/${set.id}/reports/${kind}/export-data?${query(period, extraFor(kind))}`;
const request = (url, options) => fetch(base + url, { signal: AbortSignal.timeout(60000), ...options });

async function readDownload(response, format, kind, expectedSetId = set.id) {
  const spec = FORMATS[format];
  assert.equal(response.status, 200, `${format} ${kind} must download`);
  assert.match(response.headers.get("content-type") || "", spec.mime, `${format} ${kind} content-type`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const disposition = response.headers.get("content-disposition") || "";
  assert.match(disposition, /^attachment; filename="[^"\r\n]+"; filename\*=UTF-8''/, `${format} ${kind} disposition`);
  assert.ok([...disposition].every((char) => char.charCodeAt(0) < 128), "disposition header must be ASCII-safe");
  const asciiName = disposition.match(/filename="([^"]+)"/)[1];
  const utf8Name = decodeURIComponent(disposition.split("UTF-8''")[1]);
  assert.equal(utf8Name, asciiName, "UTF-8 filename and ASCII fallback must name the same file");
  assert.ok(utf8Name.startsWith(`${kind}-${expectedSetId}-`), `${format} ${kind} filename base: ${utf8Name}`);
  assert.ok(utf8Name.endsWith(spec.extension), `${format} ${kind} filename extension: ${utf8Name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(+response.headers.get("content-length"), bytes.length, `${format} ${kind} content-length`);
  assert.ok(spec.magic(bytes), `${format} ${kind} must start with real ${format} magic bytes`);
  return { bytes, filename: utf8Name };
}

async function expectJsonError(url, code, status) {
  const response = await request(url);
  assert.equal(response.status, status, `${url} must fail with ${status}`);
  assert.match(response.headers.get("content-type") || "", /^application\/json/, `${url} must stay JSON`);
  assert.equal(response.headers.get("content-disposition"), null, "errors must never start a file download");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.error, code);
  assert.equal(typeof body.message, "string");
  assert.ok(Object.hasOwn(body, "details"));
  return body;
}

// 独立 PDF 验证：解压内容流、解析嵌入的 ToUnicode CMap 并读取
// 真实文本操作符，使页数与中文文本验证不只依赖缓冲区长度。
function inflateStreams(buffer) {
  const text = buffer.toString("latin1");
  const streams = [];
  for (const match of text.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) continue;
    const raw = buffer.subarray(start, end);
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        streams.push(inflate(raw).toString("latin1"));
        break;
      } catch { /* 不是压缩流 */ }
    }
  }
  return streams;
}
function parseToUnicode(cmap) {
  const map = new Map();
  const unicode = (hex) => {
    let out = "";
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
      if (range[3].startsWith("[")) {
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
  let out = "";
  for (let index = 0; index + 4 <= digits.length; index += 4) out += map.get(parseInt(digits.slice(index, index + 4), 16)) ?? "";
  return out;
}
function extractPdf(buffer) {
  const streams = inflateStreams(buffer);
  const cmapText = streams.find((stream) => stream.includes("beginbfrange") || stream.includes("beginbfchar")) || "";
  const map = parseToUnicode(cmapText);
  assert.ok(map.size > 20, "PDF must embed a usable ToUnicode CMap");
  const pages = [];
  for (const stream of streams) {
    if (!/\bT[Jj]\b/.test(stream) || !stream.includes("BT")) continue;
    let text = "";
    for (const array of stream.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      for (const hex of array[1].matchAll(/<([0-9a-fA-F]+)>/g)) text += glyphText(hex[1], map);
    }
    for (const single of stream.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) text += glyphText(single[1], map);
    pages.push(text);
  }
  const latin = buffer.toString("latin1");
  return {
    pages,
    text: pages.join("\n"),
    squash: pages.join("\n").replace(/\s+/g, ""),
    pageCount: pages.length,
    embeddedFont: /\/FontFile2/.test(latin),
    hasStandardFont: /\/BaseFont\s*\/Helvetica/.test(latin),
  };
}
function pdfToolPageCount(bytes, name) {
  const path = join(pdfDir, name);
  writeFileSync(path, bytes);
  const result = spawnSync("pdfinfo", [path], { encoding: "utf8", timeout: 30000 });
  if (result.error || result.status !== 0) return null;
  const match = result.stdout.match(/^Pages:\s+(\d+)$/m);
  assert.ok(match, "pdfinfo must report a page count for a real PDF");
  return +match[1];
}

const MONEY = "#,##0.00";
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
async function loadWorkbook(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}
function workbookText(worksheet) {
  const values = [];
  worksheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
  return values.join("\n");
}

// --------------------------------------------------------------------------- CSV（保留原语义）
test("CSV: five kinds keep the existing BOM, Chinese and row semantics through real HTTP", async () => {
  const expectedRows = {
    "trial-balance": `"1002","银行存款","debit",${EXPECTED.feb.bankOpening.toFixed(2)},0.00,${EXPECTED.feb.bankPeriodDebit.toFixed(2)},${EXPECTED.feb.bankPeriodCredit.toFixed(2)},${EXPECTED.feb.bankYtdDebit.toFixed(2)},${EXPECTED.feb.bankYtdCredit.toFixed(2)},${EXPECTED.feb.bankClosing.toFixed(2)},0.00`,
    "income-statement": `"净利润",${EXPECTED.feb.profit.toFixed(2)},${EXPECTED.feb.profitYtd.toFixed(2)}`,
    "cash-flow-statement": `"现金净增加额","","",${EXPECTED.feb.cashChange.toFixed(2)},${EXPECTED.feb.cashChangeYtd.toFixed(2)}`,
    "balance-sheet": `"资产","货币资金",${EXPECTED.jan.bankClosing.toFixed(2)},${EXPECTED.feb.bankClosing.toFixed(2)}`,
    ledger: `"期末",${EXPECTED.feb.bankClosing.toFixed(2)},0.00`,
  };
  for (const kind of KINDS) {
    const { bytes } = await readDownload(await request(downloadPath(kind, "csv")), "csv", kind);
    const csv = bytes.toString("utf8");
    assert.equal(csv.charCodeAt(0), 0xfeff, `${kind} CSV keeps its UTF-8 BOM`);
    assert.match(csv, /合成接线测试公司/, `${kind} CSV must carry the account set name`);
    assert.match(csv, /2026-02/);
    assert.ok(csv.includes(expectedRows[kind]), `${kind} CSV row semantics changed:\n${expectedRows[kind]}\n${csv}`);
  }
  const ledger = (await readDownload(await request(downloadPath("ledger", "csv")), "csv", "ledger")).bytes.toString("utf8");
  assert.match(ledger, /一月合成收入|二月合成收入/, "ledger CSV must contain posted summaries");
  assert.doesNotMatch(ledger, /未过账/, "draft vouchers must not reach the CSV");
});

// --------------------------------------------------------------------------- XLSX
test("XLSX: five kinds are real workbooks, re-read by ExcelJS with hand-calculated money cells", async () => {
  const loaded = new Map();
  for (const kind of KINDS) {
    const { bytes } = await readDownload(await request(downloadPath(kind, "xlsx")), "xlsx", kind);
    const worksheet = (await loadWorkbook(bytes)).worksheets[0];
    assert.ok(["资产负债表", "利润表", "现金流量表", "科目余额表", "明细账"].includes(worksheet.name), `${kind} sheet name`);
    loaded.set(kind, worksheet);
  }

  const balance = loaded.get("balance-sheet");
  for (const [label, opening, closing] of [
    ["货币资金", EXPECTED.jan.bankClosing, EXPECTED.feb.bankClosing],
    ["资产总计", EXPECTED.jan.bankClosing, EXPECTED.feb.bankClosing],
    ["未分配利润", EXPECTED.jan.profit, EXPECTED.feb.profitYtd],
    ["负债和所有者权益总计", EXPECTED.jan.bankClosing, EXPECTED.feb.bankClosing],
  ]) {
    const row = findRow(balance, label);
    assert.ok(row > 0, `balance-sheet row ${label}`);
    cellNumber(balance, row, 2, opening, `${label} 期间期初`);
    cellNumber(balance, row, 3, closing, `${label} 期末`);
  }

  const income = loaded.get("income-statement");
  for (const [label, current, ytd] of [
    ["营业收入", EXPECTED.feb.revenue, EXPECTED.feb.revenueYtd],
    ["管理费用", EXPECTED.feb.expense, EXPECTED.feb.expenseYtd],
    ["净利润", EXPECTED.feb.profit, EXPECTED.feb.profitYtd],
  ]) {
    const row = findRow(income, label);
    assert.ok(row > 0, `income-statement row ${label}`);
    cellNumber(income, row, 2, current, `${label} 本期`);
    cellNumber(income, row, 3, ytd, `${label} 本年累计`);
  }

  const cash = loaded.get("cash-flow-statement");
  // 年累计列涵盖 2026-01..2026-02：现金期初 1000、期末 1800、变动 800。
  for (const [label, current, ytd] of [
    ["经营活动产生的现金流量净额", EXPECTED.feb.cashChange, EXPECTED.feb.cashChangeYtd],
    ["现金净增加额", EXPECTED.feb.cashChange, EXPECTED.feb.cashChangeYtd],
    ["现金期初余额", EXPECTED.feb.cashBegin, EXPECTED.jan.cashBegin],
    ["现金期末余额", EXPECTED.feb.cashEnd, EXPECTED.feb.cashEnd],
    ["现金余额变动", EXPECTED.feb.cashChange, EXPECTED.feb.cashChangeYtd],
  ]) {
    const row = findRow(cash, label);
    assert.ok(row > 0, `cash-flow row ${label}`);
    cellNumber(cash, row, 3, current, `${label} 本期`);
    cellNumber(cash, row, 4, ytd, `${label} 本年累计`);
  }

  const trial = loaded.get("trial-balance");
  const bankRow = findRow(trial, "1002");
  assert.ok(bankRow > 0, "trial-balance row 1002");
  for (const [column, expected, label] of [
    [4, EXPECTED.feb.bankOpening, "期初借方"], [5, 0, "期初贷方"],
    [6, EXPECTED.feb.bankPeriodDebit, "本期借方"], [7, EXPECTED.feb.bankPeriodCredit, "本期贷方"],
    [8, EXPECTED.feb.bankYtdDebit, "本年借方"], [9, EXPECTED.feb.bankYtdCredit, "本年贷方"],
    [10, EXPECTED.feb.bankClosing, "期末借方"], [11, 0, "期末贷方"],
  ]) cellNumber(trial, bankRow, column, expected, `1002 ${label}`);

  const ledger = loaded.get("ledger");
  for (const [label, debit, credit] of [
    ["期间期初", EXPECTED.feb.bankOpening, 0],
    ["本期发生", EXPECTED.feb.bankPeriodDebit, EXPECTED.feb.bankPeriodCredit],
    ["本年累计", EXPECTED.feb.bankYtdDebit, EXPECTED.feb.bankYtdCredit],
    ["期末余额", EXPECTED.feb.bankClosing, 0],
  ]) {
    const row = findRow(ledger, label);
    assert.ok(row > 0, `ledger summary row ${label}`);
    cellNumber(ledger, row, 2, debit, `${label} 借方`);
    cellNumber(ledger, row, 3, credit, `${label} 贷方`);
  }
  const summaryRows = [];
  for (let row = 1; row <= ledger.rowCount; row++) {
    const text = String(ledger.getRow(row).getCell(8).value ?? "");
    if (text === "二月合成收入" || text === "二月合成费用") summaryRows.push({ row, text });
  }
  assert.equal(summaryRows.filter((item) => item.text === "二月合成收入").length, 1, "ledger must list the posted receipt once");
  assert.equal(summaryRows.filter((item) => item.text === "二月合成费用").length, 1, "ledger must list the posted payment once");
  const receipt = summaryRows.find((item) => item.text === "二月合成收入").row;
  cellNumber(ledger, receipt, 9, EXPECTED.feb.bankPeriodDebit, "二月收入 借方");
  // 连续余额：期初 1500 + 收款 400 = 1900，再减付款 100 = 1800。
  cellNumber(ledger, receipt, 11, EXPECTED.feb.bankClosing + EXPECTED.feb.bankPeriodCredit, "二月收入 余额");
  const payment = summaryRows.find((item) => item.text === "二月合成费用").row;
  cellNumber(ledger, payment, 10, EXPECTED.feb.bankPeriodCredit, "二月费用 贷方");
  cellNumber(ledger, payment, 11, EXPECTED.feb.bankClosing, "二月费用 余额");
  assert.doesNotMatch(workbookText(ledger), /未过账/, "draft vouchers must not reach the XLSX");
});

// --------------------------------------------------------------------------- PDF
test("PDF: five kinds are real PDFs with embedded Chinese text, page footers and hand totals", async () => {
  const expectedText = {
    "balance-sheet": ["资产负债表", "货币资金", "1,800.00", "800.00"],
    "income-statement": ["利润表", "净利润", "1,200.00", "800.00"],
    "cash-flow-statement": ["现金流量表", "现金净增加额", "300.00", "800.00"],
    "trial-balance": ["科目余额表", "1002", "1,800.00", "1,200.00"],
    ledger: ["明细账", "二月合成收入", "1,900.00", "1,800.00"],
  };
  for (const kind of KINDS) {
    const { bytes, filename } = await readDownload(await request(downloadPath(kind, "pdf")), "pdf", kind);
    const pdf = extractPdf(bytes);
    assert.ok(pdf.pageCount >= 1, `${kind} PDF must have at least one readable page`);
    assert.ok(pdf.embeddedFont, `${kind} PDF must embed a Chinese font subset`);
    assert.equal(pdf.hasStandardFont, false, `${kind} PDF must not fall back to unembedded Helvetica`);
    assert.match(pdf.squash, /内部报表·非税局申报文件·数据完整性未核实·第1页\/共\d+页/, `${kind} PDF footer`);
    assert.ok(pdf.squash.includes("合成接线测试公司"), `${kind} PDF must carry the Chinese account set name`);
    for (const text of expectedText[kind]) assert.ok(pdf.squash.includes(text), `${kind} PDF must contain ${text}`);
    const toolPages = pdfToolPageCount(bytes, filename);
    if (toolPages !== null) assert.equal(toolPages, pdf.pageCount, `${kind} PDF page count must match pdfinfo`);
    if (kind === "ledger") assert.ok(!pdf.text.includes("未过账"), "draft vouchers must not reach the PDF");
  }
});

// --------------------------------------------------------------------------- 预览仍为 DTO
test("preview stays a JSON DTO and never produces an attachment", async () => {
  for (const kind of KINDS) {
    const response = await request(previewPath(kind));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^application\/json/);
    assert.equal(response.headers.get("content-disposition"), null, "preview must not start a download");
    const report = await response.json();
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.dataStatus.taxFilingReady, false);
    assert.equal(report.scope.status, "posted");
  }
  const income = await (await request(previewPath("income-statement"))).json();
  // 手算而非导出器计算：二月利润 400 - 100 = 300，年累计 1200 - 400 = 800。
  assert.equal(income.data.current["净利润"], EXPECTED.feb.profit);
  assert.equal(income.data.ytd["净利润"], EXPECTED.feb.profitYtd);
  const ledger = await (await request(previewPath("ledger"))).json();
  assert.equal(ledger.data.items.length, EXPECTED.feb.ledgerItems);
  assert.equal(ledger.data.opening.debit, EXPECTED.feb.bankOpening);
  assert.equal(ledger.data.closing.debit, EXPECTED.feb.bankClosing);
  // 预览不处理格式：Office / 未知格式严格返回 400，不静默返回 CSV DTO。
  for (const format of ["xlsx", "pdf", "yaml", ""])
    await expectJsonError(`${previewPath("trial-balance")}&format=${format}`, "report_format_unsupported", 400);
});

test("05b: real three-format composite and true-unknown attachments retain independent values", async () => {
  for (const [period, operating, investing, net, ytdNet, end, partial] of [
    ["2025-12", 20, 30, 50, -250, 750, false],
    ["2026-01", -12.01, -18.02, -30.03, -30.03, 719.97, false],
    ["2026-02", 0, 0, 0, -30.03, 709.97, true],
  ]) {
    const preview = await (await request('/api/account-sets/' + composite.id + '/reports/cash-flow-statement/export-data?period=' + period)).json();
    assert.equal(preview.reportStatus.partialValues, partial); assert.equal(preview.reportStatus.complete, !partial);
    assert.equal(preview.dataStatus.completeness, "unverified"); assert.equal(preview.dataStatus.taxFilingReady, false);
    for (const format of ["csv", "xlsx", "pdf"]) {
      const url = '/api/account-sets/' + composite.id + '/reports/cash-flow-statement/export?' + query(period, { format });
      const {bytes} = await readDownload(await request(url), format, "cash-flow-statement", composite.id);
      if (format === "csv") {
        const text = bytes.toString("utf8");
        for (const [label, current, ytd] of [["现金净增加额", net, ytdNet], ["现金期末余额", end, end]]) assert.ok(text.includes('"' + label + '","","",' + current.toFixed(2) + ',' + ytd.toFixed(2)));
        assert.ok(text.includes('"部分金额","' + (partial ? '是' : '否') + '"'));
      } else if (format === "xlsx") {
        const sheet = (await loadWorkbook(bytes)).worksheets[0];
        for (const [label, col, amount] of [["经营活动产生的现金流量净额", 3, operating], ["投资活动产生的现金流量净额", 3, investing], ["现金净增加额", 3, net], ["现金净增加额", 4, ytdNet], ["现金期末余额", 4, end]]) cellNumber(sheet, findRow(sheet, label), col, amount, label);
        assert.equal(sheet.getRow(findRow(sheet, "部分金额")).getCell(2).value, partial ? "是" : "否");
      } else {
        const pdf = extractPdf(bytes);
        assert.ok(pdf.embeddedFont); assert.ok(pdf.squash.includes("现金净增加额" + net.toFixed(2) + ytdNet.toFixed(2)));
        assert.ok(pdf.squash.includes("现金期末余额" + end.toFixed(2) + end.toFixed(2)));
        assert.ok(pdf.squash.includes("部分金额" + (partial ? "是" : "否")));
        writeFileSync(join(pdfDir, "05b-http-" + period + ".pdf"), bytes);
      }
    }
  }
});

test("P2: real precision attachments preserve independent cents; unrepresentable/range failures have no attachment", async () => {
  for (const format of ["csv", "xlsx", "pdf"]) {
    const url = '/api/account-sets/' + precise.id + '/reports/ledger/export?' + query("2026-01", { format, code: "1002" });
    const {bytes} = await readDownload(await request(url), format, "ledger", precise.id);
    if (format === "csv") assert.ok(bytes.toString("utf8").includes('"期末",900000000010.00,0.00'));
    else if (format === "xlsx") {
      const sheet = (await loadWorkbook(bytes)).worksheets[0];
      cellNumber(sheet, findRow(sheet, "期间期初"), 2, 900000000010, "HTTP精确期初"); cellNumber(sheet, findRow(sheet, "期末余额"), 2, 900000000010, "HTTP精确期末");
    } else {
      const pdf = extractPdf(bytes); assert.ok(pdf.squash.includes("900,000,000,010.00")); assert.ok(!pdf.squash.includes("900,000,000,010.01"));
      writeFileSync(join(pdfDir, "05b-http-precision.pdf"), bytes);
    }
    for (const id of precisionBad) await expectJsonError('/api/account-sets/' + id + '/reports/trial-balance/export?' + query("2026-01", { format }), "report_data_invalid", 422);
  }
});

test("P2: legal extreme aggregate has the same exact .90 in real CSV/XLSX/PDF attachments", async () => {
  for (const format of ["csv", "xlsx", "pdf"]) {
    const url = '/api/account-sets/' + extreme.id + '/reports/ledger/export?' + query("2026-01", { format, code: "1002" });
    const {bytes} = await readDownload(await request(url), format, "ledger", extreme.id);
    if (format === "csv") { assert.ok(bytes.toString("utf8").includes('"期末",90071992547409.90,0.00')); assert.ok(!bytes.toString("utf8").includes('90071992547409.91')); }
    else if (format === "xlsx") {
      const sheet = (await loadWorkbook(bytes)).worksheets[0]; cellNumber(sheet, findRow(sheet, "期间期初"), 2, 90071992547409.9, "合法极界HTTP期初"); cellNumber(sheet, findRow(sheet, "期末余额"), 2, 90071992547409.9, "合法极界HTTP期末");
    } else {
      const pdf = extractPdf(bytes); assert.ok(pdf.squash.includes("90,071,992,547,409.90")); assert.ok(!pdf.squash.includes("90,071,992,547,409.91"));
      writeFileSync(join(pdfDir, "05b-http-extreme.pdf"), bytes);
    }
  }
});

// --------------------------------------------------------------------------- 输入校验保持不变
test("input validation stays JSON with no attachment", async () => {
  const path = (kind, format, extra = {}, period = "2026-02", id = set.id) =>
    `/api/account-sets/${id}/reports/${kind}/export?${query(period, { format, ...extra })}`;
  await expectJsonError(path("trial-balance", "yaml"), "report_format_unsupported", 400);
  await expectJsonError(path("trial-balance", "csv", {}, "2026-03"), "period_not_registered", 400);
  await expectJsonError(path("ledger", "csv", {}, "2026-02"), "account_code_required", 400);
  await expectJsonError(path("ledger", "csv", { code: "9999" }), "account_not_found", 404);
  await expectJsonError(path("trial-balance", "csv", {}, "2026-02", 999999), "account_set_not_found", 404);
});

// --------------------------------------------------------------------------- 生成失败
test("generation failures return fixed JSON errors and never a partial attachment", async () => {
  // 超长字段：在写入任何字节之前拒绝（XLSX / PDF 共用同一限制）。
  const longUrl = `/api/account-sets/${longSet.id}/reports/trial-balance/export?${query("2026-01", { format: "xlsx" })}`;
  const tooLong = await expectJsonError(longUrl, "office_text_too_long", 422);
  assert.doesNotMatch(JSON.stringify(tooLong), /超长名称/, "raw over-long text must not be echoed back");
  assert.doesNotMatch(JSON.stringify(tooLong), /\.mjs|at .*\(/, "no stack trace or internal module path");

  // 缺少字体：使用同一运行服务，但子进程找不到可嵌入的中日韩字体。
  try {
    fontServer = startServer({ REPORT_PDF_FONT: join(directory, "missing-font.ttf") });
    const fontBase = `http://127.0.0.1:${await fontServer.ready}`;
    const response = await fetch(`${fontBase}/api/account-sets/${set.id}/reports/trial-balance/export?${query("2026-02", { format: "pdf" })}`, {
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type") || "", /^application\/json/);
    assert.equal(response.headers.get("content-disposition"), null, "a missing font must not start a download");
    const body = await response.json();
    assert.equal(body.error, "pdf_font_unavailable");
    assert.equal(typeof body.message, "string");
    assert.ok(!JSON.stringify(body).includes("missing-font.ttf"), "font file name/path must not leak to the user");
    assert.doesNotMatch(JSON.stringify(body), /\.mjs|at .*\(/, "no stack trace or internal module path");
  } finally {
    await stopQuietly(fontServer);
    fontServer = null;
  }
});
