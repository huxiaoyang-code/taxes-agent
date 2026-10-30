# 中国财税 Agent：直接业务调用与自动记录

业务 Skill 采用 Anthropic 官方插件的任务说明、输入资料、处理步骤、检查清单与输出格式。中国税会算法、账库与调用记录属于本项目后端实现；上游方法不是中国税法依据或准确率背书。

## 正常调用链

```mermaid
flowchart TD
  U[业务目标与获准原件] --> A[Pi / Claude Code / dsh / ZCode]
  S[按需加载中国化 Skill] --> A
  A --> M[原生 MCP：具体业务工具与输入合同]
  M --> B[本机会计、税费、报表与对账模块]
  B --> D[账库与完整业务底稿]
  M --> R[自动保存调用输入、结果、错误与证据索引]
  D --> V[账本金额、凭证计算、规则依据]
  R -.异常按需深查.-> V
```

Agent 根据目标自主调查与选择工具；后台没有为它建立新的来源登记、事实登记、请求事实或任务 DAG。一次只读核对不要求先完成整套记账流程。正式写入继续调用原生会计能力，并保留人审、期间、防重复和结果未知时核查原操作等已有控制。

## 三类入口

| 入口 | 实现 | 职责 |
|---|---|---|
| Skill 与宿主 | `05-reconstruction/codex/skills/`、`hosts/`、Pi `finance-direct.ts` | 业务方法与按需披露，不重复维护税率或替代工具计算 |
| 财税 MCP | `mcp/finance-mcp/server.mjs`、`direct-tools.mjs`、`tool-profile.mjs` | 默认 direct 工具面、输入校验、真实模块分派、模型投影 |
| 原生业务 | `06-workbench/server/direct-finance.mjs`、`agency-business.mjs`、`accounting.mjs` | 已支持的底稿/税费/凭证/账簿/报表计算与受控写入 |

默认 direct 仅暴露实际可用的直接业务工具与普通会计模型通道，不暴露 Harness 生命周期、原始税务占位或本机原值读取通道。`finance_rules` 提供规则范围及官方链接，`finance_record_contract` 按类型披露字段、已有示例及完整度，区分仅通用引用、已核字段和只能由原生生成的记录，不能据此假定所有类型都有完整示例。`finance_workpaper`、`finance_annual_workpaper` 与 `finance_tax_calculate` 直接调用原生计算。`finance_tax_summary_calculate` 是独立条件试算：汇总输入逐值绑定原件JSON位置，完整结果另存summary产物；不放宽原完整底稿路径，也不把试算当作已核完整账、资格或实缴。模型仍自主选择工具，无新增登记流程。

客户原件与 Agent 整理的业务记录必须区分。目录和字段示例不是客户事实；原件未提供的日期、资格、用途、收付关联不得猜填。工具返回缺件、条件受限或不支持时，保留实际状态，独立可核分支继续。

## 自动调用记录

`finance-call-chain.mjs` 在最外层包裹每次 MCP 工具调用，记录参数拒绝、业务错误及成功返回。每次调用在 `FINANCE_AUDIT_DIR/<callId>/` 独立保存：

- `begin.json`：工具、时间、范围、输入文件摘要、观察到的原件摘要和记录器代码版本。
- `input.json`：经认证字段脱敏的完整调用输入，本机保存。
- `result.json` 或 `error.json`：完整返回或诊断，本机保存。
- `end.json`：结束时间、耗时、状态、结果摘要、规则/代码版本以及调用期间来源变化。

`_meta.financeCall.callId` 将 MCP 返回与本机记录关联。缺少结束文件明确为 incomplete；调用已返回但日志保存失败时，不宣称可以重复写入。独立记录避免并发工具互相覆盖，列表由文件目录重建，不新增任务状态库。

本机 `listFinanceCalls` / `readFinanceCall` / `verifyFinanceCalls` 供人工核查，不作为绕过模型投影的原值 MCP 通道。摘要核验只有每调用输入/结果哈希及 begin→end 绑定，没有外部可信锚点；不能声称不可篡改、原件真实、财税正确或已获人审。

原生 `local-audit-coordinator.mjs` / `local-audit-storage.mjs` 继续负责账库写入的操作身份、请求/结果摘要、凭证引用与事务恢复。它与自动 MCP 记录职责不同，既不替换原生写审计，也不要求 Agent 手工维护审计。

## 人工核对顺序

1. **账本金额**：企业、账套、期间、科目与关键余额，明确草稿和已入账。
2. **凭证／计算结果**：对应分录、计算过程、差额与缺件，不能用模型推导冒充工具结果。
3. **规则依据**：规则版本、官方条款、适用期间及事实条件。
4. **工具调用**：按需查看 callId、工具、状态、时间和具体诊断。
5. **输入与原件**：按需追到整理记录、原始文件与页/表/行/字段。

正常报告展示前三项。严重错误、多项错误或人工追查时再展开后两项；后台完整记录始终保留。应纳、计提、实缴与差额按原生字段分别表述，缺失或null不补成0。

## 宿主与渐进披露

`finance-host-config.mjs` 生成全新工作区，默认 profile=direct；`--plugin-root` 可选用中国化 fork 的 finance 插件，`--audit-dir` 可指定本机记录目录。Pi 使用原生 MCP 与 tool-search，初始只披露规则查询和 Skill 读取，其余工具按需加载；Claude Code、dsh、ZCode 使用各自原生 MCP/Skill 格式。工具面不是文件系统沙箱，生成配置不授予写账或资料外发权限。

## 历史兼容与验证

旧 Harness 源码、回执和回归保留为显式 `FINANCE_MCP_PROFILE=harness`；旧全量工具面须显式选 `legacy`。研究用 Harness² / SoL-Pi 默认关闭，不构成新日常业务依赖。历史元数据模型测试不能替代 direct 业务验收。

回归分别验证直接工具合同、实际业务结果、自动记录完整性、四宿主配置和原生写入控制；合成数据与临时账库是自动测试边界。Pi 模型只在全部改造、审查及 PR 后按既定测试集运行。
