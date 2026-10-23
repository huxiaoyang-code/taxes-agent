#!/usr/bin/env node
// finance-model-entry-test.mjs — LOCAL-08 真实 stdio MCP → HTTP → Agent → SQLite，
// 外加独立故障后端验证运输边界（非 JSON / 非 2xx / 敏感额外字段 / 收完请求断连）。
//
// 运行：node 05-reconstruction/codex/mcp/finance-mcp/finance-model-entry-test.mjs
//
// 只使用临时合成库与随机 loopback 端口；不连接 8787、真实账套、凭据、税局或旧进程。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpStdioClient } from "./mcp-stdio-client.mjs";
import { MODEL_PLAIN_TOOL_NAMES, MODEL_WRITE_TOOL_NAMES, TOOLS } from "./tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const WORKBENCH = join(REPO, "06-workbench", "server", "server.mjs");

const SECRET = "合成机密运输原文-DO-NOT-LEAK";
const MARKERS = [
  "合成MCP企业名称甲", "合成MCP科目名称乙", "合成MCP摘要丙", "合成MCP资产名称庚",
  "91350000MCPX01", "syn-mcp-batch-20261022", "syn-mcp-source", SECRET,
];
function assertNoLeak(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const hits = MARKERS.filter((marker) => text.includes(marker));
  assert.deepEqual(hits, [], `${label} 泄漏合成原值：${hits.join(" / ")}`);
}
/** 本机引用值允许业务原文，但绝不允许运输层机密 / 内部路径。 */
function assertNoTransportSecret(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of [SECRET, "workbench.db", "    at ", "Error:"]) {
    assert.equal(text.includes(needle), false, `${label} 不应包含 ${needle}`);
  }
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  PASS ${name}`); }
  catch (error) { results.push(false); console.error(`  FAIL ${name}\n${error.stack}`); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const dataDir = mkdtempSync(join(tmpdir(), "mcp-model-entry-"));
let backend = null;
let client = null;
let fault = null;
let faultClient = null;
let debugClient = null;
let base = "";

async function startBackend() {
  const port = await freePort();
  const proc = spawn(process.execPath, [WORKBENCH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WORKBENCH_DATA_DIR: dataDir },
  });
  backend = proc; // Own the handle before startup can fail, so finally always reclaims it.
  let err = "";
  proc.stderr.on("data", (d) => { err += d.toString(); });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`backend_not_ready: ${err.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  backend = proc;
  return `http://127.0.0.1:${port}`;
}

async function stopBackend() {
  if (!backend) return;
  const proc = backend;
  backend = null;
  const done = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill();
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }
}

