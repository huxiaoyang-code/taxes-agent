# CORE-B 交接

- 状态：已合并，员工会话已结束。
- 目标：明细报表、零利润结转、折旧撤销一致性；不扩展会计准则或真实税务连接。
- 分支 / worktree：`codex/accounting-derived` / `.worktrees/core-b`。
- 执行者：pi，显式 `tokenhub/deepseek-v4.1-flash`，无其他模型或子 agent。
- PR：[#5](https://github.com/huxiaoyang-code/youshu-fork/pull/5)。合并 SHA：`91b623a9a75d19b1e88fe00719aee084973d2cde`。
- 变更：`accounting.mjs`、新增 `accounting-derived.test.mjs`、相关 README 口径。
- 管理者独立验证：在该 worktree 的 `06-workbench` 运行 `node test/accounting-derived.test.mjs`（31/31）、`node test/accounting-guards.test.mjs`（23/23）、`node test/smoke.test.mjs`（28/28）、`node ../05-reconstruction/codex/mcp/finance-mcp/contract-test.mjs`（44/44）。其后基线仅增加章程文档，无业务变化。
- 审查修复：跨期恢复旧折旧凭证会超过可折旧额，已补恢复校验及失败不改变账簿/卡片回归；结转失败不残留新期间；年末结转包括 3103 下级明细。
- 当前规则：累计折旧只认已过账 run；同期间残留草稿须先恢复或删除；删除清理 runs；恢复过账不能超过可折旧额。卡片不自动创建购入凭证。
- 已知限制：现有编码体系与简化现金流口径；多准则只含部分兼容映射，未实现完整独立科目与报表体系。
- 日志：本机忽略目录 `.agent-runs/pi-core-b-review.jsonl`，退出码 0；无仍运行的 CORE-B 员工。
- 下一部分：FLOW 用新会话读取当前领域代码、MCP 契约和本交接，不载入旧模型日志。
