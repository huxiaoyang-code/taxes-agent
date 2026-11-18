# Harness 工具设计依据

本文以 Harness 统称 Agent 的任务与证据运行层。默认 direct 直接调用本机原生业务并自动留痕。旧 Harness 另有 Store、事实和任务依赖等历史入口。先读[中文架构与调用链](AGENT-ARCHITECTURE.md)辨明工作所涉及的入口，再按本文核对工程依据。

实现借鉴 Anthropic 已公开的工具工程方法，并复用本项目原生财税与恢复能力。[Google Research Harness² 研究接入](HARNESS2-INTEGRATION.md)默认关闭。[SoL-Pi](SOL-PI-INTEGRATION.md)是可选运行效率层。这些入口及其任务与验证范围分别见各自说明。

## 开发与独立验收

1. 开工时从用户目标和可观察结果出发，核对当前官方原文、实际使用的宿主、模型和协议版本。用协议规范约束接口，用产品文档核对宿主能力，用工程文章和实验选择待本项目验证的方法。在既有任务与审查记录中写清所采依据、适用边界、最少改动及验证。官方发布或版本变化影响结论时重查相关原文并复验。
2. 先验证已有宿主和原生业务能力。确需改工具时，输入约束、成功条件、失败原因和可执行下一步应从正常入口取得。摘要、稳定引用和分页支持按需调查，原始值及大量中间数据留在授权的本机路径。可独立成功的材料继续处理。自动恢复和编排的范围以可复现的业务缺口为限。
3. Skill 入口只放任务触发、必要判断和参考入口。支持资源按需读，强约束由实际权限、业务校验和人审控制执行。参考某个宿主的做法与测试该宿主分开记录。读取官方指南不授予外部模型、外发、发布或写账权限。
4. 独立审查者在全新上下文核对要求与实际 diff，走正常入口检查回执、产物和最终状态。涉及失败恢复时，按风险用合成异常材料验证可行动错误与已成功分支，独立保留预期结果。区分程序合同、实际宿主路径和 Agent 自主行为的证据，记录已审版本、实际命令、结果和未验证范围。

按本次变更选读官方来源：

- 架构从简单可组合方案开始。早期原文已提示其工具生态发生变化，跟进当前宿主的官方说明。长程架构中的具体分工和收益须按实验环境判断。[Building effective agents](https://www.anthropic.com/research/building-effective-agents) · [Scaling Managed Agents with stable interfaces](https://www.anthropic.com/research/managed-agents) · [Harness design for long-running apps](https://www.anthropic.com/research/harness-design-long-running-apps)
- 工具应返回可行动错误，使用实际协议合同，按需筛选结果和保存上下文引用。本机已观察到的 stdio 协商版本为 `2025-06-18`；领域执行错误使用现有结果结构及 `isError`，`/latest` 用于核对变化。[Writing effective tools for agents](https://www.anthropic.com/research/writing-tools-for-agents) · [MCP Tools 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) · [MCP Tools /latest](https://modelcontextprotocol.io/specification/latest/server/tools) · [Code execution with MCP](https://www.anthropic.com/research/code-execution-with-mcp) · [Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- 技能写法和验收要有可验证的成功条件，独立查看任务实际结果。宿主示例按当地权限和当前部署条件取用。[Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) · [Claude Code best practices](https://code.claude.com/docs/en/best-practices) · [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)

## 旧 Harness 的既有设计映射

下表及后续合同、Store 和回执说明对应旧 Harness 入口。默认 direct 的实际实现和验证看[中文架构](AGENT-ARCHITECTURE.md)及[代码索引](CODE-INDEX.md)。

| 参考 | 本项目实现 |
| --- | --- |
| [编写有效工具](https://www.anthropic.com/engineering/writing-tools-for-agents)：明确边界、有用返回、可操作错误、用实际任务评价 | 固定命名能力；共享结构合同（schema）与运行校验；具体字段诊断、当前事实绑定、可调用后续步骤（nextSteps）；标准输入输出和原生业务回归 |
| [构建有效 Agent](https://www.anthropic.com/engineering/building-effective-agents)：易用参数和清楚的输入格式 | requestFactId 显式绑定持久请求；服务端返回事实值摘要，保留旧首事实兼容；拒绝不支持的准备阶段（prepare） |
| [通过 MCP 执行代码](https://www.anthropic.com/engineering/code-execution-with-mcp)：按需查工具定义、过滤大结果 | 轻量领域目录→领域/关键词/有界分页→选中能力合同/规则说明；保留摘要（summary）与定向回执（receipt） |
| [定义工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)与[工具搜索](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)：合同、例子及延迟披露 | 单份能力结构合同供发现和执行；Ajv draft-07 完整校验，不默认填值/转换/删字段；Pi 使用自身原生延迟发现工具，不冒称具有 Claude API strict/defer_loading 实现 |
| [financial-services](https://github.com/anthropics/financial-services)：Agent职责/产物、任务Skill与MCP连接器分工 | Harness Skill按资料/核算/期间/复核/恢复导航；Agent自行判断与构造有据业务请求；原生模块计算/执行，实际人审边界继续执行 |

能力合同位于 server/harness-input-contracts.mjs；发现模块只投影它，运行时在新操作前验证。已有 write intent 或成功执行请求的 query/重放优先使用保存的原身份，新增输入 schema 不用于阻断这类历史查询；旧事实不因兼容读取变为已验证。旧版本 materials/review 等能力的 prepare 曾可能实际执行 mutator，却把 intent.effect 记为 read；这类历史现场尚未构造迁移恢复验收，不在本次兼容通过范围，不能据普通旧 execute/query 回归宣称其已可恢复。本次拒绝新调用继续产生这类 prepare，不在未复现条件下另造迁移机制。

支持的期间必须符合实际原生validator；例如材料/复核Store的字符串scope为季度，不能声明月度然后在mutator报unknown。业务规则、证据语义、人工确认、账套隔离、审计及幂等仍由现有机制核验。schema通过不等于业务完成。

这是对公开设计思想的项目适配，没有复制第三方金融技能正文、默认税务值或供应商MCP实现。公开金融仓库的.mcp.json主要注册外部服务地址；该结构不提供本项目账务执行的替代实现。

合成回归：在06-workbench运行 `node test/harness-tool-engineering.test.mjs`，并按实际影响运行合同、披露、恢复、生命周期、期间、年度与MCP测试。脚本不会调用模型，也不宣称真实Pi/真实会计审定通过。

批量回执中的 applied 继续只表示整批成功。整批未完成或暂时无法核验时，partialEffects=true 表示已持久保存且匹配当前 manifest 的 taskId、capabilityId、dependencyDigest 的 stage/原 Harness 回执证明该请求曾发生效果；false 表示各 stage 可证明未执行或不适用；null 表示当前证据不足，不能据此声称零写入。整批成功仍为 applied=true、partialEffects=false。同一 task 的全局 executed 不证明其新请求执行；不同请求版本的旧回执仅保留历史，当前效果为 null。checkpoint 保留 priorCommittedObservation 历史观察同样匹配原 manifest 版本，只用于报告已发生效果，不恢复当前结果、会计确认或授权重试。默认 MCP 摘要及任务状态保留该三态和定向原回执指针。合成真实三凭证与 stdio 回归：`node test/harness-batch-partial-effects.test.mjs`。
