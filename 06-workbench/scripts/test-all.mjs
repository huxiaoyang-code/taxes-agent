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
  { name: "smoke", file: join(WORKBENCH, "test", "smoke.test.mjs"), cwd: WORKBENCH },
  { name: "contract", file: join(MCP, "contract-test.mjs"), cwd: MCP },
  { name: "workflow", file: join(MCP, "workflow-test.mjs"), cwd: MCP },
  { name: "tax", file: join(MCP, "tax-contract-test.mjs"), cwd: MCP },
];
const results = [];
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  if (!existsSync(step.file)) {
    console.error(`缺少必需测试文件：${step.file}`);
    results.push({ name: step.name, status: 1 });
    continue;
  }
  const r = spawnSync(process.execPath, [step.file], { stdio: "inherit", cwd: step.cwd });
  if (r.error) console.error(`启动失败：${r.error.message}`);
  results.push({ name: step.name, status: r.status ?? 1 });
}
console.log("\n=== 汇总 ===");
for (const r of results) console.log(`${r.status === 0 ? "✓" : "✗"} ${r.name} — exit=${r.status}`);
const failed = results.filter((r) => r.status !== 0).length;
const passed = results.length - failed;
console.log(failed ? `${failed} 个套件未通过` : `全部 ${results.length} 个套件通过（${passed}/${results.length}）`);
process.exitCode = failed ? 1 : 0;