async function localRead(body) {
  const res = await fetch(`${base}/api/finance-output/read`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function okCall(name, args, label = name) {
  const r = await client.call(name, args);
  assert.equal(r.isError, false, `${label} 应成功：${r.text}`);
  assert.equal(r.data.ok, true, `${label} 信封 ok=true`);
  assert.equal(r.data.channel, "model");
  assert.equal(r.data.rawValuesIncluded, false);
  assert.deepEqual(r.structured, r.data, `${label} structuredContent 必须与 text 一致`);
  assertNoLeak(r.text, label);
  return r.data;
}
async function writeOk(name, args, label = name) {
  const envelope = await okCall(name, args, label);
  assert.equal(envelope.applied, true, `${label} applied=true`);
  return envelope;
}
async function failCall(name, args, code, label = name) {
  const r = await client.call(name, args);
  assert.equal(r.isError, true, `${label} 应 isError：${r.text}`);
  assert.equal(r.data.error?.code ?? r.data.error, code, `${label} 错误码 ${code}，实际 ${r.text}`);
  assertNoLeak(r.text, label);
  return r.data;
}

try {
  base = await startBackend();
  client = new McpStdioClient(join(here, "server.mjs"), {
    env: { FINANCE_API_BASE: base, FINANCE_API_TIMEOUT_MS: "10000" }, timeoutMs: 25000,
  }).start();
  await client.initialize("model-entry");
  console.log(`\n模型 MCP 入口测试 @ ${base}（临时目录 ${dataDir}）\n`);

  await test("1. tools/list：普通工具保留业务名并声明摘要语义；不登记 raw / local 工具", async () => {
    const list = await client.rpc("tools/list");
    const tools = list.result.tools;
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of MODEL_PLAIN_TOOL_NAMES) assert.ok(names.includes(name), `缺少普通工具 ${name}`);
    for (const banned of ["localRead", "localCompute", "local_read", "finance_output_read", "finance_output_compute", "raw_tool"]) {
      assert.equal(names.includes(banned), false, `不得登记 ${banned}`);
    }
    for (const tool of tools) {
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} schema`);
      assert.ok(String(tool.description).length > 4, `${tool.name} description`);
      // 不允许任何工具声明任意 URL 参数。
      assert.equal(Object.keys(tool.inputSchema.properties || {}).includes("url"), false, `${tool.name} 不得接受任意 URL`);
    }
    for (const name of MODEL_PLAIN_TOOL_NAMES) {
      const tool = tools.find((t) => t.name === name);
      assert.match(tool.description, /localRef|摘要|投影/, `${name} 应明确摘要 / 本机引用语义`);
    }
    const ctx = tools.find((t) => t.name === "account_context");
    assert.deepEqual(Object.keys(ctx.inputSchema.properties).sort(), ["accountSetId", "limit", "offset"]);
    // 写工具的登记表与 adapter 侧一致（此处只核对本文件可见的固定清单）。
    assert.equal(MODEL_WRITE_TOOL_NAMES.length, 14);
  });

  await test("2. 静态目录 / 计划：模型只拿固定 nodeId 与计数，不回业务原文", async () => {
    const catalog = await okCall("finance_query_catalog", {});
    assert.equal(catalog.operation, "finance_query_catalog");
    assert.equal(catalog.catalog.available.length, 12);
    assert.equal(catalog.catalog.unimplemented.length, 11);
    assert.equal(Object.prototype.hasOwnProperty.call(catalog, "capabilities"), false);
    const plan = await okCall("update_plan", { plan: ["合成MCP摘要丙", "合成MCP资产名称庚"] });
    assert.equal(plan.projection.planItemCount, 2);
    assert.equal(plan.projection.persisted, false);
  });

  await test("3. 建账 → 期初 → 凭证 → 过账 → 查询：真实链路与手算金额", async () => {
    const created = await writeOk("account_set_create", {
      name: "合成MCP企业名称甲", taxpayer_type: "小规模纳税人",
      accounting_standard: "小企业会计准则", start_period: "2026-01",
    });
    const setId = created.accountSetId;
    assert.ok(setId > 0);
    const rawCreated = await localRead({ ref: created.localRef, accountSetId: setId, operation: created.operation });
    assert.equal(rawCreated.status, 200);
    assertNoTransportSecret(rawCreated.data, "本机 create 引用值");
    assert.equal(rawCreated.data.value.name, "合成MCP企业名称甲");

    const opening = await writeOk("opening_balance_set", {
      accountSetId: setId,
      items: [
        { code: "1002", debit: 1000, credit: 0 },
        { code: "1601", debit: 1200, credit: 0 },
        { code: "3001", debit: 0, credit: 2200 },
      ],
    });
    assert.equal(opening.projection.itemCount, 3);

    const voucher = await writeOk("voucher_create", {
      accountSetId: setId, period: "2026-01", summary: "合成MCP摘要丙", status: "posted",
      entries: [
        { code: "1122", debit: 300, credit: 0, summary: "合成MCP摘要丙" },
        { code: "5001", debit: 0, credit: 300, summary: "合成MCP摘要丙" },
      ],
    });
    assert.equal(voucher.projection.status, "posted");
    assert.equal(voucher.projection.totalDebit, 300);

    const income = await okCall("finance_query", {
      nodeId: "report.income_statement", accountSetId: setId, period: "2026-01",
    });
    assert.equal(income.projection.currentNetProfit, 300);
    const rawIncome = await localRead({ ref: income.localRef, accountSetId: setId, operation: income.operation });
    assert.equal(rawIncome.status, 200);
    assert.equal(rawIncome.data.value.current["净利润"], 300);

    const ledger = await okCall("ledger_query", { accountSetId: setId, code: "1122", period: "2026-01" });
    assert.equal(ledger.projection.itemCount, 1);
    assert.equal(ledger.projection.closingBalance, 300);

    // 写三态：dry-run 是成功但未应用；wrapper 必须保留 applied=false + 本机复核。
    const dry = await okCall("legacy_book_import", {
      payload: {
        account_set: { name: "合成MCP企业名称甲", start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
        opening_balances: [],
        vouchers: [],
      },
    });
    assert.equal(dry.applied, false);
    assert.equal(dry.appliedReason, "dry_run");
    assert.equal(dry.needsLocalReview, true);

    // 未实现 / 未知 node / 税费工具：业务错误 → isError 且固定码。
    await failCall("finance_query", { nodeId: "nope.nope", accountSetId: setId, period: "2026-01" }, "model_node_unknown");
    await failCall("finance_query", { nodeId: "invoice.detail", accountSetId: setId, period: "2026-01" }, "model_node_not_implemented");
    await failCall("invoice_issue", {}, "not_implemented");
    await failCall("no_such_tool", {}, "unknown_tool");

    // 本机 paths 读失败不得回显路径。
    const missingPath = join(dataDir, "合成MCP路径-绝不应回显.csv");
    const pathFailure = await client.call("legacy_book_import", { paths: { meta: missingPath } });
    assert.equal(pathFailure.isError, true);
    assert.equal(pathFailure.data.error, "path_read_failed");
    assert.equal(pathFailure.text.includes(missingPath), false);
    assert.equal(pathFailure.text.includes("合成MCP路径"), false);

    // 参数里声明 local 不会得到原文。
    const localFlag = await client.call("account_list", { accountSetId: setId, local: true });
    assert.equal(localFlag.isError, false);
    assert.equal(localFlag.data.channel, "model");
    assert.equal(localFlag.data.rawValuesIncluded, false);
  });

  await test("4. 资产 / 折旧 / 期末检查 / 结转 / 封账：真实写与本地读取", async () => {
    const context = await okCall("account_context", { accountSetId: 1 });
    const setId = context.accountSetId;
    const asset = await writeOk("asset_create", {
      accountSetId: setId, kind: "fixed", name: "合成MCP资产名称庚", original_cost: 1200,
      residual_rate: 0.05, useful_life_months: 12, start_period: "2026-01", acquired_period: "2026-01",
    });
    const assetId = asset.projection.assetId;
    const rawAsset = await localRead({ ref: asset.localRef, accountSetId: setId, operation: asset.operation });
    assert.equal(rawAsset.data.value.name, "合成MCP资产名称庚");

    const updated = await writeOk("asset_update", { accountSetId: setId, assetId, patch: { ledger_note: "合成MCP备注戊" } });
    assert.equal(updated.projection.ledgerStatus, "booked");

    const beforeDep = await okCall("period_end_check", { accountSetId: setId, period: "2026-01" });
    assert.equal(beforeDep.projection.blockingCodes.includes("depreciation_missing"), true);
    const dep = await writeOk("depreciation_run", { accountSetId: setId, period: "2026-01" });
    assert.equal(dep.projection.totalAmount, 95);
    const carry = await writeOk("carry_forward_profit", { accountSetId: setId, period: "2026-01" });
    assert.equal(carry.projection.profit, 205);
    const ready = await okCall("period_end_check", { accountSetId: setId, period: "2026-01" });
    assert.equal(ready.projection.ready, true);
    const closed = await writeOk("period_set_status", { accountSetId: setId, period: "2026-01", status: "closed" });
    assert.equal(closed.projection.status, "closed");
    await failCall("voucher_create", {
      accountSetId: setId, period: "2026-01", entries: [{ code: "1001", debit: 1 }, { code: "1002", credit: 1 }],
    }, "period_closed");
  });

  await test("5. 增量导入 / 批次 / 幂等回放：账套只取真实结果", async () => {
    const payload = {
      account_set: { name: "合成MCP企业名称甲", start_period: "2026-01", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则" },
      opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
      vouchers: [],
    };
    const source = { system: "syn-mcp-source", enterpriseKey: "91350000MCPX01" };
    const preview = await okCall("book_import_incremental", { batchId: "syn-mcp-batch-20261022-preview", source, payload });
    assert.equal(preview.applied, false);
    assert.equal(preview.projection.status, "preview");
    const applied = await writeOk("book_import_incremental", {
      batchId: "syn-mcp-batch-20261022", source, payload, dryRun: false,
    });
    assert.equal(applied.projection.status, "applied");
    const batch = await okCall("book_import_batch", { batchId: "syn-mcp-batch-20261022" });
    assert.equal(batch.accountSetId, applied.accountSetId);
    assert.equal(batch.projection.batchStatus, "completed");
    const replay = await okCall("book_import_incremental", {
      batchId: "syn-mcp-batch-20261022", source, payload, dryRun: false,
    });
    assert.equal(replay.applied, false);
    assert.equal(replay.appliedReason, "idempotent_replay");
    assertNoLeak(batch, "批次审计摘要");
  });

  await test("6. 独立故障后端：非 JSON / 非 2xx / 敏感额外字段 / 收完请求断连均固定失败", async () => {
    const faultPort = await freePort();
    fault = createServer((req, res) => {
      const name = decodeURIComponent(String(req.url).split("/").pop());
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (name === "account_list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(`not-json ${SECRET}`);
          return;
        }
        if (name === "opening_balance_get") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, rawValuesIncluded: false, message: SECRET, details: { raw: SECRET } }));
          return;
        }
        if (name === "voucher_create") {
          // 请求已完整收到后断连：写结果无法确认，绝不允许自动重试。
          req.socket.destroy();
          return;
        }
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: SECRET, message: SECRET }));
      });
    });
    await new Promise((resolve) => fault.listen(faultPort, "127.0.0.1", resolve));
    faultClient = new McpStdioClient(join(here, "server.mjs"), {
      env: { FINANCE_API_BASE: `http://127.0.0.1:${faultPort}`, FINANCE_API_TIMEOUT_MS: "5000" }, timeoutMs: 20000,
    }).start();
    await faultClient.initialize("model-entry-fault");

    const nonJson = await faultClient.call("account_list", { accountSetId: 1 });
    assert.equal(nonJson.isError, true);
    assert.equal(nonJson.data.error, "backend_non_json");
    assert.equal(nonJson.text.includes(SECRET), false);

    const sensitive = await faultClient.call("opening_balance_get", { accountSetId: 1 });
    assert.equal(sensitive.isError, true);
    assert.match(String(sensitive.data.error), /envelope_/);
    assert.equal(sensitive.text.includes(SECRET), false);

    const writeDrop = await faultClient.call("voucher_create", { accountSetId: 1, period: "2026-01", entries: [] });
    assert.equal(writeDrop.isError, true);
    assert.equal(writeDrop.data.error, "backend_unreachable");
    assert.equal(writeDrop.data.retriable, false);
    assert.equal(writeDrop.data.writeOutcome, "unknown");
    assert.equal(writeDrop.data.retryBlockedBy, "write_outcome_unknown");
    assert.equal(writeDrop.text.includes(SECRET), false);

    const httpError = await faultClient.call("period_set_status", { accountSetId: 1, period: "2026-01", status: "open" });
    assert.equal(httpError.isError, true);
    assert.equal(httpError.data.error, "backend_http_error");
    assert.equal(httpError.data.writeOutcome, "unknown");
    assert.equal(httpError.data.retriable, false);
    assert.equal(httpError.text.includes(SECRET), false);

    const readError = await faultClient.call("account_context", {});
    assert.equal(readError.isError, true);
    assert.equal(readError.data.error, "backend_http_error");
    assert.equal(readError.text.includes(SECRET), false);
  });

  await test("7. 调试输出不回显 API_BASE / 原始错误 / 路径", async () => {
    const debugPort = await freePort();
    const debugBase = `http://127.0.0.1:${debugPort}/synthetic-debug-base`;
    debugClient = new McpStdioClient(join(here, "server.mjs"), {
      env: { FINANCE_API_BASE: debugBase, FINANCE_MCP_DEBUG: "1" }, timeoutMs: 20000,
    }).start();
    await debugClient.initialize("model-entry-debug");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(debugClient.stderr, /finance-mcp backend/);
    assert.equal(debugClient.stderr.includes(debugBase), false, "调试日志不得回显 API_BASE");
    assert.equal(debugClient.stderr.includes("synthetic-debug-base"), false);
    assert.equal(debugClient.stderr.includes(dataDir), false);
    const unreachable = await debugClient.call("account_list", { accountSetId: 1 });
    assert.equal(unreachable.isError, true);
    assert.equal(unreachable.data.error, "backend_unreachable");
    assert.equal(unreachable.text.includes(debugBase), false);
  });

  await test("8. 税务工具仍走既有 raw 通道（输出约定不变）", async () => {
    const regions = await client.call("tax_regions", {});
    assert.equal(regions.isError, false);
    assert.equal(typeof regions.data, "object");
    assert.equal(regions.data.channel, undefined, "税务通道不应被套上模型信封");
    assertNoLeak(regions.text, "tax_regions");
  });
  await test("9. real committed write response loss: six proxy modes, exactly once, unknown", async () => {
    const set = await writeOk("account_set_create", { name: "synthetic fault isolated", start_period: "2026-01" });
    for (const [index, mode] of ["drop", "timeout", "partial", "badJSON", "non2xx", "invalidEnvelope"].entries()) {
      let forwarded = 0, committed;
      const timers = new Set();
      const proxy = createServer(async (req, res) => {
        try {
          let body = "";
          for await (const part of req) body += part;
          forwarded++;
          const upstream = await fetch(base + req.url, { method: req.method,
            headers: { "content-type": "application/json" }, body });
          committed = await upstream.json();
          assert.equal(committed.applied, true);
          if (mode === "drop") return req.socket.destroy();
          if (mode === "timeout") {
            const timer = setTimeout(() => { timers.delete(timer); res.end(JSON.stringify(committed)); }, 1800);
            timers.add(timer); return;
          }
          if (mode === "partial") {
            res.writeHead(200, { "content-type": "application/json", "content-length": "99999" });
            res.write('{"secret":"');
            const timer = setTimeout(() => { timers.delete(timer); res.destroy(); }, 25);
            timers.add(timer); return;
          }
          res.writeHead(mode === "non2xx" ? 503 : 200, { "content-type": "application/json" });
          res.end(mode === "badJSON" ? SECRET : JSON.stringify(mode === "invalidEnvelope" ? { ...committed, sensitive: SECRET } : { error: SECRET }));
        } catch { res.destroy(); }
      });
      let proxyClient;
      try {
        await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        proxyClient = new McpStdioClient(join(here, "server.mjs"), {
          env: { FINANCE_API_BASE: `http://127.0.0.1:${proxy.address().port}`, FINANCE_API_TIMEOUT_MS: "700" }, timeoutMs: 10000,
        }).start();
        await proxyClient.initialize("real-commit-fault");
        const beforeReject = await proxyClient.call("voucher_create", { period: "2026-01", entries: [] });
        assert.equal(beforeReject.isError, true); assert.equal(forwarded, 0);
        const amount = 61 + index;
        const r = await proxyClient.call("voucher_create", { accountSetId: set.accountSetId, period: "2026-01",
          summary: `synthetic fault ${mode}`, entries: [{ code: "1001", debit: amount }, { code: "1002", credit: amount }] });
        assert.equal(r.isError, true, mode);
        const expected = { drop: "backend_unreachable", timeout: "backend_timeout", partial: "backend_unreachable",
          badJSON: "backend_non_json", non2xx: "backend_http_error", invalidEnvelope: "envelope_field_unknown" };
        if (mode === "invalidEnvelope") assert.match(r.data.error, /^envelope_/);
        else assert.equal(r.data.error, expected[mode], mode);
        assert.equal(r.data.writeOutcome, "unknown", mode);
        assert.equal(r.data.retriable, false, mode);
        assert.equal(r.data.retryBlockedBy, "write_outcome_unknown", mode);
        assert.equal(forwarded, 1, "no retry or raw fallback");
        assert.equal(committed.applied, true);
        const rows = await (await fetch(`${base}/api/account-sets/${set.accountSetId}/vouchers`)).json();
        const matches = rows.filter((v) => v.summary === `synthetic fault ${mode}`);
        assert.equal(matches.length, 1, mode);
        assert.equal(matches[0].id, committed.projection.voucherId);
        const detail = await (await fetch(`${base}/api/account-sets/${set.accountSetId}/vouchers/${matches[0].id}`)).json();
        assert.equal(detail.entries[0].debit, amount);
        assertNoLeak(r.text, mode); assertNoLeak(proxyClient.stderr, mode);
        console.log(`    committed ${mode}: forwards=1 rows=1 debit=${amount}`);
      } finally {
        if (proxyClient) await proxyClient.close();
        for (const timer of timers) clearTimeout(timer);
        proxy.closeAllConnections();
        await new Promise((resolve) => proxy.close(resolve));
      }
    }
  });

  await test("10. one stdio client concurrent two-account writes, reads, and reference scope", async () => {
    const sets = await Promise.all([37, 53].map((n) => writeOk("account_set_create", { name: `synthetic stdio ${n}`, start_period: "2026-01" })));
    const writes = await Promise.all(sets.map((s, i) => writeOk("voucher_create", {
      accountSetId: s.accountSetId, period: "2026-01", status: "posted",
      entries: [{ code: "1001", debit: [37,53][i] }, { code: "5001", credit: [37,53][i] }],
    })));
    const reads = await Promise.all(sets.map((s) => okCall("ledger_query", { accountSetId: s.accountSetId, code: "1001", period: "2026-01" })));
    for (let i = 0; i < 2; i++) {
      const setId = sets[i].accountSetId;
      assert.equal(writes[i].accountSetId, setId); assert.equal(writes[i].operation, "voucher_create");
      assert.equal(writes[i].projection.totalDebit, [37,53][i]);
      assert.equal(reads[i].accountSetId, setId); assert.equal(reads[i].operation, "ledger_query");
      assert.equal(reads[i].projection.closingBalance, [37,53][i]); assert.equal(reads[i].projection.itemCount, 1);
      const local = await localRead({ ref: writes[i].localRef, accountSetId: setId, operation: "voucher_create" });
      assert.equal(local.status, 200); assert.equal(local.data.value.id, writes[i].projection.voucherId);
      assert.equal(local.data.value.entries[0].debit, [37,53][i]);
      const cross = await localRead({ ref: writes[i].localRef, accountSetId: sets[1-i].accountSetId, operation: "voucher_create" });
      assert.equal(cross.status, 400);
      const rows = await (await fetch(`${base}/api/account-sets/${setId}/vouchers`)).json();
      assert.equal(rows.length, 1);
    }
  });

  await test("11. narrow resource and protocol errors are fixed and process stays alive", async () => {
    const marker = "SYNTHETIC_INTERNAL_PATH_MARKER";
    const file = join(dataDir, marker); writeFileSync(file, "synthetic fixture");
    const dir = join(dataDir, "skills"); mkdirSync(dir); mkdirSync(join(dir, "folder.md"));
    for (const skillsDir of [file, dir]) {
      const c = new McpStdioClient(join(here, "server.mjs"), { env: { FINANCE_API_BASE: base, FINANCE_SKILLS_DIR: skillsDir } }).start();
      try {
        await c.initialize("resource-fixed-error");
        if (skillsDir === file) {
          const list = await c.call("skills_list", {});
          assert.equal(list.data.error, "skill_not_found");
          const resources = await c.rpc("resources/list");
          assert.deepEqual(resources.error, { code: -32002, message: "skill_not_found" });
          assertNoTransportSecret(JSON.stringify([list, resources]), "resource errors");
          assert.equal(JSON.stringify([list, resources]).includes(marker), false);
        } else {
          const read = await c.call("skills_read", { resource: "folder.md" });
          assert.equal(read.data.error, "skill_not_found");
          const readRpc = await c.rpc("resources/read", { uri: "skill://folder.md" });
          assert.deepEqual(readRpc.error, { code: -32002, message: "skill_not_found" });
        }
        const objectMethod = await c.rpc({ synthetic: marker });
        assert.deepEqual(objectMethod.error, { code: -32600, message: "invalid_request" });
        const unknown = await c.rpc(marker);
        assert.deepEqual(unknown.error, { code: -32601, message: "method_not_found" });
        // Send JSON null directly, capture the response independently (id:null).
        const nullReply = new Promise((resolve, reject) => {
          let buffer = "";
          const timer = setTimeout(() => { c.child.stdout.off("data", onData); reject(new Error("null reply timeout")); }, 3000);
          function onData(chunk) {
            buffer += chunk;
            for (const line of buffer.split("\n").slice(0,-1)) {
              const reply = JSON.parse(line);
              if (reply.id === null) { clearTimeout(timer); c.child.stdout.off("data", onData); resolve(reply); }
            }
          }
          c.child.stdout.on("data", onData);
        });
        c.child.stdin.write("null\n");
        assert.deepEqual((await nullReply).error, { code: -32600, message: "invalid_request" });
        assert.deepEqual((await c.rpc("ping")).result, {});
        assert.equal(c.stderr.includes(marker), false); assert.equal(c.stderr.includes(here), false);
      } finally { await c.close(); }
    }
  });
} catch (error) {
  results.push(false);
  console.error("模型 MCP 入口测试初始化失败：", error.stack);
} finally {
  if (client) await client.close();
  if (faultClient) await faultClient.close();
  if (debugClient) await debugClient.close();
  if (fault) await new Promise((resolve) => fault.close(resolve));
  await stopBackend();
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过\n`);
process.exitCode = failed ? 1 : 0;
