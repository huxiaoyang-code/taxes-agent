---
name: bookkeeping
description: 根据已核实数据登记凭证、查账核对、处理固定资产与期末结转结账。
---

# 智能核算（bookkeeping）

本文件是本机 `finance-mcp` 分支实际可用的记账规则入口。它描述**已经能真实执行**的操作、
调用触发条件和边界，不承诺原站完整会计准则、正式申报或税局能力。字段名与工具名以
`05-reconstruction/codex/mcp/finance-mcp/tools.mjs` 和后端 `06-workbench/server/agent-tools.mjs`
为准；详细规则按需读取 `references/`，不要一次性全部载入。

## 何时使用

用户提出以下任一诉求时使用本技能：

- 把一张/一批原始单据（销售、采购、费用、报销、工资、资产购入等）登记成凭证；
- 查询/核对凭证、科目余额、明细账、试算平衡、资产负债表、利润表、现金流量表；
- 计提折旧/摊销、结转本期损益、年末结转；
- 期末盘点、结账（封账）或反结账。

本技能**不做**：发票采集/查验、开票/红冲、银行流水自动匹配、工资与个税计算、正式纳税申报、
真实电子税务局登录。上述能力本地未接入，对应工具会返回 `not_implemented`，不要假装完成。
发现业务口径 bug（金额、平衡、状态、原子性）时停下并报告管理者，不要为通过测试改口径。

## 可用工具（本分支真实可用）

- 上下文与查询：`account_context`、`finance_context_resolve`、`finance_query`、`finance_query_catalog`
- 规则读取：`skills_list`、`skills_read`
- 账套/科目/期初/期间：`account_set_create`、`account_list`、`account_create`、
  `opening_balance_get`、`opening_balance_set`、`period_list`、`period_set_status`
- 凭证：`voucher_check`、`voucher_create`、`voucher_post`、`voucher_unpost`、`voucher_delete`
- 查账：`ledger_query`
- 资产/折旧/结转：`asset_list`、`asset_create`、`depreciation_run`、`carry_forward_profit`
- 旧账导入：`legacy_book_import`（见 `legacy-book-import` 技能）
- 兼容入口（行为受限）：`update_plan`（仅回显，`persisted=false`）

**不可用（占位，调用必返回 isError，列为可用会误导用户）**：
`invoice_collect`、`invoice_file`、`invoice_issue`、`invoice_issue_result`、`invoice_precheck`、
`invoice_red_apply`、`invoice_red_issue`、`invoice_red_status`、`invoice_tax_code`、
`declaration_query`、`tax_declaration_query`、`exec`、`finance_task_status`。

## 可用查询能力（`finance_query` 的 nodeId）

已实现（`accountSetId` 必填；标 * 的还需 `period`）：

- `enterprise_account.account_set` — 查询账套信息
- `enterprise_account.subject_system.all` — 查询科目体系
- `voucher.generated.list` * — 查询已生成（已过账）凭证
- `voucher.generated.summary` * — 当前与 list 相同，返回凭证列表而非独立汇总
- `voucher.draft.summary` * — 查询草稿凭证
- `voucher.detail` — 读取凭证详情，需 `params.voucherId`
- `report.balance_sheet` * / `report.income_statement` * / `report.cash_flow_statement` * — 三大报表
- `period_end.summary` * — 盘点期间与试算
- `report.trial_balance` * — 试算平衡（本地扩展）
- `ledger.general` * — 科目明细账，需 `params.code`（本地扩展）

**未接入（原站契约存在但本地无数据源）**：`enterprise_account.bank|business|personnel|tax|tax_assessment`、
`enterprise_account.auxiliary_accounting.all`、`fund.unbooked.list|summary`、`invoice.detail`、
`invoice.unbooked.list|summary`。调用返回 `not_implemented`，不得据此报告"已查到"。

## 通用规则

- **账套与期间必须显式**：所有变更与查询都要明确 `accountSetId` 与 `period`（`YYYY-MM`，月份 01–12）。
  `account_context` 不保存"当前账套"（`current_account_set_id` 恒为 null），不要假设上下文持久。
- **金额**：人民币元，保留两位小数；比较金额用容差，禁止直接浮点相等。
- **凭证形态**：`entries` 每项 `{ code, debit, credit, summary? }`，至少两行；借贷合计必须相等；
  单行不能同时有借方和贷方；金额不得为负；`code` 必须是该账套已存在的科目（否则 `voucher_check` 报错）。
- **默认草稿**：`voucher_create` 缺省 `status='draft'`；只有显式 `status='posted'` 或调用 `voucher_post`
  才过账。技能应遵循 `voucher_check` → `voucher_create`（草稿）→ 在当前授权范围内 `voucher_post`，
  只有授权缺失时才向用户确认。
- **审批**：用户已授权的凭证/过账等操作不要重复索取审批；只有权限或授权范围不明确时才询问。
- **不猜数据**：原始单据缺少税率、税额、科目、期间、价税分离依据等关键信息时，先向用户确认，
  不得自行估税或选科目录账。
- **只基于已核实的结构化数据记账**：发票、银行流水、工资等领域本地没有采集/计算能力，
  只能依据用户提供的已核实数据手工登记分录（见对应 reference）。

## 工作流

1. 用 `account_context` 核对账套，用 `period_list` / `finance_query(period_end.summary)` 核对期间状态；
   期间未登记时先 `period_set_status`（`open`）登记。
2. 按业务类型读取对应 reference，确定分录与科目。
3. `voucher_check` 校验分录；通过后 `voucher_create` 生成草稿；在当前授权范围内 `voucher_post` 过账，
   只有授权缺失时才确认。
4. 用 `ledger_query`、`report.trial_balance`、三大报表复核金额与平衡。
5. 期末按 `period-end-bookkeeping.md` 顺序处理折旧、结转与结账。

## 输出约定

- 汇报时给出：账套 ID、期间、凭证 ID 与状态、借贷合计、关键报表数值；未完成或失败的步骤如实说明。
- 失败信息保留后端返回的结构化 `error`（如 `period_closed`、`voucher_invalid`、`opening_unbalanced`），
  不要改写为"已完成"。需要人工确认时明确列出待确认字段。

## 参考（按需读取）

- `bookkeeping/references/invoice-bookkeeping.md` — 发票入账规则（仅限用户已核实数据）
- `bookkeeping/references/bank-transaction-bookkeeping.md` — 银行流水入账规则（无流水数据源）
- `bookkeeping/references/reimbursement-bookkeeping.md` — 报销入账规则
- `bookkeeping/references/payroll-bookkeeping.md` — 工资入账规则（工资系统与个税计算未接入）
- `bookkeeping/references/fixed-asset-bookkeeping.md` — 固定资产入账规则（凭证与卡片分别创建）
- `bookkeeping/references/other-business-bookkeeping.md` — 其他业务入账规则（销售/采购/费用等）
- `bookkeeping/references/period-end-bookkeeping.md` — 期末做账规则（折旧/结转/封账）
