# OFFLINE-02：资料完整度及规划（Issue #79）

负责人 huxiaoyang-code。A片 base `a004bd889554c091318e5e017a93ec575581cf5e`（#78A / PR88 已合），branch `codex/huxiaoyang-code/offline-02-plan`。本片为 **#79A 实施候选，待管理者独立验证、全新独审与 PR**，不关闭 #79。

本轮明确授权唯一实施 subagent 使用当前会话模型，旧实施因额度停止后仅恢复现有成果；禁止再委派、pi/Claude/TokenHub/其它模型执行器；不提交/推送/合并。root 负责 Git、独立验证；最终审查者未参与实现并使用新上下文。该授权覆盖旧本地执行器要求，不修改全局技能。

允许8文件：新增 `06-workbench/server/material-completeness.mjs`、`server/offline-task-planner.mjs`、`server/customer-data-request.mjs`、`scripts/offline-plan.mjs`、`test/offline-plan.test.mjs`、`docs/OFFLINE-PLAN.md`、本任务单；更新 `docs/handoffs/OFFLINE-CLOSELOOP.md`。不改 STATE/NEXT-SESSION、test-all/package、数据库、accounting/batch/audit/锁或 #78 实现。共享核心由 #54 W2b 窗口持有。

目标是显式 planning-input JSON → 本机 #78 rawContent 重放 → 完整度矩阵 → 解释性准备 DAG → 可转发中文补件文本 → previousPlan 纯局部比较。损坏来源隔离而合法独立来源保留；同票跨 factId 冲突、同 sourceId 多版本影响身份传播、同银行流水全部冲突版本、账户清单/无业务声明实际矛盾须阻对应任务；仅缺整期覆盖不阻独立逐笔整理。输入声明可为 null，先产生基础信息请求；缺项不得当零。

`ready` 只表示能整理该笔资料包，business_evidence_packet 尚未 produced，accountingEligibility=not_assessed、authorizesExecution=false。已履约未结算不证明收款权利或纳税义务；采购需实际用途/对象/受益期。post/close/compute_tax/review 显式未实现并保持依赖阻断。正式会计准入/执行完成/回执复用留后续 #79，凭证及会计规则留 #80，税务与真实确认留 #81/#82。

验收命令：在 `06-workbench` 运行 `node test/offline-plan.test.mjs`；不跑无关全量。所有用例只临时合成，不使用真实资料、账套或凭据，真实 CLI 检查子进程退出、stderr/stdout 安全、输出不覆盖、补件重规划；测试保留旧断言。结果、失败修复与当前限制见 [离线交接](../handoffs/OFFLINE-CLOSELOOP.md)，接口见 [OFFLINE-PLAN](../OFFLINE-PLAN.md)。
