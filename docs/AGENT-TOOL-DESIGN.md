# direct 工具、Skill 与原生记忆工程规范

以[实际架构](AGENT-ARCHITECTURE.md)和[代码索引](CODE-INDEX.md)确认宿主、工具合同与现有行为。

## 开发与独立验收

1. 开工时从用户目标和可观察结果出发，核对当前官方原文、实际使用的宿主、模型和协议版本。用协议规范约束接口，用产品文档核对宿主能力，用工程文章和实验选择待本项目验证的方法。在既有任务与审查记录中写清所采依据、适用边界、最少改动及验证。官方发布或版本变化影响结论时重查相关原文并复验。
2. 先验证已有宿主和原生业务能力。确需改工具时，输入约束、成功条件、失败原因和可执行下一步应从正常入口取得。摘要、稳定引用和分页支持按需调查，原始值及大量中间数据留在授权的本机路径。可独立成功的材料继续处理。自动恢复和编排的范围以可复现的业务缺口为限。
3. Skill 入口只放任务触发、必要判断和参考入口。支持资源按需读，强约束由实际权限、业务校验和人审控制执行。参考某个宿主的做法与测试该宿主分开记录。读取官方指南不授予外部模型、外发、发布或写账权限。
4. 独立审查者在全新上下文核对要求与实际 diff，走正常入口检查回执、产物和最终状态。涉及失败恢复时，按风险用合成异常材料验证可行动错误与已成功分支，独立保留预期结果。区分程序合同、实际宿主路径和 Agent 自主行为的证据，记录已审版本、实际命令、结果和未验证范围。

按本次变更选读官方来源：

- 架构从简单可组合方案开始。早期原文已提示其工具生态发生变化，跟进当前宿主的官方说明。长程架构中的具体分工和收益须按实验环境判断。[Building effective agents](https://www.anthropic.com/research/building-effective-agents) · [Scaling Managed Agents with stable interfaces](https://www.anthropic.com/research/managed-agents) · [Harness design for long-running apps](https://www.anthropic.com/research/harness-design-long-running-apps)
- 工具应返回可行动错误，使用实际协议合同，按需筛选结果和保存上下文引用。本机已观察到的 stdio 协商版本为 `2025-06-18`；领域执行错误使用现有结果结构及 `isError`，`/latest` 用于核对变化。[Writing effective tools for agents](https://www.anthropic.com/research/writing-tools-for-agents) · [MCP Tools 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) · [MCP Tools /latest](https://modelcontextprotocol.io/specification/latest/server/tools) · [Code execution with MCP](https://www.anthropic.com/research/code-execution-with-mcp) · [Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- 技能写法和验收要有可验证的成功条件，独立查看任务实际结果。宿主示例按当地权限和当前部署条件取用。[Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) · [Claude Code best practices](https://code.claude.com/docs/en/best-practices) · [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
