# 中国财税 Agent

按 Anthropic 官方知识工作插件的 Skill、连接器与原生 MCP 格式组织中国财税业务。Agent 调查资料、判断处理路径并自主选用工具；本机后端负责确定性计算、受控记账和自动调用记录，不替 Agent 建立事实登记或任务 DAG。

默认 MCP 工具面为 `direct`。旧 Harness 仅以显式 `FINANCE_MCP_PROFILE=harness` 保留历史兼容，不是日常前置流程；`legacy` 是旧全量工具面的显式兼容入口。

| 需要做什么 | 入口 |
|---|---|
| 安装、明确账库、选择 Pi / Claude Code / dsh / ZCode | [主 Agent 接入](05-reconstruction/codex/hosts/START-HERE.md) |
| 了解业务与证据调用链 | [中文架构](docs/AGENT-ARCHITECTURE.md) |
| 找业务源码与测试 | [代码索引](docs/CODE-INDEX.md) |
| 复用官方格式的中国化财务插件 | [中国化 fork](https://github.com/huxiaoyang-code/knowledge-work-plugins)；配置生成器可用 `--plugin-root` 指向其 `finance` 目录 |

## 工具与结果

`finance_rules` 查询实际规则与官方出处，`finance_record_contract` 按需披露业务字段，`finance_workpaper` / `finance_annual_workpaper` 生成本机完整底稿，`finance_tax_calculate` 调用既有税费计算；账套、凭证、查账和报表继续使用既有会计工具。未接入的税局、开票和正式申报不能因 Skill 或目录存在而称已完成。

每次 MCP 工具调用（包括参数拒绝）自动保存开始/结束、输入、结果或错误、本机范围及来源引用。结果通过 `_meta.financeCall.callId` 关联记录；正常业务无需模型维护 Store、requestFactId、版本摘要或计划。完整结果与人工核对页留在本机，模型输出仍遵守资料披露规则。

交付顺序固定为 **账本金额 → 凭证/计算结果 → 规则依据 → 工具调用 → 输入与原件**。日常展示前三项，严重或多项错误时按需展开后两项；完整后台记录始终保存。原件缺失保留未知，哈希核验不代表原件真实、业务正确或真人审定。

## 启动与验证

```powershell
cd 06-workbench
npm ci
npm start
```

MCP 由宿主启动 `05-reconstruction/codex/mcp/finance-mcp/server.mjs`，通过 `FINANCE_API_BASE` 连接明确的本机后端。配置生成器只写入全新工作区，不修改全局模型凭据或真实账库。

```powershell
node 06-workbench/test/finance-host-config.test.mjs
node 06-workbench/test/host-dsh.test.mjs
node 06-workbench/test/host-zcode.test.mjs
node --test 06-workbench/test/finance-call-chain.test.mjs
```

以上只使用合成数据，不调用模型。完整套件见 `06-workbench/scripts/test-all.mjs`；Pi 模型测试按改造审查和 PR 后的明确任务执行。产品是一名本机操作者处理多家企业，每家企业一个账套，具体地区、税种、期间和业务范围以实际计算合同与结果为准。
