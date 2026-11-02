# 选择财税 Agent 应用

Pi、Claude Code、dsh 和 ZCode 都能作为任务入口，调用同一本机财税后端，处理账前核对、凭证、对账、税费和报表。选择已安装或熟悉的应用即可，业务能力不按应用划分。

| 应用 | 适合的使用方式 | 本项目提供 |
|---|---|---|
| [Pi](pi/README.md) | 使用 Pi 交互会话或任务文件 | 启动器、财税扩展和连接检查 |
| [Claude Code](claude-code/README.md) | 在 Claude Code 工作区交代业务 | 财税连接、工作区指引和工具审批配置 |
| [DeepSeek Harness / dsh](dsh/README.md) | 通过 dsh 命令行运行明确任务 | 可显式加载的财税与技能配置 |
| [智谱 ZCode](zcode/README.md) | 在 ZCode 工作区或命令行处理业务 | 工作区财税连接和技能目录配置 |

从[配置与启动](START-HERE.md)连接本机后端、指定账库和资料目录，再按[业务技能](../../../plugins/finance/README.md)选择任务。模型服务由各应用配置，生成器不安装应用或代填账号凭据。
