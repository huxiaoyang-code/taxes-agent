#!/usr/bin/env node
// 第一期全套验收。各套件使用临时数据；缺文件或子进程失败均使总入口失败。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const WORKBENCH = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP = join(WORKBENCH, "..", "05-reconstruction", "codex", "mcp", "finance-mcp");
const steps = [
  { name: 'harness2-boundary', file: join(WORKBENCH, 'test', 'harness2-boundary.test.mjs'), cwd: WORKBENCH },
  { name: 'harness2-budget', file: join(WORKBENCH, 'test', 'harness2-budget.test.mjs'), cwd: WORKBENCH },
  { name: 'harness2-hosts', file: join(WORKBENCH, 'test', 'harness2-hosts.test.mjs'), cwd: WORKBENCH },
  { name: 'harness2-research-mcp', file: join(WORKBENCH, 'test', 'harness2-research-mcp.test.mjs'), cwd: WORKBENCH },
  { name: 'harness2-recovery', file: join(WORKBENCH, 'test', 'harness2-recovery.test.mjs'), cwd: WORKBENCH },
  { name: 'harness2-launcher', file: join(WORKBENCH, 'test', 'harness2-launcher.test.mjs'), cwd: WORKBENCH },
  { name: 'finance-host-config', file: join(WORKBENCH, 'test', 'finance-host-config.test.mjs'), cwd: WORKBENCH },
  { name: 'host-dsh', file: join(WORKBENCH, 'test', 'host-dsh.test.mjs'), cwd: WORKBENCH },
  { name: 'host-zcode', file: join(WORKBENCH, 'test', 'host-zcode.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-tool-engineering', file: join(WORKBENCH, 'test', 'harness-tool-engineering.test.mjs'), cwd: WORKBENCH },
  { name: 'comprehensive-analysis', file: join(WORKBENCH, 'test', 'comprehensive-analysis.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-contract', file: join(WORKBENCH, 'test', 'harness-contract.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-lifecycle', file: join(WORKBENCH, 'test', 'harness-lifecycle.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-mcp', file: join(MCP, 'harness-test.mjs'), cwd: WORKBENCH },
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
  // LOCAL-08 入口接线（Agent 组装层 / 真实 HTTP / MCP 端到端；仅末尾追加，不改上方原有 56 个套件的内容与顺序）
  { name: "finance-model-entry", file: join(WORKBENCH, "test", "finance-model-entry.test.mjs"), cwd: WORKBENCH },
  { name: "finance-model-http", file: join(WORKBENCH, "test", "finance-model-http.test.mjs"), cwd: WORKBENCH },
  { name: "finance-model-entry-mcp", file: join(MCP, "finance-model-entry-test.mjs"), cwd: MCP },
  // LOCAL-07 B1 已合 PR65 的持久化与 CLI 套件；仅末尾追加，原 59 套完整保留。
  { name: "local-batch-persistence", file: join(WORKBENCH, "test", "local-batch-persistence.test.mjs"), cwd: WORKBENCH },
  { name: "local-batch-cli", file: join(WORKBENCH, "test", "local-batch-cli.test.mjs"), cwd: WORKBENCH },
  // LOCAL-04 银行组件；仅末尾追加，原 main 61 套逐字原序保留。
  { name: "bank-import", file: join(WORKBENCH, "test", "bank-import.test.mjs"), cwd: WORKBENCH },
  { name: "bank-reconciliation", file: join(WORKBENCH, "test", "bank-reconciliation.test.mjs"), cwd: WORKBENCH },
  { name: "bank-reconcile-cli", file: join(WORKBENCH, "test", "bank-reconcile-cli.test.mjs"), cwd: WORKBENCH },
  { name: "local-bank-backup-integration", file: join(WORKBENCH, "test", "local-bank-backup-integration.test.mjs"), cwd: WORKBENCH },
  // LOCAL-03 双准则与显式企业身份；仅末尾追加，原 main 65 套逐字原序保留。
  { name: "accounting-standard-profiles", file: join(WORKBENCH, "test", "accounting-standard-profiles.test.mjs"), cwd: WORKBENCH },
  { name: "accounting-standards", file: join(WORKBENCH, "test", "accounting-standards.test.mjs"), cwd: WORKBENCH },
  { name: "accounting-standards-migration", file: join(WORKBENCH, "test", "accounting-standards-migration.test.mjs"), cwd: WORKBENCH },
  { name: "enterprise-identity", file: join(WORKBENCH, "test", "enterprise-identity.test.mjs"), cwd: WORKBENCH },
  { name: "enterprise-identity-http", file: join(WORKBENCH, "test", "enterprise-identity-http.test.mjs"), cwd: WORKBENCH },
  { name: "enterprise-identity-mcp", file: join(MCP, "enterprise-identity-test.mjs"), cwd: MCP },
  { name: "accounting-standards-http", file: join(WORKBENCH, "test", "accounting-standards-http.test.mjs"), cwd: WORKBENCH },
  { name: "accounting-standards-mcp", file: join(MCP, "accounting-standards-test.mjs"), cwd: MCP },
  // LOCAL-03b: append only; original 73 suites retain their exact order.
  { name: "auxiliary-storage", file: join(WORKBENCH, "test", "auxiliary-storage.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-accounting", file: join(WORKBENCH, "test", "auxiliary-accounting.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-cli", file: join(WORKBENCH, "test", "auxiliary-cli.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-core-integration", file: join(WORKBENCH, "test", "auxiliary-core-integration.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-backup-integration", file: join(WORKBENCH, "test", "auxiliary-backup-integration.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-bank-integration", file: join(WORKBENCH, "test", "auxiliary-bank-integration.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-import", file: join(WORKBENCH, "test", "auxiliary-import.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-http", file: join(WORKBENCH, "test", "auxiliary-http.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-model-boundary", file: join(WORKBENCH, "test", "auxiliary-model-boundary.test.mjs"), cwd: WORKBENCH },
  { name: "auxiliary-mcp", file: join(MCP, "auxiliary-test.mjs"), cwd: MCP },
  { name: "local-bank-aux-integration", file: join(WORKBENCH, "test", "local-bank-aux-integration.test.mjs"), cwd: WORKBENCH },
  { name: "bank-local-drafts", file: join(WORKBENCH, "test", "bank-local-drafts.test.mjs"), cwd: WORKBENCH },
  { name: "bank-http", file: join(WORKBENCH, "test", "bank-http.test.mjs"), cwd: WORKBENCH },
  { name: "bank-ui-contract", file: join(WORKBENCH, "test", "bank-ui-contract.test.mjs"), cwd: WORKBENCH },
  { name: "bank-mcp", file: join(MCP, "bank-test.mjs"), cwd: MCP },
  // LOCAL06 W2a: original 88 entries remain verbatim and in order.
  { name: "local-audit-operation", file: join(WORKBENCH, "test", "local-audit-operation.test.mjs"), cwd: WORKBENCH },
  { name: "local-audit-install", file: join(WORKBENCH, "test", "local-audit-install.test.mjs"), cwd: WORKBENCH },
  { name: "local-audit-backup-integration", file: join(WORKBENCH, "test", "local-audit-backup-integration.test.mjs"), cwd: WORKBENCH },
  // LOCAL07 W3a: original 91 entries remain verbatim and in order.
  { name: "local-batch-install", file: join(WORKBENCH, "test", "local-batch-install.test.mjs"), cwd: WORKBENCH },
  { name: "local-batch-backup-integration", file: join(WORKBENCH, "test", "local-batch-backup-integration.test.mjs"), cwd: WORKBENCH },
  // LOCAL06 W2b: the preceding 93 entries are unchanged and retain their order.
  { name: "local-audit-domain", file: join(WORKBENCH, "test", "local-audit-domain.test.mjs"), cwd: WORKBENCH },
  { name: "local-audit-http", file: join(WORKBENCH, "test", "local-audit-http.test.mjs"), cwd: WORKBENCH },
  { name: "local-audit-cli", file: join(WORKBENCH, "test", "local-audit-cli.test.mjs"), cwd: WORKBENCH },
  { name: "local-audit-mcp", file: join(MCP, "local-audit-test.mjs"), cwd: MCP },
  // LOCAL07 W3b: preceding 97 registrations remain verbatim and in order.
  { name: "local-batch-domain", file: join(WORKBENCH, "test", "local-batch-domain.test.mjs"), cwd: WORKBENCH },
  { name: "local-write-lock", file: join(WORKBENCH, "test", "local-write-lock.test.mjs"), cwd: WORKBENCH },
  { name: "local-batch-entry-lock", file: join(WORKBENCH, "test", "local-batch-entry-lock.test.mjs"), cwd: WORKBENCH },
  { name: "seed-demo-lock", file: join(WORKBENCH, "test", "seed-demo-lock.test.mjs"), cwd: WORKBENCH },
  { name: "local-restore-domain", file: join(WORKBENCH, "test", "local-restore-domain.test.mjs"), cwd: WORKBENCH },
  { name: "local-restore-reconcile", file: join(WORKBENCH, "test", "local-restore-reconcile.test.mjs"), cwd: WORKBENCH },
  { name: "local-restore-open-guard", file: join(WORKBENCH, "test", "local-restore-open-guard.test.mjs"), cwd: WORKBENCH },
  { name: "local-restore-audit", file: join(WORKBENCH, "test", "local-restore-audit.test.mjs"), cwd: WORKBENCH },
  { name: "local-restore-batch", file: join(WORKBENCH, "test", "local-restore-batch.test.mjs"), cwd: WORKBENCH },
  { name: "local-restore-path-binding", file: join(WORKBENCH, "test", "local-restore-path-binding.test.mjs"), cwd: WORKBENCH },
  { name: 'annual-close', file: join(WORKBENCH, 'test', 'annual-close.test.mjs'), cwd: WORKBENCH },
  { name: 'annual-close-harness', file: join(WORKBENCH, 'test', 'annual-close-harness.test.mjs'), cwd: WORKBENCH },
  { name: 'period-business', file: join(WORKBENCH, 'test', 'period-business.test.mjs'), cwd: WORKBENCH },
  { name: 'period-batch', file: join(WORKBENCH, 'test', 'period-batch.test.mjs'), cwd: WORKBENCH },
  { name: 'period-interruption', file: join(WORKBENCH, 'test', 'period-interruption.test.mjs'), cwd: WORKBENCH },
  { name: 'period-proof', file: join(WORKBENCH, 'test', 'period-proof.test.mjs'), cwd: WORKBENCH },
  { name: 'period-correction-dates', file: join(WORKBENCH, 'test', 'period-correction-dates.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-disclosure', file: join(WORKBENCH, 'test', 'harness-disclosure.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-batch-partial-effects', file: join(WORKBENCH, 'test', 'harness-batch-partial-effects.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-tax-presentation', file: join(WORKBENCH, 'test', 'harness-tax-presentation.test.mjs'), cwd: WORKBENCH },
  { name: 'harness-local-tool-contract', file: join(WORKBENCH, 'test', 'harness-local-tool-contract.test.mjs'), cwd: WORKBENCH },
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
