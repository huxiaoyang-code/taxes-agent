# 项目协作入口

中国财税 Agent 在本机服务单个操作者，可处理多家企业，每家企业一个账套。多企业批处理保留账套隔离。

## 按任务阅读

| 任务 | 入口 |
| --- | --- |
| 开始开发 | 依次读 [README](README.md)、[架构与调用链](docs/AGENT-ARCHITECTURE.md)、[代码索引](docs/CODE-INDEX.md)，再读相关源码和测试 |
| 查找规范与验证入口 | [文档索引](docs/README.md)、[开发与协作规范](docs/DEVELOPMENT.md) |
| 判断改动波及范围 | [仓库依赖体检](docs/REPOSITORY-DEPENDENCIES.md)及[代码索引](docs/CODE-INDEX.md) |
| 配置或接续财税主 Agent | 先读[四宿主统一入口](05-reconstruction/codex/hosts/START-HERE.md)，核实宿主、模型、实际账库和授权，再加载[中文业务 Skill](plugins/finance/README.md) |
| 改 direct 工具、Skill 或原生记忆 | 开工前按 [Agent 工程规范](docs/AGENT-TOOL-DESIGN.md)核对当前官方原文、实际宿主和协议 |

## 开工与验收

- 以用户当前明确要求为准，用源码、工具契约和正常入口的测试判断实际能力。
- 先确认成员身份、任务范围和文件所有权，共享文件改动先协调。使用隔离 worktree 和 `codex/` 分支，经 PR 整合。
- 需求、依赖、分工、未完项和验证证据记在 Issue / PR。实施者自测后，由独立审查者在全新上下文核对实际 diff、产物和终态。
- 自动测试只使用合成数据和临时目录。真实账套和凭据留在本机可信界面。外发和发布限于本次明确授权。
- 默认 direct MCP 直接执行业务并自动留痕，无需手工登记事实、维护任务 DAG 或回读技术状态。
