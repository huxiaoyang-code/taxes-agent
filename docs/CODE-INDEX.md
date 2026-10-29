# 代码索引

从任务定位入口与测试；行为、规则和支持范围直接查看对应源码及工具契约。当前需求在 [Issues](https://github.com/huxiaoyang-code/taxes-agent/issues)，未完工作参见 [#76](https://github.com/huxiaoyang-code/taxes-agent/issues/76) 及相关 Issue / PR。

## 入口

- HTTP 路由：[server.mjs](../06-workbench/server/server.mjs) 的 `api`，包括 `/api/account-sets`、`/api/import/parse`、`/agent/tools/` 与 `/agent/model-tools/`；网页入口 [index.html](../06-workbench/public/index.html)、[app.js](../06-workbench/public/app.js)。
- Agent 分派：[agent-tools.mjs](../06-workbench/server/agent-tools.mjs) 的 `AGENT_TOOL_NAMES`、`callAgentTool`、`callAgentModelTool`。
- 依赖与 npm 命令：[package.json](../06-workbench/package.json)。CLI 参数见各脚本的帮助 / 参数解析；仅在明确任务与数据范围内执行。

## account-import

- Codex 顾问技能：[taxes-company-advisor/SKILL.md](../05-reconstruction/codex/skills/taxes-company-advisor/SKILL.md)，[同事安装与使用](COMPANY-ADVISOR-SKILL.md)。按需组织陌生企业接手、历史整理、疑点复核和税费/税后现金方案；复用下列执行入口，不新增工具或计算支持。
- Codex 首次接手、整理和迁入历史账务：[legacy-book-import/SKILL.md](../05-reconstruction/codex/skills/legacy-book-import/SKILL.md)，[内部导入格式及create/append边界](../05-reconstruction/codex/skills/legacy-book-import/references/import-rules.md)。优先稳定企业/来源/批次的增量导入；原件、派生输入与正式账务分别保存，核对真实目标后转入 Harness 持续核算。没有统一接管包自动验收入口。
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

## agency-rules

- 规则 Wiki 与按需导航：[AGENCY-RULES.md](AGENCY-RULES.md)；统一登记/来源/修订/候选政策：[agency-rule-catalog.mjs](../06-workbench/server/agency-rule-catalog.mjs)，地区参数：[agency-regional-rules.mjs](../06-workbench/server/agency-regional-rules.mjs)。
- 原件与底稿/实际规则匹配：[agency-business.mjs](../06-workbench/server/agency-business.mjs) 的 `loadAgencyMaterials`、`buildAgencyWorkpaper`、`matchAgencyRules`；会计/成本重放：[agency-business-rules.mjs](../06-workbench/server/agency-business-rules.mjs)，税费：[agency-tax-rules.mjs](../06-workbench/server/agency-tax-rules.mjs)、[agency-extended-tax-rules.mjs](../06-workbench/server/agency-extended-tax-rules.mjs)。
- 目录/详情/匹配和本机政策维护 CLI：[agency-business.mjs](../06-workbench/scripts/agency-business.mjs)；测试：[agency-business](../06-workbench/test/agency-business.test.mjs)。`finance-capability/1` 仍复用三项 agency 能力；候选登记不自动激活、不执行申报缴费。

## vat-history-q2

- VAT 计算：[tax-calculation.mjs](../06-workbench/server/tax-calculation.mjs) 的 `calculateOfflineVat`、`calculateOfflineVatQ2`；规则入口：[tax-rule-registry.mjs](../06-workbench/server/tax-rule-registry.mjs)。
- 历史 / Q2：[offline-vat-history-context.mjs](../06-workbench/server/offline-vat-history-context.mjs) 的 `openOfflineVatPriorContext`；[offline-vat-q2.mjs](../06-workbench/server/offline-vat-q2.mjs) 的 `runOfflineVatQ2`；CLI：[offline-vat](../06-workbench/scripts/offline-vat.mjs)、[offline-vat-history](../06-workbench/scripts/offline-vat-history.mjs)、[offline-vat-pair](../06-workbench/scripts/offline-vat-pair.mjs)、[offline-vat-q2](../06-workbench/scripts/offline-vat-q2.mjs)。
- 税务适配与采集入口：[tax-gateway.mjs](../06-workbench/server/tax-gateway.mjs) 的 `TaxGateway`；[tax-api-catalog.mjs](../06-workbench/server/tax-api-catalog.mjs) 的 `CATALOG`；[tax-history-collection.mjs](../06-workbench/server/tax-history-collection.mjs) 的 `TaxHistoryCollection`。接口可用性另见 MCP 的 [tax-tools.mjs](../05-reconstruction/codex/mcp/finance-mcp/tax-tools.mjs)。
- 测试：[offline-vat](../06-workbench/test/offline-vat.test.mjs)、[offline-vat-history-context](../06-workbench/test/offline-vat-history-context.test.mjs)、[offline-vat-pair](../06-workbench/test/offline-vat-pair.test.mjs)、[offline-vat-q2](../06-workbench/test/offline-vat-q2.test.mjs)、[offline-quarterly-golden](../06-workbench/test/offline-quarterly-golden.test.mjs)、[tax-history-collection](../06-workbench/test/tax-history-collection.test.mjs)。

## review-feedback

- 复核包：[accountant-review.mjs](../06-workbench/server/accountant-review.mjs) 的 `createAccountantReview`；[accountant-review-store.mjs](../06-workbench/server/accountant-review-store.mjs) 的 `registerReview`、`recordReviewFeedback`；[accountant-review-feedback.mjs](../06-workbench/server/accountant-review-feedback.mjs) 的 `validateFeedback`；[accountant-review-q2.mjs](../06-workbench/server/accountant-review-q2.mjs) 的 `runAccountantReviewQ2`。
- CLI：[accountant-review](../06-workbench/scripts/accountant-review.mjs)、[accountant-review-feedback](../06-workbench/scripts/accountant-review-feedback.mjs)、[accountant-review-q2](../06-workbench/scripts/accountant-review-q2.mjs)。测试：[accountant-review](../06-workbench/test/accountant-review.test.mjs)、[accountant-review-feedback](../06-workbench/test/accountant-review-feedback.test.mjs)、[accountant-review-q2](../06-workbench/test/accountant-review-q2.test.mjs)。

## comprehensive-analysis

- 可选月度综合分析：`analysis.comprehensive`，固定只读实现 [comprehensive-analysis.mjs](../06-workbench/server/comprehensive-analysis.mjs)，步骤提示词、输入及一期边界见 [Harness 综合分析指引](../05-reconstruction/codex/skills/harness/references/analysis.md)。复用原生多期账表、原件税费底稿、来源/任务/复核与失效机制，不新增 MCP 工具；规划限条件性应收回收，税费影响和税后现金未支持。实际 stdio/临时合成验证 [comprehensive-analysis.test.mjs](../06-workbench/test/comprehensive-analysis.test.mjs)。

## annual-close

- 年度 Skill：[annual-close/SKILL.md](../05-reconstruction/codex/skills/annual-close/SKILL.md)，官方改编来源与 Apache-2.0 许可保留在同目录。只读证据适配：[annual-close.mjs](../06-workbench/server/annual-close.mjs)，复用实际年累计报表、期末检查与账簿能力，不复制所得税或账务公式。
- 通过 Harness MCP 工具发现/计划/执行 `annual.inspect`（year scope、只读）。年度税会计算使用已发布 `agency.annual-calculation`，以实际任务版本与跨 Store 依赖绑定历史、年度核对与次年任务；执行、会计复核和全年业务完成分别列示。缺件、未实现调整或未审定事项保留未完成。
- 合成验证：在 `06-workbench` 运行 `node test/annual-close.test.mjs`（独立全年/历史金额及更正/辅助分配失效）与 `node test/annual-close-harness.test.mjs`（真实 stdio MCP＋原生 Harness 联调，脚本不构成 Agent 验收）。后者的 `prepare <全新绝对目录>` 仅生成合成既有账簿、全年原件/manifest、scope/target、独立手算与 goal.txt，不调用 Harness 或模型；可供另一 Agent 逐步通过 MCP 独立验收并记录剩余限制。

## audit-lock-batch-backup-restore

- 审计 / 锁：[local-audit.mjs](../06-workbench/server/local-audit.mjs) 的 `serializeAuditResult`；[local-audit-operation.mjs](../06-workbench/server/local-audit-operation.mjs)；[local-write-lock.mjs](../06-workbench/server/local-write-lock.mjs) 的 `acquireWriteResources`、`withDomainWrite`。
- 批处理：[local-batch-runner.mjs](../06-workbench/server/local-batch-runner.mjs) 的 `createAndRun`、`resumeJob`；备份恢复：[local-backup.mjs](../06-workbench/server/local-backup.mjs) 的 `activateRestoreTarget`；[local-restore-control.mjs](../06-workbench/server/local-restore-control.mjs) 的 `inspectRestoreControl`。
- CLI：[local-audit](../06-workbench/scripts/local-audit.mjs)、[local-batch](../06-workbench/scripts/local-batch.mjs)、[local-backup](../06-workbench/scripts/local-backup.mjs)。测试：[local-audit](../06-workbench/test/local-audit.test.mjs)、[local-write-lock](../06-workbench/test/local-write-lock.test.mjs)、[local-batch-domain](../06-workbench/test/local-batch-domain.test.mjs)、[local-backup](../06-workbench/test/local-backup.test.mjs)、[local-restore-domain](../06-workbench/test/local-restore-domain.test.mjs)。

## model-output-boundary

- 输出策略：[finance-output-policy.mjs](../06-workbench/server/finance-output-policy.mjs) 的 `sanitizeProjection`、`summarizeQueryResult`；模型入口：[finance-model-entry.mjs](../06-workbench/server/finance-model-entry.mjs) 的 `callModelTool`、`readLocalReference`；HTTP 接线见 `server.mjs` 的 `/agent/model-tools/` 与 `/api/finance-output/read`。
- 测试：[finance-output-policy](../06-workbench/test/finance-output-policy.test.mjs)、[finance-model-entry](../06-workbench/test/finance-model-entry.test.mjs)、[finance-model-http](../06-workbench/test/finance-model-http.test.mjs)。MCP 信封：[finance-model-transport.mjs](../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs)，测试：[finance-model-transport-test](../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport-test.mjs)。

## mcp

- 可选 Google Research Harness²：[设计与运行](HARNESS2-INTEGRATION.md)、[Python BenchmarkAdapter/Substrate](../05-reconstruction/codex/harness2/finance_adapter.py)、[Codex优化器](../05-reconstruction/codex/harness2/codex_proposer.py)、[本人Codex外层worker](../05-reconstruction/codex/harness2/codex-proposer-worker.mjs)、[Linux候选namespace](../05-reconstruction/codex/harness2/sandbox.py)、[仅执行模型relay](../05-reconstruction/codex/harness2/budget-gateway.mjs)、[Node桥](../05-reconstruction/codex/harness2/bridge.mjs)。研究入口 [harness2-run.mjs](../06-workbench/scripts/harness2-run.mjs) 与 [harness2-google.py](../06-workbench/scripts/harness2-google.py)。Codex负责优化，Pi＋DS等宿主执行；本人认证/default model与执行账本分开。Node合同/worker/relay回归登记在统一测试入口；真实Google核心、原生探针、模拟传输和真实完整循环按运行文档分别验证。

- 多宿主：[Pi、Claude Code、dsh、ZCode 主 Agent 统一入口](../05-reconstruction/codex/hosts/START-HERE.md)，[接入与实测范围](../05-reconstruction/codex/hosts/README.md)，配置生成入口 [finance-host-config.mjs](../06-workbench/scripts/finance-host-config.mjs)（`--host pi|claude-code|dsh|zcode`），共享验证 [finance-host-config.test.mjs](../06-workbench/test/finance-host-config.test.mjs)。显式 `FINANCE_MCP_PROFILE=harness` 由 [tool-profile.mjs](../05-reconstruction/codex/mcp/finance-mcp/tool-profile.mjs)限定列表与直接调用；未设置时兼容既有工具面。配置生成、宿主无模型连接和业务验收分别记录。

- Harness：共享声明契约 [harness-contract.mjs](../06-workbench/server/harness-contract.mjs)，固定业务注册 [harness-adapters.mjs](../06-workbench/server/harness-adapters.mjs)，生命周期 [harness-runtime.mjs](../06-workbench/server/harness-runtime.mjs)、元数据证据日志 [harness-store.mjs](../06-workbench/server/harness-store.mjs)。企业特例调用现有审计 accounting API，批处理复用既有 runner；均显式绑定本机目标。
- 代账接线：复用 [agency-business.mjs](../06-workbench/server/agency-business.mjs) 的 getAgencyCapabilities、buildAgencyWorkpaper、prepare/execute/queryAgencyPosting 与 buildAgencyAnnualWorkpaper，经既有 Harness domain worker 隔离目标，原生人审材料和 archive 身份恢复；年度计算不是年度关账。集中增量验证：`node test/harness-lifecycle.test.mjs --agency-capabilities`，使用独立合成原件/临时库。
- Harness MCP 工具：[tools.mjs](../05-reconstruction/codex/mcp/finance-mcp/tools.mjs)；渐进式入口 [harness/SKILL.md](../05-reconstruction/codex/skills/harness/SKILL.md)。pi 1.1.0 原生 MCP 与禁止递归的解析委派扩展 [finance-harness.ts](../05-reconstruction/codex/pi/finance-harness.ts)。其他宿主仍使用标准 stdio。
- 工具工程与依据：[HARNESS-TOOL-DESIGN.md](HARNESS-TOOL-DESIGN.md)；共享可执行能力合同：[harness-input-contracts.mjs](../06-workbench/server/harness-input-contracts.mjs)，递归校验：[harness-schema-validation.mjs](../06-workbench/server/harness-schema-validation.mjs)。显式 requestFactId、返回 factBindings、轻量领域/查询/分页目录的合成回归：`node test/harness-tool-engineering.test.mjs`。批次原生效果三态投影与缺反馈恢复：`node test/harness-batch-partial-effects.test.mjs`（真实三凭证、原审计事件、MCP 摘要/完整回执）。
- 渐进披露：[disclosure-contracts.mjs](../05-reconstruction/codex/mcp/finance-mcp/disclosure-contracts.mjs) 提供选中能力的 schema/最小示例/恢复；[receipt-presentation.mjs](../05-reconstruction/codex/mcp/finance-mcp/receipt-presentation.mjs) 同时压缩 MCP text/structuredContent、完整保存并按 receiptRef/pointer 分页。显式 responseMode=full 兼容原生对象。事实证据：[harness-fact-evidence.mjs](../06-workbench/server/harness-fact-evidence.mjs)，关键地区/缴款值的 MCP 边界：[manifest-evidence-guard.mjs](../05-reconstruction/codex/mcp/finance-mcp/manifest-evidence-guard.mjs)。旧 sourceRefs-only 调用仍标未验证，直接原生API不受该MCP guard约束；精确值绑定也不保证语义理解。
- 合成披露/事实/恢复回归：`node test/harness-disclosure.test.mjs`（工作目录06-workbench）；税额口径与详情导航回归：`node test/harness-tax-presentation.test.mjs`；本地工具输入合同回归：`node test/harness-local-tool-contract.test.mjs`。真实 pi 验收准备与固定条件日志：[harness-disclosure-acceptance.mjs](../06-workbench/scripts/harness-disclosure-acceptance.mjs) 的 prepare/supplement/correct/recover/run；准备不调用模型，run仅使用本人已授权官方DeepSeek环境变量，记录实际源码/资料哈希及text/structured体积，人工介入和无效源码调查待验收者实际审查，不能按调用次数直接判通过。
- Harness 验证：[harness-contract](../06-workbench/test/harness-contract.test.mjs)、[harness-lifecycle](../06-workbench/test/harness-lifecycle.test.mjs)、[harness-mcp](../05-reconstruction/codex/mcp/finance-mcp/harness-test.mjs)。[Pi 原生主 Agent 启动](../05-reconstruction/codex/hosts/pi/README.md)、[既有 Pi 扩展](../05-reconstruction/codex/pi/README.md)、[无模型原生MCP探针](../06-workbench/scripts/harness-pi-probe.mjs)。陌生合成资料演示准备：从 `06-workbench` 运行 `node scripts/harness-demo.mjs prepare <全新绝对目录>`；此命令不调用模型，也不构成 Agent 演示。按[统一入口的分层检验](../05-reconstruction/codex/hosts/START-HERE.md#6-首次检验先合成元数据再扩大业务范围)，获当次测试授权后运行实际选定宿主并保留模型/MCP/解析与业务回执；`assess` 仅核查真实账务结果。解析委派是否等价需单独核实。

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
