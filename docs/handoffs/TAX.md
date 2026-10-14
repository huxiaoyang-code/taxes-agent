# TAX 交接

- 状态：已合并；Claude Code 员工进程已退出，最后退出码 0。
- 分支 / worktree：`codex/tax-gateway-contract` / `.worktrees/tax`；模型显式锁定 `deepseek-v4.1-flash`。
- PR：[#6](https://github.com/huxiaoyang-code/youshu-fork/pull/6)，合并 SHA `f4d9f82f2f91afafc74d2aa88288b4e1607ce9d0`。
- 交付：7 个 MCP 入口，地区/能力目录、登录与人工验证、查询及退出契约；31 省区市 + 5 计划单列市独立路由。默认适配器为空，真实接入 0 个地区。
- 文件：`tax-gateway.mjs`、`agent-tools.mjs` 接线、`tax-tools.mjs`、`tax-contract-test.mjs` 和 [接口说明](../TAX-INTEGRATION.md)。
- 审查修复：异步适配器；退出/过期后的迟到响应不得恢复会话或返回信息；查询参数不许覆盖绑定范围；验证码/凭据引用在提示、错误和 DTO 中脱敏。
- 管理者独立验证：最新 main 基线运行税务契约 59、MCP 44、原有冒烟 28 项全部通过；最终 main 上也随全套 208 项通过。
- 数据范围：临时数据和本地假适配器；没有真实凭据、税局连接或生产登录测试。
- 生产前必做：真实适配器与协议联调、凭据存储及生命周期、人工验证 UI、实际授权企业核实、超时/重试、会话回收。当前内存暂存是接口期有限实现，不是生产认证方案。
- 日志仅本地：`.agent-runs/claude-tax-review2.jsonl`。后续新会话只读章程、STATE、本交接、接口说明及必要源码，不继承旧日志。
