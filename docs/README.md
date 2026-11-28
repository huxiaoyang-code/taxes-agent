# 文档索引

## 开发与维护

| 要查的内容 | 文档 |
| --- | --- |
| 项目开工入口 | [AGENTS.md](../AGENTS.md) |
| 分工、worktree、PR、独立验收与数据边界 | [开发与协作规范](DEVELOPMENT.md) |
| 当前 direct 调用、留痕、记忆和正式入账 | [架构与调用链](AGENT-ARCHITECTURE.md) |
| 按业务定位实现、协议、脚本和测试 | [代码索引](CODE-INDEX.md) |
| 模块依赖、循环和高耦合文件 | [仓库依赖体检](REPOSITORY-DEPENDENCIES.md) |
| 改 Harness、Agent 工具、Skill 或记忆 | [Harness 工程规范](HARNESS-TOOL-DESIGN.md) |
| 提需求与提交验证证据 | [Issue 模板](../.github/ISSUE_TEMPLATE/requirement.md) · [PR 模板](../.github/pull_request_template.md) |

## 业务使用

| 要做的事 | 文档 |
| --- | --- |
| 了解产品范围和两条常用业务流程 | [项目 README](../README.md) |
| 配置本机后端、生成工作区或绑定已有账套 | [四宿主统一入口](../05-reconstruction/codex/hosts/START-HERE.md) · [宿主选择](../05-reconstruction/codex/hosts/README.md) |
| 维护账套记忆、跨月接续 | [账套记忆](../05-reconstruction/codex/hosts/BUSINESS-MEMORY.md) |
| 选择账前、凭证、税费、对账和复核技能 | [财税 Skill 目录](../plugins/finance/README.md) |
| 查询代账规则来源、版本和适用范围 | [代账规则](AGENCY-RULES.md) |
| 交付企业接手与财税顾问技能包 | [企业接手与财税顾问](COMPANY-ADVISOR-SKILL.md) |

## 可选接入

- [Harness² 研究接入](HARNESS2-INTEGRATION.md)涵盖 Codex 优化、原生宿主执行与实验验证。
- [SoL-Pi](SOL-PI-INTEGRATION.md)涵盖 Pi 的可选 ObservationPack 接入。
