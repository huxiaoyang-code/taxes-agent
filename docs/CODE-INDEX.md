# 代码索引

从任务定位入口与测试；行为、规则和支持范围直接查看对应源码及工具契约。当前需求在 [Issues](https://github.com/huxiaoyang-code/youshu-fork/issues)，未完工作参见 [#76](https://github.com/huxiaoyang-code/youshu-fork/issues/76) 及相关 Issue / PR。

## 入口

- HTTP 路由：[server.mjs](../06-workbench/server/server.mjs) 的 `api`，包括 `/api/account-sets`、`/api/import/parse`、`/agent/tools/` 与 `/agent/model-tools/`；网页入口 [index.html](../06-workbench/public/index.html)、[app.js](../06-workbench/public/app.js)。
- Agent 分派：[agent-tools.mjs](../06-workbench/server/agent-tools.mjs) 的 `AGENT_TOOL_NAMES`、`callAgentTool`、`callAgentModelTool`。
- 依赖与 npm 命令：[package.json](../06-workbench/package.json)。CLI 参数见各脚本的帮助 / 参数解析；仅在明确任务与数据范围内执行。

## account-import

- 账套、凭证与导入：[accounting.mjs](../06-workbench/server/accounting.mjs) 的 `createAccountSet`、`createVoucher`、`parseImportTexts`、`validateImportPayload`、`importAccountSet`；[accounting-profiles.mjs](../06-workbench/server/accounting-profiles.mjs) 的 `getAccountingProfile`；[enterprise-identity.mjs](../06-workbench/server/enterprise-identity.mjs) 的 `normalizeEnterpriseIdentity`。
- 增量导入：[import-incremental.mjs](../06-workbench/server/import-incremental.mjs) 的 `importIncremental`；数据库与迁移：[db.mjs](../06-workbench/server/db.mjs)，科目：[coa.mjs](../06-workbench/server/coa.mjs)。
- 测试：[import-strict](../06-workbench/test/import-strict.test.mjs)、[import-incremental](../06-workbench/test/import-incremental.test.mjs)、[accounting-standard-profiles](../06-workbench/test/accounting-standard-profiles.test.mjs)、[enterprise-identity](../06-workbench/test/enterprise-identity.test.mjs)。

## money-period-assets

- 金额：[money.mjs](../06-workbench/server/money.mjs) 的 `parseMoney`、`requireCents`；期末约束：[period-end-controls.mjs](../06-workbench/server/period-end-controls.mjs) 的 `expectedDepreciationCents`、`assetCardPeriodStatus`。
- 期间与资产：[accounting.mjs](../06-workbench/server/accounting.mjs) 的 `periodEndCheck`、`setPeriodStatus`、`carryForwardProfit`、`addAssetCard`、`generateDepreciation`。
- 测试：[voucher-amount-guards](../06-workbench/test/voucher-amount-guards.test.mjs)、[accounting-period-integrity](../06-workbench/test/accounting-period-integrity.test.mjs)、[accounting-derived](../06-workbench/test/accounting-derived.test.mjs)。

## bank-auxiliary

- 银行导入 / 对账：[bank-import.mjs](../06-workbench/server/bank-import.mjs) 的 `parseBankCsv`；[bank-reconciliation.mjs](../06-workbench/server/bank-reconciliation.mjs) 的 `previewBankImport`、`confirmMatch`；CLI：[bank-reconcile.mjs](../06-workbench/scripts/bank-reconcile.mjs)。
- 辅助核算：[auxiliary-accounting.mjs](../06-workbench/server/auxiliary-accounting.mjs) 的 `auxiliaryLedger`、`replaceAuxiliaryAllocations`；CLI：[local-auxiliary.mjs](../06-workbench/scripts/local-auxiliary.mjs)。
- 测试：[bank-import](../06-workbench/test/bank-import.test.mjs)、[bank-reconciliation](../06-workbench/test/bank-reconciliation.test.mjs)、[bank-http](../06-workbench/test/bank-http.test.mjs)、[auxiliary-accounting](../06-workbench/test/auxiliary-accounting.test.mjs)、[auxiliary-model-boundary](../06-workbench/test/auxiliary-model-boundary.test.mjs)。

## reports

- 报表计算：[accounting.mjs](../06-workbench/server/accounting.mjs) 的 `trialBalance`、`balanceSheet`、`incomeStatement`、`cashFlowStatement`、`generalLedger`；口径注册：[accounting-report-rules.mjs](../06-workbench/server/accounting-report-rules.mjs)。
- 导出：[report-export.mjs](../06-workbench/server/report-export.mjs) 的 `buildReportExport`；[report-office-export.mjs](../06-workbench/server/report-office-export.mjs) 的 `buildOfficeExport`；税局格式入口：[tax-report-format.mjs](../06-workbench/server/tax-report-format.mjs) 的 `assessTaxReportReadiness`、`buildTaxReportExport`。
- 测试：[report-export](../06-workbench/test/report-export.test.mjs)、[report-office-export](../06-workbench/test/report-office-export.test.mjs)、[report-office-http](../06-workbench/test/report-office-http.test.mjs)、[tax-report-format](../06-workbench/test/tax-report-format.test.mjs)。

## materials-planning-posting

- 材料与持久化：[offline-materials.mjs](../06-workbench/server/offline-materials.mjs) 的 `preflightMaterials`；[offline-material-store.mjs](../06-workbench/server/offline-material-store.mjs) 的 `receiveMaterials`；CLI：[offline-materials](../06-workbench/scripts/offline-materials.mjs)、[offline-material-store](../06-workbench/scripts/offline-material-store.mjs)。
- 规划：[offline-task-planner.mjs](../06-workbench/server/offline-task-planner.mjs) 的 `planOffline`；[offline-action-plan.mjs](../06-workbench/server/offline-action-plan.mjs) 的 `buildOfflineActionPlan`；[offline-period-plan.mjs](../06-workbench/server/offline-period-plan.mjs) 的 `runOfflinePeriodPlan`；CLI：[offline-plan](../06-workbench/scripts/offline-plan.mjs)、[offline-action-plan](../06-workbench/scripts/offline-action-plan.mjs)、[offline-period-plan](../06-workbench/scripts/offline-period-plan.mjs)。
- 记账 / 过账：[offline-bookkeeping.mjs](../06-workbench/server/offline-bookkeeping.mjs) 的 `buildOfflineCandidates`；[offline-posting.mjs](../06-workbench/server/offline-posting.mjs) 的 `runOfflinePosting`；快照：[offline-ledger-snapshot.mjs](../06-workbench/server/offline-ledger-snapshot.mjs) 的 `captureLedgerSnapshot`；CLI：[offline-bookkeeping](../06-workbench/scripts/offline-bookkeeping.mjs)、[offline-posting](../06-workbench/scripts/offline-posting.mjs)、[offline-ledger-snapshot](../06-workbench/scripts/offline-ledger-snapshot.mjs)。
- 测试：[offline-materials](../06-workbench/test/offline-materials.test.mjs)、[offline-material-store](../06-workbench/test/offline-material-store.test.mjs)、[offline-plan](../06-workbench/test/offline-plan.test.mjs)、[offline-period-plan](../06-workbench/test/offline-period-plan.test.mjs)、[offline-posting](../06-workbench/test/offline-posting.test.mjs)、[offline-business-golden](../06-workbench/test/offline-business-golden.test.mjs)。

## vat-history-q2

- VAT 计算：[tax-calculation.mjs](../06-workbench/server/tax-calculation.mjs) 的 `calculateOfflineVat`、`calculateOfflineVatQ2`；规则入口：[tax-rule-registry.mjs](../06-workbench/server/tax-rule-registry.mjs)。
- 历史 / Q2：[offline-vat-history-context.mjs](../06-workbench/server/offline-vat-history-context.mjs) 的 `openOfflineVatPriorContext`；[offline-vat-q2.mjs](../06-workbench/server/offline-vat-q2.mjs) 的 `runOfflineVatQ2`；CLI：[offline-vat](../06-workbench/scripts/offline-vat.mjs)、[offline-vat-history](../06-workbench/scripts/offline-vat-history.mjs)、[offline-vat-pair](../06-workbench/scripts/offline-vat-pair.mjs)、[offline-vat-q2](../06-workbench/scripts/offline-vat-q2.mjs)。
- 税务适配与采集入口：[tax-gateway.mjs](../06-workbench/server/tax-gateway.mjs) 的 `TaxGateway`；[tax-api-catalog.mjs](../06-workbench/server/tax-api-catalog.mjs) 的 `CATALOG`；[tax-history-collection.mjs](../06-workbench/server/tax-history-collection.mjs) 的 `TaxHistoryCollection`。接口可用性另见 MCP 的 [tax-tools.mjs](../05-reconstruction/codex/mcp/finance-mcp/tax-tools.mjs)。
- 测试：[offline-vat](../06-workbench/test/offline-vat.test.mjs)、[offline-vat-history-context](../06-workbench/test/offline-vat-history-context.test.mjs)、[offline-vat-pair](../06-workbench/test/offline-vat-pair.test.mjs)、[offline-vat-q2](../06-workbench/test/offline-vat-q2.test.mjs)、[offline-quarterly-golden](../06-workbench/test/offline-quarterly-golden.test.mjs)、[tax-history-collection](../06-workbench/test/tax-history-collection.test.mjs)。

## review-feedback

- 复核包：[accountant-review.mjs](../06-workbench/server/accountant-review.mjs) 的 `createAccountantReview`；[accountant-review-store.mjs](../06-workbench/server/accountant-review-store.mjs) 的 `registerReview`、`recordReviewFeedback`；[accountant-review-feedback.mjs](../06-workbench/server/accountant-review-feedback.mjs) 的 `validateFeedback`；[accountant-review-q2.mjs](../06-workbench/server/accountant-review-q2.mjs) 的 `runAccountantReviewQ2`。
- CLI：[accountant-review](../06-workbench/scripts/accountant-review.mjs)、[accountant-review-feedback](../06-workbench/scripts/accountant-review-feedback.mjs)、[accountant-review-q2](../06-workbench/scripts/accountant-review-q2.mjs)。测试：[accountant-review](../06-workbench/test/accountant-review.test.mjs)、[accountant-review-feedback](../06-workbench/test/accountant-review-feedback.test.mjs)、[accountant-review-q2](../06-workbench/test/accountant-review-q2.test.mjs)。

## audit-lock-batch-backup-restore

- 审计 / 锁：[local-audit.mjs](../06-workbench/server/local-audit.mjs) 的 `serializeAuditResult`；[local-audit-operation.mjs](../06-workbench/server/local-audit-operation.mjs)；[local-write-lock.mjs](../06-workbench/server/local-write-lock.mjs) 的 `acquireWriteResources`、`withDomainWrite`。
- 批处理：[local-batch-runner.mjs](../06-workbench/server/local-batch-runner.mjs) 的 `createAndRun`、`resumeJob`；备份恢复：[local-backup.mjs](../06-workbench/server/local-backup.mjs) 的 `activateRestoreTarget`；[local-restore-control.mjs](../06-workbench/server/local-restore-control.mjs) 的 `inspectRestoreControl`。
- CLI：[local-audit](../06-workbench/scripts/local-audit.mjs)、[local-batch](../06-workbench/scripts/local-batch.mjs)、[local-backup](../06-workbench/scripts/local-backup.mjs)。测试：[local-audit](../06-workbench/test/local-audit.test.mjs)、[local-write-lock](../06-workbench/test/local-write-lock.test.mjs)、[local-batch-domain](../06-workbench/test/local-batch-domain.test.mjs)、[local-backup](../06-workbench/test/local-backup.test.mjs)、[local-restore-domain](../06-workbench/test/local-restore-domain.test.mjs)。

## model-output-boundary

- 输出策略：[finance-output-policy.mjs](../06-workbench/server/finance-output-policy.mjs) 的 `sanitizeProjection`、`summarizeQueryResult`；模型入口：[finance-model-entry.mjs](../06-workbench/server/finance-model-entry.mjs) 的 `callModelTool`、`readLocalReference`；HTTP 接线见 `server.mjs` 的 `/agent/model-tools/` 与 `/api/finance-output/read`。
- 测试：[finance-output-policy](../06-workbench/test/finance-output-policy.test.mjs)、[finance-model-entry](../06-workbench/test/finance-model-entry.test.mjs)、[finance-model-http](../06-workbench/test/finance-model-http.test.mjs)。MCP 信封：[finance-model-transport.mjs](../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs)，测试：[finance-model-transport-test](../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs)。

## mcp

- stdio 分派：[server.mjs](../05-reconstruction/codex/mcp/finance-mcp/server.mjs) 的 `callTool`、`listSkillFiles`、`readSkill`，协议入口 `tools/list`、`tools/call`、`resources/list`、`resources/read`。
- 工具契约：[tools.mjs](../05-reconstruction/codex/mcp/finance-mcp/tools.mjs) 的 `TOOLS`、`TOOL_BY_NAME`、`validateArgs`；HTTP 适配：[backend.mjs](../05-reconstruction/codex/mcp/finance-mcp/backend.mjs)；配置示例：[config.toml](../05-reconstruction/codex/config.toml)。客户端配置使用本机实际 Node / 脚本绝对路径，按需设置 `FINANCE_API_BASE`、`FINANCE_SKILLS_DIR`。
- 运行资源：[catalog.json](../05-reconstruction/catalog.json)、[skills](../05-reconstruction/codex/skills/)；通过 `skills_list` / `skills_read` 或 MCP resources 读取，Skill 相对引用保留在同目录树。`catalog.source_bundle` 是历史来源元数据。
- MCP 测试：[contract-test](../05-reconstruction/codex/mcp/finance-mcp/contract-test.mjs)、[workflow-test](../05-reconstruction/codex/mcp/finance-mcp/workflow-test.mjs)、[tax-contract-test](../05-reconstruction/codex/mcp/finance-mcp/tax-contract-test.mjs)。
- 合成旧账示例：[legacy-book](../05-reconstruction/examples/legacy-book/)；导入脚本：[import-demo.mjs](../05-reconstruction/codex/mcp/finance-mcp/import-demo.mjs)。工作台启动后，从仓库根运行 `node 05-reconstruction/codex/mcp/finance-mcp/import-demo.mjs`（会向所配置的后端写入示例账套，只用于测试后端）。
- Excel 转换：[xlsx-to-csv.py](../05-reconstruction/tools/xlsx-to-csv.py)。从仓库根运行 `python 05-reconstruction/tools/xlsx-to-csv.py --help`；示例：`python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/ --map openings=科目余额表 --map vouchers=凭证分录`。

## windows

- 运行资格与目录探针：[windows-runtime-check.mjs](../06-workbench/scripts/windows-runtime-check.mjs) 的 `decideRuntimeVersion`、`runRuntimeCheck`；发布清单 / 验收：[windows-delivery-check.mjs](../06-workbench/scripts/windows-delivery-check.mjs) 的 `inspectReleaseBundle`、`copyReleaseWhitelist`、`main`。版本条件和阶段限制直接查看这些实现与 `--help`。
- 从 `06-workbench` 运行 `node scripts/windows-runtime-check.mjs --help`、`node scripts/windows-delivery-check.mjs --help` 查看参数。
- 启动：[windows-start.ps1](../06-workbench/scripts/windows-start.ps1)。从 `06-workbench` 运行 `powershell -NoProfile -File scripts\windows-start.ps1 -NodePath <node.exe绝对路径> -DataDir <显式数据目录> -Port 0`；脚本帮助包含手工启动方法。
- 测试：[windows-delivery](../06-workbench/test/windows-delivery.test.mjs)、[windows-release-manifest](../06-workbench/test/windows-release-manifest.test.mjs)。

## tests

统一入口：[scripts/test-all.mjs](../06-workbench/scripts/test-all.mjs)，在 `06-workbench` 运行 `npm test`；单套件按索引路径使用 `node test/对应文件.test.mjs`。套件参数以统一入口为准，部分套件需要额外 Node 参数。

合成数据和独立预期保留在 [test/fixtures](../06-workbench/test/fixtures/)；测试辅助入口在 [test/helpers](../06-workbench/test/helpers/)。验证报告写实际运行结果与未验证范围，不以索引中的链接推断测试通过。
