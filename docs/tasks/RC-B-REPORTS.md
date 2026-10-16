# RC-B-REPORTS · 实施任务单

来源：总任务 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)（OPEN，assignee `xiaoyihaishiaini`）、[报表闭环方案 RC-4 / RC-5](../REPORT-CLOSURE-PLAN.md)。子 PR 用 `Refs #14`，**不因 B0 / B1 完成就 Closes #14**。
基线：`8ebc73917123b7057dec7d00f28f5651b6fd8a4a`；分支：`codex/xiaoyihaishiaini/report-exports`。

## 跨机器任务边界（补录）

- 同事在自己电脑上工作，**不依赖负责人的本机路径、worktree 或 `.agent-runs/`**；跨机器同步只走 GitHub Issue / PR + 版本化任务文档。
- 进度不退回 B0 待开工：B0 口径 / 契约与 B1 五类内部 CSV 已随 [PR #15](https://github.com/huxiaoyang-code/youshu-fork/pull/15) 合并（main `c2d5619`）；当前未完成的是 **B2 税局可上传申报文件**、**RC-3 财务流水线完整性**、**RC-6 端到端**。接续时先读 [RC-B 交接](../handoffs/RC-B-REPORTS.md)、[REPORT-EXPORT](../REPORT-EXPORT.md)、[TAX-REPORT-FORMAT](../TAX-REPORT-FORMAT.md)。
- 文件所有权：`report-export`（RC-4）与 **`tax-report-format.mjs`**（RC-5，`tax*` 规则的**模块名专属例外**）归同事 B；`tax*` 税务采集 / 登录 / 会话与 `import*` 定向导入归负责人 A；与 [团队协作协议 §6](../TEAM-COLLABORATION.md) 一致。
- 并行不矛盾：B1 / B2 的**纯模块与合成 DTO 测试可在 RC-3 完成前开发**（基于已协商 DTO）；**完整集成验收**才依赖 RC-3 / 接线。B2 在取得适用地区 / 准则 / 模板版本 / 上传格式证据前只能做前置与阻断，**拒绝输出不构成 B2 交付**。
- B0 文件范围（建议，不泛称任意 docs / test）：`docs/REPORT-INVENTORY.md`（报表现状与口径缺口事实清单）、`docs/REPORT-EXPORT-CONTRACT.md`（导出 DTO / 输出物 / 错误码契约）、**独立合成样例目录**（如 `06-workbench/test/fixtures/report-samples/` 或 `test/report-export-samples/`，仅新增样例文件，**不改共享 `scripts/test-all.mjs`**）。B0 无导出实现时**不得制造纯自证契约测试**：以**只读核对现有报表 + 独立金额样例 + 文档契约**验收，真正出口行为测试留 B1 / B2。

## 本轮授权与分工（**PR #15 历史包范围，仅限该次交付**）

> 本节与下表是 **PR #15 当时的实施记录（B0 / B1，2026-10-15）**，属历史快照；**不泛化到 B2 或任何后续任务**。后续任务（特别是 **B2**）的授权、执行者与文件独占范围**以当时派发的新任务单 / Issue 为准**，不能据本节认定员工配置或文件所有权。
> 独占表里的 `server.mjs` / `public/app.js` / `scripts/test-all.mjs` / `test/report-export-http.test.mjs` 等**仅是 PR #15 那一次交付的临时独占登记**；**不代表同事 B 长期持有**，后续 A 的任务可经任务单登记 / 协商短期所有权后使用这些共享文件。

2026-10-15 用户在本任务明确要求：直接完成需求，使用 Codex Subagent 编写代码，由主 Codex 审核、验证、提交 PR 并合并；允许配置必要开发环境。
本轮因此以 Subagent 代替旧文档要求的本地 pi / Claude Code，不调用额外模型服务，不改变其他成员的执行规则。
主 Codex 负责 Git、任务单和审核；Subagent 负责业务实现、测试和交付文档。

共享文件改动在本任务单登记（**以下为 PR #15 当次交付的临时独占登记，非长期所有权**）：

| 执行部分 | 独占文件范围 |
|---|---|
| 导出模块 | `06-workbench/server/report-export.mjs` |
| HTTP / 页面集成 | `06-workbench/server/server.mjs`、`06-workbench/public/app.js`、`06-workbench/public/index.html`、`06-workbench/scripts/test-all.mjs`、`06-workbench/test/report-export-http.test.mjs` |
| 独立验收 / 文档 | `06-workbench/test/report-export.test.mjs`、`06-workbench/README.md`、`docs/REPORT-EXPORT.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`、`docs/handoffs/RC-B-REPORTS.md`、`docs/handoffs/STATE.md`、`docs/handoffs/NEXT-SESSION.md` |
| 税局格式前置 | `06-workbench/server/tax-report-format.mjs`、`06-workbench/test/tax-report-format.test.mjs`、`docs/TAX-REPORT-FORMAT.md` |

开工时 GitHub 未见开放 PR。禁止改动 `accounting.mjs`、`coa.mjs`、`db.mjs`，不覆盖 A 的登录/数据接入工作；提交前再次核对远端。

## 交付与接口

- B0：盘点现有口径，记录独立金额样例、导出 DTO / 错误码及官方模板证据与未知项。
- B1：五类内部报表 CSV 下载，UTF-8 BOM、中文列、金额两位小数；余额表含全部科目及期间期初、本月发生、本年累计、期末；明细账按科目与期间可追溯。
- `buildReportExport(setId, {kind, period, format, code})` 返回 `{filename, contentType, body, report}`；`kind` 为 `balance-sheet`、`income-statement`、`cash-flow-statement`、`trial-balance`、`ledger`。
- HTTP：`GET /api/account-sets/:id/reports/:kind/export?period=YYYY-MM&format=csv&code=`；失败为结构化 JSON，不下载半成品。
- B2：核实官方模板来源、版本、适用准则和实际上传格式。法定结构参考与税局上传兼容分别记录；未取得真实上传规范时拒绝生成声称可申报的文件，明确 B2 尚未完成。拒绝输出本身不算 B2 交付。
- RC-3 / RC-6 的完整财务流水线、连续期间真实验收仍按原任务分工交接，不把本轮导出模块等同整个报表闭环完成。

## 验收

使用临时合成账套覆盖独立预期金额、跨月/跨年、明细科目、已过账范围、结转、现金流分类、中文 CSV 转义与公式防护、空账套、非法/未登记期间、封账可读、错误码及下载响应。
主 Codex 读取实际 diff，运行完整测试与烟雾测试，在经过验证的提交上创建 PR，检查最新 main 和合并状态后合并。
真实数据、凭据、运行库不进入模型、Git 或自动测试；不操作真实税局登录、报送、签章或缴款。

单套命令：`Push-Location 06-workbench; node test/report-export.test.mjs; Pop-Location` 或 `node test/tax-report-format.test.mjs`；全套用 `npm test`（**不要**用 `node test/*.test.mjs`：Node 只会执行首个文件，其余被当成参数，不能当全套）。B0 阶段若尚未实现导出，不得制造「纯自证契约测试」充数：通过**只读核对现有报表 + 独立金额样例 + 文档契约**验收，真正出口行为测试留 B1 / B2；允许新增样例文件，不需改共享 `scripts/test-all.mjs`。
