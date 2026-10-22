#!/usr/bin/env node
/**
 * LOCAL-01 增量导入 HTTP / Agent 真实入口回归。
 *
 * 全部使用临时数据目录 + PORT=0 随机回环端口，每个用例都在新建的临时目录上跑，
 * 不连接任何既有后端 / 真实账套库；重启场景用「同一数据目录 + 新进程」验证批次识别。
 *
 * 运行：node test/import-incremental-http.test.mjs（在 06-workbench 目录）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server", "server.mjs");

const results = [];
const testAsync = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const SOURCE = { system: "local-book", enterpriseKey: "91350000HTTP0001X", enterpriseName: "HTTP 合成公司" };
const meta = (over = {}) => ({
  name: "HTTP 合成公司", taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则",
  start_period: "2026-01", ...over,
});
const payloadJan = () => ({
  account_set: meta(),
  opening_balances: [{ code: "1002", debit: 50000, credit: 0 }, { code: "3001", debit: 0, credit: 50000 }],
  vouchers: [{
    period: "2026-01", date: "2026-01-08", word: "记", number: 1, summary: "销售商品",
    sourceVoucherId: "HTTP-SRC-0001",
    entries: [
      { code: "1122", debit: 11300, credit: 0 },
      { code: "5001", debit: 0, credit: 10000 },
      { code: "2221", debit: 0, credit: 1300 },
    ],
  }],
});
const payloadFeb = () => ({
  account_set: meta(),
  vouchers: [{
    period: "2026-02", date: "2026-02-09", word: "记", number: 1, summary: "收回货款",
    sourceVoucherId: "HTTP-SRC-0002",
    entries: [{ code: "1002", debit: 11300, credit: 0 }, { code: "1122", debit: 0, credit: 11300 }],
  }],
});
const payloadMarOtherSource = () => ({
  account_set: meta(),
  vouchers: [{
    period: "2026-03", date: "2026-03-05", word: "记", number: 1, summary: "另一来源补充",
    sourceVoucherId: "HTTP-OTHER-0001",
    entries: [{ code: "5602", debit: 50, credit: 0 }, { code: "1002", debit: 0, credit: 50 }],
  }],
});
let httpSetId = null;

/** 启动一个隔离后端：新临时目录 + PORT=0，端口从子进程 stdout 读取。 */
async function startServer(dataDir) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", WORKBENCH_DATA_DIR: dataDir },
  });
  child.stderr.on("data", (d) => process.stderr.write(`[http] ${d}`));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server_not_ready_timeout")), 15000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server_exited_before_ready code=${code}`)); });
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = /127\.0\.0\.1:(\d+)\//.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await exited;
  };
  return { child, base, api, stop };
}

