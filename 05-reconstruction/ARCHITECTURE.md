# 财税工作台复刻方案（Codex 作为客户端/运行时）

> 结论先行：**可以，而且有数云自己就是这么做的。**
> `/work` 财税工作台的前端是一个 **OpenAI Codex app-server 客户端**，不是自研 Agent 框架。
> 你要复刻的「业务域功能」，本质是三类东西：**Codex 运行时 + 财税动态工具(Dynamic Tools) + 业务规则 Skill(Markdown)**。
> 因此你可以直接用 Codex 做客户端，只补上「财税工具」和「Skill」两层。

本目录的结论全部来自 REA 对 `02-scripts/work/index-yoSd2Nx7.js`
（SHA-256 `098e3f59…`）的静态分析与原始字符串证据，见 `catalog.json`。

---

## 一、证据：它就是 Codex 客户端

| 观察到的标识 | 位置/含义 | 证据 |
|---|---|---|
| `CodexAppServerRpcError` / `NativeRpcError` | 前端自定义错误类型 | bundle 字面字符串 |
| `app_server_unavailable` / `app_server_closed` / `thread_bridge_closed` / `thread_bridge_stalled` | Codex app-server 连接错误码 | bundle |
| `POST /api/agent/runtime-ticket` → `WebSocket(..., "codex-runtime-ticket." + ticket)` | 连接 Codex app-server 的票据+WS 握手 | bundle |
| `thread/read` `thread/resume` `thread/turns/list` | Codex 线程 RPC | REA 静态分析（app 图）|
| 原生事件类型 `agentMessage` `reasoning` `commandExecution` `mcpToolCall` `dynamicToolCall` `collabAgentToolCall` `subAgentActivity` `enteredReviewMode` `exitedReviewMode` `contextCompaction` | 与 Codex app-server 事件一一对应 | bundle |
| `<codex_delegation><source_thread_id>…<input>…</codex_delegation>`、`subAgentThreadSpawn`、`parent_thread_id` | Codex 子智能体/委派协议 | bundle |
| `codex_approval_kind="mcp_tool_call"`、`mode:"openai/form"` + `requestedSchema` | MCP 工具审批 + elicitation | bundle |
| `"模型服务认证失败"` 匹配 `api.openai.com` / `/v1/responses` | 后端走 OpenAI Responses API | bundle |
| Sentry `release: codex2-verified-release-20261011`、`service: codex2-web` | 版本代号 codex2 | bundle |
| 技能市场 scope：`内置 Skill` / `管理员 Skill` / `项目 Skill` / `用户 Skill` | 技能来自 Codex 的 skills | bundle |

> 换句话说：有数云做的是「**Codex 的行业皮肤**」——把通用编码 Agent 换上一套财税工具和财税 Skill，
> 再用一个 Web UI 渲染 Codex 的流式事件。

## 二、架构对比

```
有数云 /work（现状）                              你要复刻（Codex 直连）
┌───────────────┐                                 ┌───────────────────────────┐
│ Web 前端       │  Codex app-server 事件           │ Codex CLI / TUI / IDE      │
│ (React+antd)  │◀────────WS────────────────────── │ (现成客户端，无需自研 UI)   │
└──────┬────────┘                                 └──────────────┬────────────┘
       │ /api/agent/runtime-ticket                                │ MCP (stdio)
       ▼                                                          ▼
┌───────────────┐   dynamic tools   ┌──────────────┐      ┌───────────────────┐
│ Codex         │◀─────────────────▶│ 财税动态工具   │      │ finance-mcp 服务   │
│ app-server    │   skills.read/list │ finance_query │      │ (你来实现)         │
│ (OpenAI)      │                    │ invoice_* …   │      └─────────┬─────────┘
└───────┬───────┘                    └──────┬───────┘                │
        │ /v1/responses                     │                        ▼
        ▼                                   ▼                ┌───────────────────┐
   OpenAI 模型                        财税后端/数据源           │ 财税后端/数据源     │
```

**核心结论**：Web UI 与「Codex 事件渲染」是和业务无关的工程；业务价值集中在
**Dynamic Tools 契约** 与 **Skill 文档**。用 Codex 直连可以跳过前者。

## 三、必须复刻的两层（业务域）

### 1) 五个子智能体（= Codex 的 skill 化任务域）

| runtimeName | 名称 | 职责 |
|---|---|---|
| `legacy-book-import` | 导入旧账 | 导入 Excel 旧账、历史凭证、科目余额、期初余额，账套初始化 |
| `bookkeeping` | 智能核算 | 原始单据入账、凭证、工资与固定资产核算、期末结转结账 |
| `tax-filing` | 全税种申报 | 增值税/附加税/企业所得税/印花税/年度申报及状态 |
| `individual-income-tax-filing` | 个税申报 | 人员报送、工资薪金个税计算、申报、缴款、状态查询 |
| `invoice-issuing` | 智能开票 | 开票信息校验、税收分类编码、正式开票/红冲 |

### 2) 22 个业务工具（Dynamic Tools / 建议映射为 MCP tools）

