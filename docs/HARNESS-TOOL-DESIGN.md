# Harness 工具设计依据

实现遵循 Anthropic 已公开的工具工程模式，并复用本项目原生财税与恢复能力。这里记录设计映射，不是任务状态或验收报告。

| 参考 | 本项目实现 |
| --- | --- |
| [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)：明确边界、有用返回、可操作错误、用实际任务评价 | 固定命名能力；共享 schema 与运行校验；具体字段诊断、当前事实绑定、可调用 nextSteps；stdio 和原生业务回归 |
| [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：易用参数和清楚的输入格式 | requestFactId 显式绑定持久请求；服务端返回事实值摘要，保留旧首事实兼容；拒绝不支持的prepare |
| [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)：按需查工具定义、过滤大结果 | 轻量领域目录→domain/query/有界页→选中能力合同/Wiki；已有summary与定向receipt保留 |
| [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) 与 [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)：合同、例子及延迟披露 | 单份能力schema供发现和执行；Ajv draft-07完整校验，不默认填值/转换/删字段；Pi使用自身原生deferred工具，不冒称具有Claude API strict/defer_loading实现 |
| [financial-services](https://github.com/anthropics/financial-services)：Agent职责/产物、任务Skill与MCP连接器分工 | Harness Skill按资料/核算/期间/复核/恢复导航；Agent自行判断与构造有据业务请求；原生模块计算/执行，实际人审边界继续执行 |

能力合同位于 server/harness-input-contracts.mjs；发现模块只投影它，运行时在新操作前验证。已有 write intent 或成功执行请求的 query/重放优先使用保存的原身份，新增输入 schema 不用于阻断这类历史查询；旧事实不因兼容读取变为已验证。旧版本 materials/review 等能力的 prepare 曾可能实际执行 mutator，却把 intent.effect 记为 read；这类历史现场尚未构造迁移恢复验收，不在本次兼容通过范围，不能据普通旧 execute/query 回归宣称其已可恢复。本次拒绝新调用继续产生这类 prepare，不在未复现条件下另造迁移机制。

支持的期间必须符合实际原生validator；例如材料/复核Store的字符串scope为季度，不能声明月度然后在mutator报unknown。业务规则、证据语义、人工确认、账套隔离、审计及幂等仍由现有机制核验。schema通过不等于业务完成。

这是对公开设计思想的项目适配，没有复制第三方金融技能正文、默认税务值或供应商MCP实现。公开金融仓库的.mcp.json主要注册外部服务地址；该结构不提供本项目账务执行的替代实现。

合成回归：在06-workbench运行 `node test/harness-tool-engineering.test.mjs`，并按实际影响运行合同、披露、恢复、生命周期、期间、年度与MCP测试。脚本不会调用模型，也不宣称真实Pi/真实会计审定通过。

批量回执中的 applied 继续只表示整批成功。整批未完成或暂时无法核验时，partialEffects=true 表示已持久保存且匹配当前 manifest 的 taskId、capabilityId、dependencyDigest 的 stage/原 Harness 回执证明该请求曾发生效果；false 表示各 stage 可证明未执行或不适用；null 表示当前证据不足，不能据此声称零写入。整批成功仍为 applied=true、partialEffects=false。同一 task 的全局 executed 不证明其新请求执行；不同请求版本的旧回执仅保留历史，当前效果为 null。checkpoint 保留 priorCommittedObservation 历史观察同样匹配原 manifest 版本，只用于报告已发生效果，不恢复当前结果、会计确认或授权重试。默认 MCP 摘要及任务状态保留该三态和定向原回执指针。合成真实三凭证与 stdio 回归：`node test/harness-batch-partial-effects.test.mjs`。
