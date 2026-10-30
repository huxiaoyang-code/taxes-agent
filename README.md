# 中国财税 Agent

面向中国企业财务核算、税费计算与会计复核开发的本机 Agent 工程。主 Agent 理解业务目标、调查获准资料、发现能力和组织任务；Node.js + SQLite 本机工具负责确定性计算、账务执行、审计和恢复，已有网页作为可选界面。面向一名操作者处理多家企业，每家企业一个账套。

业务入口、流程编排、交付结果和工具连接四层均已有实现。中国财税是建设方向，具体准则、地区、税种、期间及业务支持以当前源码、能力合同和实际返回为准；Skill、工具名称或配置存在不代表相应业务已完成。

## 从哪里开始阅读

| 想了解什么 | 阅读入口 |
|---|---|
| Agent 如何调用工具、编排任务、补件、更正与恢复 | [中文架构与调用链](docs/AGENT-ARCHITECTURE.md)（含流程图、时序图与合成调用示例） |
| 某项业务对应哪些源码和测试 | [中文代码索引](docs/CODE-INDEX.md) |
| 选择宿主、配置模型和账库、首次运行 | [四宿主统一入口](05-reconstruction/codex/hosts/START-HERE.md) |
| 接手陌生企业、核查历史、形成财税顾问意见 | [企业接手与财税顾问技能包](docs/COMPANY-ADVISOR-SKILL.md) |
| 工具合同、按需发现和回执设计的依据 | [Harness 工具设计依据](docs/HARNESS-TOOL-DESIGN.md) |

建议先读架构图和一个只读调用示例，再按代码索引追踪具体模块。文件名、函数名、JSON 字段和错误码保留原名，中文解释帮助将文档与代码对应起来。

## 启动与验证

在仓库根目录运行；Node 资格检查与 Windows 启动方式见[代码索引](docs/CODE-INDEX.md#windows)。

```sh
cd 06-workbench
npm ci
npm start
npm test
```

`npm test` 的套件清单由 [test-all.mjs](06-workbench/scripts/test-all.mjs) 定义，使用临时数据。服务默认数据库为 `06-workbench/data/workbench.db`；真实数据不用于自动测试。更新代码后需重启已有服务以加载变更。

MCP stdio 入口（由客户端启动）：

```sh
node 05-reconstruction/codex/mcp/finance-mcp/server.mjs
```

后端默认地址是 `http://127.0.0.1:8787`，可用 `FINANCE_API_BASE` 配置。工具注册、Skill 资源与示例命令见[代码索引](docs/CODE-INDEX.md#mcp)。

[主 Agent 配置与首次运行](05-reconstruction/codex/hosts/START-HERE.md)是 Pi、Claude Code、dsh、ZCode 的统一入口：选择宿主、启动明确账库的后端、生成全新工作区、配置本人模型并检验合成流程。四者均可作为主体运行；解析子 Agent 按宿主单独核实。配置、原生连接、模型短流程与整账验收分别记录，详见[接入与实测范围](05-reconstruction/codex/hosts/README.md)。

可选研究层与日常业务 Harness 分开：[Harness²](docs/HARNESS2-INTEGRATION.md)研究指引优化，[SoL-Pi](docs/SOL-PI-INTEGRATION.md)提供 Pi 的 ObservationPack 接入；二者默认关闭，目前不允许组合。候选、经验或压缩结果都不增加财税权限，也不代替业务结果与会计审定。具体接入约束、失败处理和验证范围见各自文档。

## 目录

| 路径 | 用途 |
|---|---|
| [06-workbench/server](06-workbench/server/) | HTTP、记账、报表及本机业务模块 |
| [06-workbench/public](06-workbench/public/) | 网页 |
| [06-workbench/scripts](06-workbench/scripts/) | CLI、运行和验证入口 |
| [06-workbench/test](06-workbench/test/) | 回归测试、合成测试样本与独立预期 |
| [05-reconstruction](05-reconstruction/) | MCP、宿主适配、运行时技能、能力目录、导入示例及研究接入；其中历史来源元数据不代表当前能力 |
| [docs/AGENT-ARCHITECTURE.md](docs/AGENT-ARCHITECTURE.md) | 中国财税 Agent 定位、实际调用链、流程编排及后续扩展原则 |
| [docs/CODE-INDEX.md](docs/CODE-INDEX.md) | 按任务定位源码、入口与测试 |
| [企业接手与财税顾问技能包](docs/COMPANY-ADVISOR-SKILL.md) | Codex 接手历史、疑点复核、税费与现金规划；同事安装和使用入口 |

协作规则见 [AGENTS.md](AGENTS.md)；当前需求与未完工作在 [GitHub Issues](https://github.com/huxiaoyang-code/taxes-agent/issues) 跟踪。
