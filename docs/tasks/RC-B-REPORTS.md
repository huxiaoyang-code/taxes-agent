# RC-B-REPORTS · 实施任务单

来源：[Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)、[报表闭环方案 RC-4 / RC-5](../REPORT-CLOSURE-PLAN.md)。
基线：`8ebc73917123b7057dec7d00f28f5651b6fd8a4a`；分支：`codex/xiaoyihaishiaini/report-exports`。

## 本轮授权与分工

2026-10-15 用户在本任务明确要求：直接完成需求，使用 Codex Subagent 编写代码，由主 Codex 审核、验证、提交 PR 并合并；允许配置必要开发环境。
本轮因此以 Subagent 代替旧文档要求的本地 pi / Claude Code，不调用额外模型服务，不改变其他成员的执行规则。
主 Codex 负责 Git、任务单和审核；Subagent 负责业务实现、测试和交付文档。

共享文件改动在本任务单登记：

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
