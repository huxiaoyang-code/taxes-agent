#!/usr/bin/env node
// 第一期全套验收。各套件使用临时数据；缺文件或子进程失败均使总入口失败。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const WORKBENCH = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP = join(WORKBENCH, "..", "05-reconstruction", "codex", "mcp", "finance-mcp");
const steps = [
  { name: "guards", file: join(WORKBENCH, "test", "accounting-guards.test.mjs"), cwd: WORKBENCH },
  { name: "derived", file: join(WORKBENCH, "test", "accounting-derived.test.mjs"), cwd: WORKBENCH },
  { name: "import-strict", file: join(WORKBENCH, "test", "import-strict.test.mjs"), cwd: WORKBENCH },
  { name: "report-export", file: join(WORKBENCH, "test", "report-export.test.mjs"), cwd: WORKBENCH },
  { name: "report-export-http", file: join(WORKBENCH, "test", "report-export-http.test.mjs"), cwd: WORKBENCH },
  { name: "tax-report-format", file: join(WORKBENCH, "test", "tax-report-format.test.mjs"), cwd: WORKBENCH },
  { name: "smoke", file: join(WORKBENCH, "test", "smoke.test.mjs"), cwd: WORKBENCH },
  { name: "contract", file: join(MCP, "contract-test.mjs"), cwd: MCP },
  { name: "workflow", file: join(MCP, "workflow-test.mjs"), cwd: MCP },
  { name: "tax", file: join(MCP, "tax-contract-test.mjs"), cwd: MCP },
  { name: "voucher-amount-guards", file: join(WORKBENCH, "test", "voucher-amount-guards.test.mjs"), cwd: WORKBENCH },
  { name: "tax-acquisition", file: join(WORKBENCH, "test", "tax-acquisition.test.mjs"), cwd: WORKBENCH },
  { name: "tax-browser-session", file: join(WORKBENCH, "test", "tax-browser-session.test.mjs"), cwd: WORKBENCH },
  { name: "tax-browser-inventory", file: join(WORKBENCH, "test", "tax-browser-inventory.test.mjs"), cwd: WORKBENCH },
  { name: "tax-browser-diagnostic", file: join(WORKBENCH, "test", "tax-browser-diagnostic.test.mjs"), cwd: WORKBENCH },
  { name: "tax-collection-observation", file: join(WORKBENCH, "test", "tax-collection-observation.test.mjs"), cwd: WORKBENCH },
  { name: "tax-live-collection-integration", file: join(WORKBENCH, "test", "tax-live-collection-integration.test.mjs"), cwd: WORKBENCH },
  { name: "tax-history-collection", file: join(WORKBENCH, "test", "tax-history-collection.test.mjs"), cwd: WORKBENCH },
  { name: "tax-filing-period", file: join(WORKBENCH, "test", "tax-filing-period.test.mjs"), cwd: WORKBENCH },
  { name: "tax-collection-recovery", file: join(WORKBENCH, "test", "tax-collection-recovery.test.mjs"), cwd: WORKBENCH },
  { name: "tax-readonly-abandon", file: join(WORKBENCH, "test", "tax-readonly-abandon.test.mjs"), cwd: WORKBENCH },
  { name: "tax-readonly-abandon-guard", file: join(WORKBENCH, "test", "tax-readonly-abandon-guard.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-static", file: join(WORKBENCH, "test", "tax-download-static.test.mjs"), cwd: WORKBENCH, nodeArgs: ["--expose-internals"] },
  { name: "tax-download-contract-shape", file: join(WORKBENCH, "test", "tax-download-contract-shape.test.mjs"), cwd: WORKBENCH, nodeArgs: ["--expose-internals"] },
  { name: "tax-download-menu", file: join(WORKBENCH, "test", "tax-download-menu.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-navigation", file: join(WORKBENCH, "test", "tax-download-navigation.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-retirement", file: join(WORKBENCH, "test", "tax-download-retirement.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-page", file: join(WORKBENCH, "test", "tax-download-page.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-page-cli", file: join(WORKBENCH, "test", "tax-download-page-cli.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-snapshot", file: join(WORKBENCH, "test", "tax-download-snapshot.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-financial-passive", file: join(WORKBENCH, "test", "tax-download-financial-passive.test.mjs"), cwd: WORKBENCH },
  { name: "tax-download-invoice-observer", file: join(WORKBENCH, "test", "tax-download-invoice-observer.test.mjs"), cwd: WORKBENCH },
  { name: "observe-tax-navigation-cleanup", file: join(WORKBENCH, "test", "observe-tax-navigation-cleanup.test.mjs"), cwd: WORKBENCH },
  { name: "tax-navigation-recovery-chain", file: join(WORKBENCH, "test", "tax-navigation-recovery-chain.test.mjs"), cwd: WORKBENCH },
  { name: "tax-portal-bootstrap", file: join(WORKBENCH, "test", "tax-portal-bootstrap.test.mjs"), cwd: WORKBENCH },
  { name: "tax-live-collection-mcp", file: join(MCP, "tax-live-collection-test.mjs"), cwd: MCP },
  { name: "tax-history-mcp", file: join(MCP, "tax-history-test.mjs"), cwd: MCP },
  { name: "tax-browser-session-mcp", file: join(MCP, "tax-browser-session-test.mjs"), cwd: MCP },
  { name: "tax-preparation", file: join(WORKBENCH, "test", "tax-preparation.test.mjs"), cwd: WORKBENCH },
  { name: "tax-api-catalog", file: join(WORKBENCH, "test", "tax-api-catalog.test.mjs"), cwd: WORKBENCH },
  { name: "tax-api-catalog-http", file: join(WORKBENCH, "test", "tax-api-catalog-http.test.mjs"), cwd: WORKBENCH },
  { name: "tax-api-catalog-mcp", file: join(MCP, "tax-api-catalog-test.mjs"), cwd: MCP },
  { name: "tax-acquisition-mcp", file: join(MCP, "tax-acquisition-test.mjs"), cwd: MCP },
  { name: "server-local-boundary", file: join(WORKBENCH, "test", "server-local-boundary.test.mjs"), cwd: WORKBENCH },
  // LOCAL-01 增量导入：领域层 + HTTP / Agent 真实入口 + MCP 真实链路（仅追加）
  { name: "import-incremental", file: join(WORKBENCH, "test", "import-incremental.test.mjs"), cwd: WORKBENCH },
  { name: "import-incremental-http", file: join(WORKBENCH, "test", "import-incremental-http.test.mjs"), cwd: WORKBENCH },
  { name: "import-incremental-mcp", file: join(MCP, "import-incremental-test.mjs"), cwd: MCP },
  // LOCAL-02 金额精度 / 期末完整性 / 连续期间：领域 + HTTP/Agent + MCP 真实链路（仅追加）
  { name: "accounting-period-integrity", file: join(WORKBENCH, "test", "accounting-period-integrity.test.mjs"), cwd: WORKBENCH },
  { name: "accounting-period-http", file: join(WORKBENCH, "test", "accounting-period-http.test.mjs"), cwd: WORKBENCH },
  { name: "accounting-period-mcp", file: join(MCP, "accounting-period-test.mjs"), cwd: MCP },
  // LOCAL-06 / LOCAL-05 / LOCAL-08 已合入模块的自身套件（仅追加，不改上方原有 50 个套件的内容与顺序）
  { name: "local-backup", file: join(WORKBENCH, "test", "local-backup.test.mjs"), cwd: WORKBENCH },
  { name: "finance-output-policy", file: join(WORKBENCH, "test", "finance-output-policy.test.mjs"), cwd: WORKBENCH },
  { name: "report-office-export", file: join(WORKBENCH, "test", "report-office-export.test.mjs"), cwd: WORKBENCH },
  // LOCAL-08 PR57 已合入的适配层 / 出站信封校验自身套件（仅追加，不改上方原有 53 个套件的内容与顺序）
  { name: "finance-model-adapter", file: join(WORKBENCH, "test", "finance-model-adapter.test.mjs"), cwd: WORKBENCH },
  { name: "finance-model-transport-mcp", file: join(MCP, "finance-model-transport-test.mjs"), cwd: MCP },
  // LOCAL-05 接线（真实 Office HTTP 套件；仅末尾追加，不改上方原有 55 个套件的内容与顺序）
  { name: "report-office-http", file: join(WORKBENCH, "test", "report-office-http.test.mjs"), cwd: WORKBENCH },
];
const results = [];
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  if (!existsSync(step.file)) {
    console.error(`缺少必需测试文件：${step.file}`);
    results.push({ name: step.name, status: 1 });
    continue;
  }
  const r = spawnSync(process.execPath, [...(step.nodeArgs || []), step.file], { stdio: "inherit", cwd: step.cwd });
  if (r.error) console.error(`启动失败：${r.error.message}`);
  results.push({ name: step.name, status: r.status ?? 1 });
}
console.log("\n=== 汇总 ===");
for (const r of results) console.log(`${r.status === 0 ? "✓" : "✗"} ${r.name} — exit=${r.status}`);
const failed = results.filter((r) => r.status !== 0).length;
const passed = results.length - failed;
console.log(failed ? `${failed} 个套件未通过` : `全部 ${results.length} 个套件通过（${passed}/${results.length}）`);
process.exitCode = failed ? 1 : 0;