| 工具 | 界面名称 | 归类 |
|---|---|---|
| `finance_query` | 查询财务数据 | 查询（入参含 `nodeId`，见下表）|
| `finance_query_catalog` | 查找财务查询能力 | 查询 |
| `finance_context_resolve` / `account_context` | 核对账套和期间 | 上下文 |
| `finance_task_status` | 查询财税任务结果 | 查询 |
| `voucher_create` / `voucher_check` | 创建凭证 / 检查凭证 | 核算 |
| `invoice_precheck` / `invoice_tax_code` | 开票预检 / 筛选税收分类编码 | 开票 |
| `invoice_issue` / `invoice_issue_result` | 开具发票 / 查询开票结果 | 开票 |
| `invoice_red_apply` / `invoice_red_issue` / `invoice_red_status` | 红字信息表/红字发票/红字状态 | 开票 |
| `invoice_collect` / `invoice_file` | 采集发票 / 获取发票文件 | 发票 |
| `declaration_query` / `tax_declaration_query` | 查询申报状态 | 申报 |
| `read` / `list`（namespace `skills`）| 读取业务规则 / 查找可用能力 | Skill 访问 |
| `exec` / `update_plan` | 运行命令 / 更新处理计划 | 通用 Agent 工具 |

### `finance_query` 的 21 个查询能力（`nodeId` 取值）

```
enterprise_account.account_set        查询账套信息
enterprise_account.bank               查询银行信息
enterprise_account.business           查询工商信息
enterprise_account.personnel          查询人员信息
enterprise_account.tax_assessment     查询税种核定
enterprise_account.tax                查询税务信息
enterprise_account.auxiliary_accounting.all   查询辅助核算
enterprise_account.subject_system.all         查询科目体系
fund.unbooked.list / fund.unbooked.summary    查询未入账银行流水
invoice.detail                        读取发票详情
invoice.unbooked.list / .summary      查询未入账发票
report.balance_sheet                  查询资产负债表
report.income_statement               查询利润表
report.cash_flow_statement            查询现金流量表
period_end.summary                    盘点期末状态
voucher.detail                        读取凭证详情
voucher.draft.summary                 查询草稿凭证
voucher.generated.list / .summary     查询已生成凭证
```
（还有前缀兜底：`invoice.` `voucher.` `ledger.` `report.` `fund.` `period_end.` `enterprise_account.`）

### 3) Skill 文件清单（21 个 Markdown，即业务规则）

```
bookkeeping/SKILL.md
bookkeeping/references/{invoice,bank-transaction,reimbursement,payroll,
                        fixed-asset,other-business,period-end}-bookkeeping.md
invoice-issuing/SKILL.md
invoice-issuing/references/{native-tool-map,tax-code-filtering}.md
individual-income-tax-filing/SKILL.md
individual-income-tax-filing/references/{native-tool-map,workflow-state}.md
tax-filing/SKILL.md
tax-filing/references/{enterprise-tax,individual-income-tax,declaration-data-query,
                       correction-cancel,annual-tax}.md
legacy-book-import/SKILL.md
```
> ⚠️ 这些 **Markdown 的正文在服务端**，前端只有「读取某份规则」的入口。
> 要复刻业务准确度，这部分必须由你（或领域专家）重写，不能从包中提取。

## 四、用 Codex 做客户端的三种落地方式

| 方案 | 客户端 | 你要写什么 | 适用 |
|---|---|---|---|
| **A. Codex CLI + MCP（推荐起步）** | `codex` 终端/IDE | 1 个 MCP Server（22 个工具）+ skill Markdown | 最快验证业务链路 |
| **B. 自研 Web UI + Codex app-server** | 自己的前端 | 同 A，外加 Codex app-server 客户端与事件渲染（就是有数云的做法） | 要对外卖 SaaS |
| **C. Codex SDK 内嵌** | 你的后端服务 | 用 Codex SDK 起线程 + 注册 dynamic tools | 需要多租户/审批/审计 |

**推荐先做 A**：因为「业务域功能」= 工具 + 规则，Web UI 只是壳。

## 五、落地清单（建议顺序）

1. **确定后端数据源**（唯一阻塞项，见第六节）。
2. 在本目录 `codex/mcp/finance-mcp/` 里把 `backend.mjs` 接上你的财税系统
   （`finance_query` 按 `nodeId` 分派；开票/申报类工具走各自接口）。
3. 用 `codex/mcp/finance-mcp/server.mjs` 起 MCP Server，在 `codex/config.toml` 注册。
4. 按 `catalog.json` 的 `skill_files` 清单补齐 5 份 `SKILL.md` + references。
5. 用 Codex CLI 跑端到端：`新建会话 → 选账套 → 查未入账流水/发票 → 生成凭证 → 出报表 → 申报`。
6. 若要 Web 化，再照方案 B 接 Codex app-server（票据接口 + WS 子协议 + 事件渲染）。

## 六、唯一阻塞点：财税后端从哪来？

`/work` 的业务逻辑（记账引擎、发票、申报通道）都在服务端，前端包里**没有**。三条路：

- **(1) 复用有数云 `/api`**：需要你自己的账号与授权；只能在你获得许可的范围内调用。
  接口清单见 `../04-report/04-api-endpoints.md`。
- **(2) 自建财税后端**：账套/凭证/科目/报表可自研；**发票与申报需要对接税局/电子税务局或第三方服务商**
  （金税、百望、航信、税局开放平台等），这是主要工作量与合规成本。
- **(3) 混合**：自研记账与报表，发票/申报走第三方 SaaS 或人工确认。

> 无论哪条路，`finance_query` 的 `nodeId` 契约、22 个工具名、5 个子智能体、21 份 Skill
> 都可以直接沿用本目录的 `catalog.json`，保持与有数云一致的「Agent 语义层」。

---

### 附：本目录产出

- `catalog.json` — 从 bundle 提取的完整契约（子智能体/工具/查询/技能/协议）。
- `extract_catalog.py` — 可复现的提取脚本。
- `codex/config.toml` — Codex MCP 注册示例。
- `codex/mcp/finance-mcp/` — 可运行的 MCP Server 骨架（22 工具 + skills 资源）。
- `codex/skills/` — 5 份 `SKILL.md` 模板 + references 目录骨架。
