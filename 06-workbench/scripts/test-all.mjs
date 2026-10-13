#!/usr/bin/env node
/**
 * test-all.mjs — 第一阶段（PHASE 1）全套回归入口
 *
 * 顺序运行：
 *   1. guards   记账守卫（期初/封账/期间）     06-workbench/test/accounting-guards.test.mjs
 *   2. derived  派生报表/结转/折旧             06-workbench/test/accounting-derived.test.mjs
 *   3. smoke    工作台端到端（原 npm test）     06-workbench/test/smoke.test.mjs
 *   4. contract MCP ↔ HTTP 契约                05-reconstruction/codex/mcp/finance-mcp/contract-test.mjs
 *   5. workflow MCP 临时账套闭环验收            05-reconstruction/codex/mcp/finance-mcp/workflow-test.mjs
 *   6. tax      税务网关契约（另一 PR 合并后自动纳入，未合并时明确跳过）
 *
 * 约定：用 process.execPath 启动、spawnSync 继承 stdio、退出码向总入口传播。
 * 不安装 npm 依赖、不访问网络。各子测试自建临时数据库与临时端口。
 *
 * 运行：node scripts/test-all.mjs   （在 06-workbench 目录，或 npm test）
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));      // 06-workbench/scripts
const WORKBENCH = join(here, "..");                        // 06-workbench
const REPO = join(WORKBENCH, "..");                        // 仓库根
const MCP = join(REPO, "05-reconstruction", "codex", "mcp", "finance-mcp");

const steps = [
  { name: "guards（记账守卫：期初/封账/期间）", file: join(WORKBENCH, "test", "accounting-guards.test.mjs"), cwd: WORKBENCH },
  { name: "derived（派生报表/结转/折旧一致性）", file: join(WORKBENCH, "test", "accounting-derived.test.mjs"), cwd: WORKBENCH },
  { name: "smoke（工作台端到端）", file: join(WORKBENCH, "test", "smoke.test.mjs"), cwd: WORKBENCH },
  { name: "contract（MCP↔HTTP 契约）", file: join(MCP, "contract-test.mjs"), cwd: MCP },
  { name: "workflow（MCP 临时账套闭环验收）", file: join(MCP, "workflow-test.mjs"), cwd: MCP },
];

const TAX_TEST = join(MCP, "tax-contract-test.mjs");

const results = [];
let missing = [];

for (const step of steps) {
  console.log(`\n==================== ${step.name} ====================`);
  if (!existsSync(step.file)) {
    console.log(`  ! 未找到测试文件：${step.file}`);
    missing.push(step.name);
    results.push({ name: step.name, status: null });
    continue;
  }
  const r = spawnSync(process.execPath, [step.file], { stdio: "inherit", cwd: step.cwd });
  const status = r.status ?? (r.signal ? 128 : 1);
  if (r.error) console.error(`  ! 启动失败：${r.error.message}`);
  results.push({ name: step.name, status });
}

// 税务契约由另一部分（TAX）交付；未合并时如实跳过，绝不计为通过。
console.log("\n==================== tax（税务网关契约） ====================");
let taxSkipped = false;
if (existsSync(TAX_TEST)) {
  const r = spawnSync(process.execPath, [TAX_TEST], { stdio: "inherit", cwd: MCP });
  const status = r.status ?? (r.signal ? 128 : 1);
  if (r.error) console.error(`  ! 启动失败：${r.error.message}`);
  results.push({ name: "tax（税务网关契约）", status });
} else {
  taxSkipped = true;
  console.log("  尚未合并：未找到 05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs。");
  console.log("  本步骤明确跳过，不计入通过；TAX PR 合并后重跑本入口即会自动执行。");
}

// ---------------------------------------------------------------- 汇总
console.log("\n==================== 汇总 ====================");
for (const r of results) {
  const mark = r.status === null ? "!" : r.status === 0 ? "✓" : "✗";
  const detail = r.status === null ? "缺少文件" : r.status === 0 ? "通过" : `失败（exit=${r.status}）`;
  console.log(`  ${mark} ${r.name} — ${detail}`);
}
if (taxSkipped) console.log("  · tax（税务网关契约） — 跳过（尚未合并）");
if (missing.length) console.log(`  ! 缺少测试文件：${missing.join("、")}`);

const failed = results.filter((r) => r.status !== 0).length;
if (failed) {
  console.log(`\n${failed} 个步骤未通过\n`);
} else if (taxSkipped) {
  console.log("\n已执行步骤通过；税务契约未执行（尚未合并），非全套验收。\n");
} else {
  console.log("\n全部步骤通过\n");
}
process.exitCode = failed ? 1 : 0;