try {
  console.log("\nLOCAL-01 增量导入 HTTP / Agent 真实入口回归\n");

  const dataDir = mkdtempSync(join(tmpdir(), "wb-inc-http-"));
  let server = null;
  try {
    server = await startServer(dataDir);

    // ---------------- HTTP /api/import/incremental ----------------
    await testAsync("HTTP 预检：默认 dryRun=true，200，不建账套", async () => {
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-01", source: SOURCE, payload: payloadJan(),
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.status, "preview");
      assert.equal(r.data.dryRun, true);
      assert.equal(r.data.ok, true);
      const sets = await server.api("GET", "/api/account-sets");
      assert.deepEqual(sets.data, [], "预检不得创建账套");
    });

    await testAsync("HTTP 正式导入：201 applied，账套 / 凭证 / 批次 / 来源追踪可查", async () => {
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-01", source: SOURCE, payload: payloadJan(), dryRun: false,
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.status, "applied");
      assert.equal(r.data.created.accountSetCreated, true);
      assert.equal(r.data.created.vouchersCreated, 1);
      const setId = r.data.created.accountSetId;
      assert.ok(setId > 0);
      httpSetId = setId;

      const sets = await server.api("GET", "/api/account-sets");
      assert.equal(sets.data.length, 1);
      const vouchers = await server.api("GET", `/api/account-sets/${setId}/vouchers?period=2026-01`);
      assert.equal(vouchers.data.length, 1);
      assert.equal(vouchers.data[0].status, "posted");

      const batch = await server.api("GET", "/api/import/batches/HTTP-2026-01");
      assert.equal(batch.status, 200);
      assert.equal(batch.data.batch.status, "completed");
      assert.equal(batch.data.voucherCount, 1);
      assert.equal(batch.data.sourceTrace[0].sourceVoucherId, "HTTP-SRC-0001");
    });

    await testAsync("HTTP 同批重试：200 idempotent_replay，不新增凭证", async () => {
      const before = await server.api("GET", "/api/account-sets");
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-01", source: SOURCE, payload: payloadJan(), dryRun: false,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.status, "idempotent_replay");
      assert.equal(r.data.created.vouchersCreated, 0);
      const setId = before.data[0].id;
      const vouchers = await server.api("GET", `/api/account-sets/${setId}/vouchers`);
      assert.equal(vouchers.data.length, 1, "重试不得新增凭证");
      const after = await server.api("GET", "/api/account-sets");
      assert.equal(after.data.length, before.data.length);
    });

    await testAsync("HTTP 追加：mode=append 写入第二个月，账套数不变", async () => {
      const sets = await server.api("GET", "/api/account-sets");
      const setId = sets.data[0].id;
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-02", source: SOURCE, mode: "append", accountSetId: setId,
        payload: payloadFeb(), dryRun: false,
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.created.accountSetCreated, false);
      assert.equal(r.data.created.vouchersCreated, 1);
      const after = await server.api("GET", "/api/account-sets");
      assert.equal(after.data.length, sets.data.length);
      const tb = await server.api("GET", `/api/account-sets/${setId}/reports/trial-balance?period=2026-02`);
      assert.equal(tb.status, 200);
      // 1002 = 50000 + 11300；1122 = 11300 - 11300 = 0
      const line1002 = tb.data.lines.find((l) => l.code === "1002");
      assert.equal(line1002.closing_debit, 61300);
    });

    await testAsync("HTTP 内容修订冲突：409 + 结构化 conflicts，不覆盖既有凭证", async () => {
      const sets = await server.api("GET", "/api/account-sets");
      const setId = sets.data[0].id;
      const revised = payloadFeb();
      revised.vouchers[0].entries = [{ code: "1002", debit: 999, credit: 0 }, { code: "1122", debit: 0, credit: 999 }];
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-02-revise", source: SOURCE, mode: "append", accountSetId: setId,
        payload: revised, dryRun: false,
      });
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.status, "conflict");
      assert.ok(r.data.conflicts.some((c) => c.code === "source_voucher_content_changed"),
        JSON.stringify(r.data.conflicts));
      const vouchers = await server.api("GET", `/api/account-sets/${setId}/vouchers?period=2026-02`);
      assert.equal(vouchers.data.length, 1);
      assert.equal(vouchers.data[0].entries.find((e) => e.code === "1002").debit, 11300);
    });

    await testAsync("HTTP 参数 / 校验失败：400 结构化 errors", async () => {
      const missing = await server.api("POST", "/api/import/incremental", { payload: payloadJan() });
      assert.equal(missing.status, 400);
      assert.equal(missing.data.status, "rejected");
      assert.ok(missing.data.errors.join().includes("batchId"), JSON.stringify(missing.data.errors));

      const badAmount = payloadJan();
      badAmount.vouchers[0].entries[0].debit = "abc";
      badAmount.vouchers[0].entries[1].credit = "abc";
      const rejected = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-bad", source: SOURCE, payload: badAmount, dryRun: false,
      });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.validation.ok, false);
      assert.ok(rejected.data.errors.some((e) => e.includes("金额")));
    });

    await testAsync("HTTP 目标账套不存在：404", async () => {
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-missing", source: SOURCE, mode: "append", accountSetId: 99999, payload: payloadFeb(),
      });
      assert.equal(r.status, 404, JSON.stringify(r.data));
      assert.equal(r.data.error, "account_set_not_found");
    });

    await testAsync("HTTP 未知批次：404", async () => {
      const r = await server.api("GET", "/api/import/batches/no-such-batch");
      assert.equal(r.status, 404);
      assert.equal(r.data.error, "batch_not_found");
    });

    // ---------------- Agent 工具入口 ----------------
    await testAsync("Agent book_import_incremental：默认 dryRun=true，缺参数报结构化错误", async () => {
      const dry = await server.api("POST", "/agent/tools/book_import_incremental", {
        batchId: "AGENT-2026-01", source: { ...SOURCE, enterpriseKey: "91350000AGENT001X" },
        payload: { account_set: meta({ name: "Agent 合成公司" }), vouchers: [] },
      });
      assert.equal(dry.status, 200, JSON.stringify(dry.data));
      assert.equal(dry.data.status, "preview");
      const sets = await server.api("GET", "/api/account-sets");
      assert.equal(sets.data.length, 1, "Agent 默认预检不得建账套");

      const missing = await server.api("POST", "/agent/tools/book_import_incremental", {
        payload: { account_set: meta({ name: "Agent 合成公司" }), vouchers: [] },
      });
      assert.equal(missing.status, 400);
      assert.equal(missing.data.error, "import_validation_failed");
    });

    await testAsync("Agent book_import_incremental：正式导入 + 冲突返回 import_conflict", async () => {
      const source = { system: "local-book", enterpriseKey: "91350000AGENT001X", enterpriseName: "Agent 合成公司" };
      const applied = await server.api("POST", "/agent/tools/book_import_incremental", {
        batchId: "AGENT-2026-01", source,
        payload: { account_set: meta({ name: "Agent 合成公司" }), vouchers: [] }, dryRun: false,
      });
      assert.equal(applied.status, 200, JSON.stringify(applied.data));
      assert.equal(applied.data.status, "applied");
      const agentSetId = applied.data.created.accountSetId;

      // 已绑定企业重复建账 → 结构化冲突（Agent 层是 400 + import_conflict + details.conflicts）
      const conflict = await server.api("POST", "/agent/tools/book_import_incremental", {
        batchId: "AGENT-2026-01-dup", source,
        payload: { account_set: meta({ name: "Agent 合成公司" }), vouchers: [] }, dryRun: false,
      });
      assert.equal(conflict.status, 400);
      assert.equal(conflict.data.error, "import_conflict");
      assert.ok(conflict.data.details.conflicts.some((c) => c.code === "enterprise_already_bound"),
        JSON.stringify(conflict.data.details));

      const batch = await server.api("POST", "/agent/tools/book_import_batch", { batchId: "AGENT-2026-01" });
      assert.equal(batch.status, 200);
      assert.equal(batch.data.batch.accountSetId, agentSetId);
      assert.equal(batch.data.batch.status, "completed");
    });

    await testAsync("Agent legacy_book_import 旧入口保持默认预检且不写身份记录", async () => {
      const legacy = await server.api("POST", "/agent/tools/legacy_book_import", {
        payload: {
          account_set: meta({ name: "Agent 旧接口公司" }),
          opening_balances: [{ code: "1002", debit: 10, credit: 0 }, { code: "3001", debit: 0, credit: 10 }],
        },
      });
      assert.equal(legacy.status, 200);
      assert.equal(legacy.data.dryRun, true);
      assert.equal(legacy.data.created, null);

      const formal = await server.api("POST", "/agent/tools/legacy_book_import", {
        payload: {
          account_set: meta({ name: "Agent 旧接口公司" }),
          opening_balances: [{ code: "1002", debit: 10, credit: 0 }, { code: "3001", debit: 0, credit: 10 }],
        },
        dryRun: false,
      });
      assert.equal(formal.status, 200, JSON.stringify(formal.data));
      assert.equal(formal.data.dryRun, false);
      assert.equal(formal.data.created.name, "Agent 旧接口公司");
    });

    await testAsync("HTTP 跨来源同一企业：create 409 引导到已有账套，不新建第二本", async () => {
      const before = await server.api("GET", "/api/account-sets");
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-other-src-create", source: { system: "other-book", enterpriseKey: SOURCE.enterpriseKey },
        payload: payloadJan(), dryRun: false,
      });
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.status, "conflict");
      const c = r.data.conflicts.find((x) => x.code === "enterprise_already_bound");
      assert.ok(c, JSON.stringify(r.data.conflicts));
      assert.equal(c.accountSetId, httpSetId, "必须引导到已有账套");
      const after = await server.api("GET", "/api/account-sets");
      assert.equal(after.data.length, before.data.length, "不得新建第二本账套");
    });

    await testAsync("HTTP 跨来源同一企业：确认来源证据后追加到同一账套，账套数不变", async () => {
      const before = await server.api("GET", "/api/account-sets");
      const other = { system: "other-book", enterpriseKey: SOURCE.enterpriseKey, enterpriseName: "HTTP 合成公司" };
      const noConfirm = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-other-src-append", source: other, mode: "append", accountSetId: httpSetId,
        payload: payloadMarOtherSource(), dryRun: false,
      });
      assert.equal(noConfirm.status, 409, JSON.stringify(noConfirm.data));
      assert.ok(noConfirm.data.conflicts.some((c) => c.code === "account_set_binding_confirmation_required"),
        JSON.stringify(noConfirm.data.conflicts));

      const applied = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-other-src-append", source: other, mode: "append", accountSetId: httpSetId,
        payload: payloadMarOtherSource(), confirmNewBinding: true, dryRun: false,
      });
      assert.equal(applied.status, 201, JSON.stringify(applied.data));
      assert.equal(applied.data.status, "applied");
      assert.equal(applied.data.created.accountSetCreated, false);
      assert.equal(applied.data.created.vouchersCreated, 1);
      const after = await server.api("GET", "/api/account-sets");
      assert.equal(after.data.length, before.data.length);
    });

    await testAsync("HTTP 反过账后批次回放 409 结构化冲突，已完成批次保持 completed", async () => {
      const vouchers = await server.api("GET", `/api/account-sets/${httpSetId}/vouchers?period=2026-02`);
      const vid = vouchers.data[0].id;
      const unpost = await server.api("POST", `/api/account-sets/${httpSetId}/vouchers/${vid}/unpost`);
      assert.equal(unpost.status, 200, JSON.stringify(unpost.data));

      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-02", source: SOURCE, mode: "append", accountSetId: httpSetId,
        payload: payloadFeb(), dryRun: false,
      });
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.ok(r.data.conflicts.some((c) => c.code === "source_voucher_voucher_unposted"),
        JSON.stringify(r.data.conflicts));
      const batch = await server.api("GET", "/api/import/batches/HTTP-2026-02");
      assert.equal(batch.data.batch.status, "completed", "失败不得覆写已完成批次");
      assert.equal(batch.data.sourceTrace[0].state, "unposted");

      const repost = await server.api("POST", `/api/account-sets/${httpSetId}/vouchers/${vid}/post`);
      assert.equal(repost.status, 200, JSON.stringify(repost.data));
      const replay = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-02", source: SOURCE, mode: "append", accountSetId: httpSetId,
        payload: payloadFeb(), dryRun: false,
      });
      assert.equal(replay.status, 200, JSON.stringify(replay.data));
      assert.equal(replay.data.status, "idempotent_replay");
    });

    await testAsync("Agent 跨来源同一企业：import_conflict 引导到已有账套，不新建第二本", async () => {
      const before = await server.api("GET", "/api/account-sets");
      const r = await server.api("POST", "/agent/tools/book_import_incremental", {
        batchId: "AGENT-other-src",
        source: { system: "other-book", enterpriseKey: "91350000AGENT001X" },
        payload: { account_set: meta({ name: "Agent 合成公司" }), vouchers: [] }, dryRun: false,
      });
      assert.equal(r.status, 400, JSON.stringify(r.data));
      assert.equal(r.data.error, "import_conflict");
      const c = r.data.details.conflicts.find((x) => x.code === "enterprise_already_bound");
      assert.ok(c, JSON.stringify(r.data.details.conflicts));
      assert.ok(c.accountSetId > 0, "必须返回已有账套 ID");
      const after = await server.api("GET", "/api/account-sets");
      assert.equal(after.data.length, before.data.length);
    });

    // ---------------- 重启后批次识别 ----------------
    const setsBefore = await server.api("GET", "/api/account-sets");
    const setId = setsBefore.data.find((s) => s.name === "HTTP 合成公司").id;
    const vouchersBefore = await server.api("GET", `/api/account-sets/${setId}/vouchers`);
    await server.stop();
    server = null;

    await testAsync("重启后：同批重试仍识别为 idempotent_replay，账套 / 凭证不增加", async () => {
      server = await startServer(dataDir);
      const sets = await server.api("GET", "/api/account-sets");
      assert.equal(sets.data.length, setsBefore.data.length, "重启后账套数不变");
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-2026-01", source: SOURCE, payload: payloadJan(), dryRun: false,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.status, "idempotent_replay");
      assert.equal(r.data.created.vouchersCreated, 0);
      const vouchers = await server.api("GET", `/api/account-sets/${setId}/vouchers`);
      assert.equal(vouchers.data.length, vouchersBefore.data.length, "重启后重试不得新增凭证");
      const batch = await server.api("GET", "/api/import/batches/HTTP-2026-01");
      assert.equal(batch.status, 200);
      assert.equal(batch.data.batch.status, "completed");
    });

    await testAsync("重启后：已封账期间仍被拒绝（状态持久，不因重启失效）", async () => {
      // LOCAL-02 封账前置：先把本期损益结转到 3103，再封账（与实际业务顺序一致）。
      const carry = await server.api("POST", `/api/account-sets/${setId}/carry-forward`, { period: "2026-01" });
      assert.equal(carry.status, 201, JSON.stringify(carry.data));
      const close = await server.api("POST", `/api/account-sets/${setId}/periods`, { period: "2026-01", status: "closed" });
      assert.equal(close.status, 200, JSON.stringify(close.data));
      const r = await server.api("POST", "/api/import/incremental", {
        batchId: "HTTP-closed", source: SOURCE, mode: "append", accountSetId: setId,
        payload: {
          account_set: meta(),
          vouchers: [{
            period: "2026-01", date: "2026-01-30", word: "记", number: 9, summary: "封账后补记",
            sourceVoucherId: "HTTP-SRC-CLOSED",
            entries: [{ code: "5602", debit: 100, credit: 0 }, { code: "1002", debit: 0, credit: 100 }],
          }],
        },
        dryRun: false,
      });
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.ok(r.data.conflicts.some((c) => c.code === "period_closed"), JSON.stringify(r.data.conflicts));
    });

    await testAsync("HTTP 旧入口 /api/import/account-set 未受影响（默认预检 / 显式落库）", async () => {
      const texts = {
        meta: "键,值\n账套名称,HTTP 旧接口公司\n纳税人性质,小规模纳税人\n会计准则,小企业会计准则\n启用期间,2026-01\n",
        openings: "科目编码,借方,贷方\n1002,100,0\n3001,0,100\n",
        vouchers: "",
        accounts: "",
      };
      const parsed = await server.api("POST", "/api/import/parse", { texts });
      assert.equal(parsed.data.validation.ok, true, JSON.stringify(parsed.data.validation.errors));
      const dry = await server.api("POST", "/api/import/account-set", { payload: parsed.data.payload });
      assert.equal(dry.status, 201);
      assert.equal(dry.data.dryRun, true);
      assert.equal(dry.data.created, null);
      const formal = await server.api("POST", "/api/import/account-set", { payload: parsed.data.payload, dryRun: false });
      assert.equal(formal.status, 201);
      assert.equal(formal.data.created.name, "HTTP 旧接口公司");
    });

    // ---------------- 第二轮独审回归：空账套期初 / 自动取号 / 跨批逐张追踪 ----------------
    const httpCash = (amount) => [
      { code: "5602", debit: amount, credit: 0 },
      { code: "1002", debit: 0, credit: amount },
    ];
    const httpMeta = (name) => ({
      name, taxpayer_type: "小规模纳税人", accounting_standard: "小企业会计准则", start_period: "2026-01",
    });

    await testAsync("HTTP 空账套首次追加期初：account_set_create 后 append+确认绑定 applied，同批重试与重启后仍 replay", async () => {
      const dir = mkdtempSync(join(tmpdir(), "wb-inc-http-empty-"));
      let srv = null;
      try {
        srv = await startServer(dir);
        const created = await srv.api("POST", "/agent/tools/account_set_create", {
          name: "HTTP 填空公司", start_period: "2026-01",
        });
        assert.equal(created.status, 200, JSON.stringify(created.data));
        const setId = created.data.id;
        assert.ok(setId > 0);
        const before = await srv.api("GET", `/api/account-sets/${setId}/opening-balances`);
        assert.deepEqual(before.data, [], "新建空账套应无期初");

        const source = { system: "local-book", enterpriseKey: "91350000HTTPEMPTY1X", enterpriseName: "HTTP 填空公司" };
        const args = {
          batchId: "HTTP-EMPTY-2026-01", source, mode: "append", accountSetId: setId,
          confirmNewBinding: true, dryRun: false,
          payload: {
            account_set: httpMeta("HTTP 填空公司"),
            opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
            vouchers: [],
          },
        };
        const first = await srv.api("POST", "/api/import/incremental", args);
        assert.equal(first.status, 201, JSON.stringify(first.data));
        assert.equal(first.data.status, "applied");
        assert.equal(first.data.created.openingBalancesApplied, 2);

        const retry = await srv.api("POST", "/api/import/incremental", args);
        assert.equal(retry.status, 200, JSON.stringify(retry.data));
        assert.equal(retry.data.status, "idempotent_replay");

        // 重启（同一数据目录、新进程）：同批重试仍然是只读回放，期初不变。
        await srv.stop(); srv = null;
        srv = await startServer(dir);
        const replay = await srv.api("POST", "/api/import/incremental", args);
        assert.equal(replay.status, 200, JSON.stringify(replay.data));
        assert.equal(replay.data.status, "idempotent_replay");
        assert.equal(replay.data.created.openingBalancesApplied, 0);
        const openings = await srv.api("GET", `/api/account-sets/${setId}/opening-balances`);
        assert.deepEqual(openings.data.map((o) => [o.code, o.debit, o.credit]),
          [["1002", 100, 0], ["3001", 0, 100]]);
        const sets = await srv.api("GET", "/api/account-sets");
        assert.equal(sets.data.length, 1, "不得新建第二个账套");
      } finally {
        if (srv) await srv.stop();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await testAsync("HTTP 自动取号 + 显式编号混用：预检公布号码，落库 1 / 2 不重号", async () => {
      const dir = mkdtempSync(join(tmpdir(), "wb-inc-http-auto-"));
      let srv = null;
      try {
        srv = await startServer(dir);
        const source = { system: "local-book", enterpriseKey: "91350000HTTPAUTO01X", enterpriseName: "HTTP 自动号公司" };
        const payload = () => ({
          account_set: httpMeta("HTTP 自动号公司"),
          vouchers: [
            { period: "2026-01", date: "2026-01-05", word: "记", summary: "自动取号",
              sourceVoucherId: "HTTP-AUTO-1", entries: httpCash(10) },
            { period: "2026-01", date: "2026-01-06", word: "记", number: 1, summary: "显式取号",
              sourceVoucherId: "HTTP-EXPLICIT-1", entries: httpCash(20) },
          ],
        });
        const preview = await srv.api("POST", "/api/import/incremental", {
          batchId: "HTTP-AUTO-01", source, payload: payload(),
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.data));
        const plan = new Map(preview.data.planned.voucherNumbers.map((n) => [n.sourceVoucherId, n.number]));
        assert.equal(plan.get("HTTP-EXPLICIT-1"), 1);
        assert.equal(plan.get("HTTP-AUTO-1"), 2, "自动取号必须跳过本批显式号");

        const applied = await srv.api("POST", "/api/import/incremental", {
          batchId: "HTTP-AUTO-01", source, payload: payload(), dryRun: false,
        });
        assert.equal(applied.status, 201, JSON.stringify(applied.data));
        const setId = applied.data.created.accountSetId;
        const vouchers = await srv.api("GET", `/api/account-sets/${setId}/vouchers?period=2026-01`);
        assert.deepEqual(vouchers.data.map((v) => `${v.word}-${v.number}`).sort(), ["记-1", "记-2"]);
        const batch = await srv.api("GET", "/api/import/batches/HTTP-AUTO-01");
        assert.deepEqual(batch.data.sourceTrace.map((t) => [t.sourceVoucherId, t.action, t.status]),
          [["HTTP-AUTO-1", "created", "created"], ["HTTP-EXPLICIT-1", "created", "created"]]);
        assert.deepEqual(applied.data.sourceTrace, batch.data.sourceTrace,
          "新建批次首调 applied 与批次查询的逐张 DTO 必须一致");
      } finally {
        if (srv) await srv.stop();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await testAsync("HTTP 跨批去重逐张追踪：去重批次查询 / 回放一致，重启后仍可恢复", async () => {
      const dir = mkdtempSync(join(tmpdir(), "wb-inc-http-track-"));
      let srv = null;
      try {
        srv = await startServer(dir);
        const source = { system: "local-book", enterpriseKey: "91350000HTTPTRACK1X", enterpriseName: "HTTP 追踪公司" };
        const v1 = {
          period: "2026-01", date: "2026-01-05", word: "记", number: 1, summary: "追踪 V1",
          sourceVoucherId: "HTTP-TRACK-V1", entries: httpCash(10),
        };
        const created = await srv.api("POST", "/api/import/incremental", {
          batchId: "HTTP-TRACE-A", source, dryRun: false,
          payload: { account_set: httpMeta("HTTP 追踪公司"), vouchers: [v1] },
        });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        const setId = created.data.created.accountSetId;
        const v1VoucherId = created.data.sourceTrace[0].voucherId;

        const dedupeArgs = {
          batchId: "HTTP-TRACE-B", source, mode: "append", accountSetId: setId, dryRun: false,
          payload: { account_set: httpMeta("HTTP 追踪公司"), vouchers: [v1] },
        };
        const dedupe = await srv.api("POST", "/api/import/incremental", dedupeArgs);
        assert.equal(dedupe.status, 201, JSON.stringify(dedupe.data));
        assert.equal(dedupe.data.created.vouchersCreated, 0);
        assert.equal(dedupe.data.created.vouchersDeduplicated, 1);

        const queried = await srv.api("GET", "/api/import/batches/HTTP-TRACE-B");
        assert.equal(queried.data.voucherCount, 1, "去重批次也必须保留逐张追踪");
        assert.equal(queried.data.sourceTrace[0].sourceVoucherId, "HTTP-TRACK-V1");
        assert.equal(queried.data.sourceTrace[0].status, "deduplicated");
        assert.equal(queried.data.sourceTrace[0].voucherId, v1VoucherId);
        assert.deepEqual(dedupe.data.sourceTrace, queried.data.sourceTrace,
          "纯去重批次首调 applied 与批次查询的逐张 DTO 必须一致（含 action / state）");

        await srv.stop(); srv = null;
        srv = await startServer(dir);
        const afterRestart = await srv.api("GET", "/api/import/batches/HTTP-TRACE-B");
        assert.equal(afterRestart.data.voucherCount, 1, "重启后逐张关联必须仍在");
        assert.equal(afterRestart.data.sourceTrace[0].status, "deduplicated");
        const replay = await srv.api("POST", "/api/import/incremental", dedupeArgs);
        assert.equal(replay.status, 200, JSON.stringify(replay.data));
        assert.equal(replay.data.status, "idempotent_replay");
        assert.deepEqual(replay.data.sourceTrace, afterRestart.data.sourceTrace);
        const vouchers = await srv.api("GET", `/api/account-sets/${setId}/vouchers`);
        assert.equal(vouchers.data.length, 1, "重启后回放不得新增凭证");
      } finally {
        if (srv) await srv.stop();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
    await testAsync("HTTP create 仅期初：合法 API 改期初后同批回放 409，恢复并重启后回放 200", async () => {
      const dir = mkdtempSync(join(tmpdir(), "wb-inc-http-create-open-"));
      let srv = null;
      try {
        srv = await startServer(dir);
        const source = { system: "local-book", enterpriseKey: "91350000HTTPCREATEOPEN1X", enterpriseName: "HTTP 建账期初公司" };
        const payload = () => ({
          account_set: httpMeta("HTTP 建账期初公司"),
          opening_balances: [{ code: "1002", debit: 100, credit: 0 }, { code: "3001", debit: 0, credit: 100 }],
          vouchers: [],
        });
        const args = { batchId: "HTTP-CREATE-OPEN", source, payload: payload(), dryRun: false };

        const applied = await srv.api("POST", "/api/import/incremental", args);
        assert.equal(applied.status, 201, JSON.stringify(applied.data));
        assert.equal(applied.data.status, "applied");
        assert.equal(applied.data.created.accountSetCreated, true);
        assert.equal(applied.data.created.openingBalancesApplied, 2);
        const setId = applied.data.created.accountSetId;

        const unchanged = await srv.api("POST", "/api/import/incremental", args);
        assert.equal(unchanged.status, 200, JSON.stringify(unchanged.data));
        assert.equal(unchanged.data.status, "idempotent_replay");

        // 合法 API 改期初（空账套、无凭证）：同批回放必须识别库内状态不一致，而不是继续伪报完成。
        const changed = await srv.api("PUT", `/api/account-sets/${setId}/opening-balances`, {
          items: [{ code: "1002", debit: 200, credit: 0 }, { code: "3001", debit: 0, credit: 200 }],
        });
        assert.equal(changed.status, 200, JSON.stringify(changed.data));
        const conflict = await srv.api("POST", "/api/import/incremental", args);
        assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
        assert.equal(conflict.data.status, "conflict");
        const c = conflict.data.conflicts.find((x) => x.code === "batch_replay_state_incomplete");
        assert.ok(c, JSON.stringify(conflict.data.conflicts));
        assert.equal(c.reason, "opening_balances_mismatch");
        assert.equal(c.accountSetId, setId);

        const restore = await srv.api("PUT", `/api/account-sets/${setId}/opening-balances`, {
          items: payload().opening_balances,
        });
        assert.equal(restore.status, 200, JSON.stringify(restore.data));

        // 重启（同一数据目录、新进程）：未改期初的同批回放仍是只读幂等。
        await srv.stop(); srv = null;
        srv = await startServer(dir);
        const replay = await srv.api("POST", "/api/import/incremental", args);
        assert.equal(replay.status, 200, JSON.stringify(replay.data));
        assert.equal(replay.data.status, "idempotent_replay");
        assert.equal(replay.data.created.openingBalancesApplied, 0);
        const openings = await srv.api("GET", `/api/account-sets/${setId}/opening-balances`);
        assert.deepEqual(openings.data.map((o) => [o.code, o.debit, o.credit]),
          [["1002", 100, 0], ["3001", 0, 100]]);
        const sets = await srv.api("GET", "/api/account-sets");
        assert.equal(sets.data.length, 1, "不得新建第二个账套");
      } finally {
        if (srv) await srv.stop();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  } finally {
    if (server) await server.stop();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("测试初始化失败：", e);
  process.exitCode = 1;
}
