---
name: invoice-issuing
description: 提取并校验开票信息，选择税收分类编码，并按确认后的完整参数正式开票。
---

# 智能开票（invoice-issuing）

> 模板：原文案在有数云服务端，需按你的实现补全。此文件对应
> `catalog.json -> skill_files -> "invoice-issuing/SKILL.md"`。

## 目标

提取并校验开票信息，选择税收分类编码，并按确认后的完整参数正式开票。

## 可用工具

account_context, finance_context_resolve, finance_query, finance_query_catalog, finance_task_status, invoice_collect, invoice_file, invoice_issue, invoice_issue_result, invoice_precheck, invoice_red_apply, invoice_red_issue, invoice_red_status, invoice_tax_code, declaration_query, exec, list, read, tax_declaration_query, update_plan, voucher_check, voucher_create

## 可用查询能力（finance_query 的 nodeId）

- `enterprise_account.account_set` — 查询账套信息
- `enterprise_account.bank` — 查询银行信息
- `enterprise_account.business` — 查询工商信息
- `enterprise_account.personnel` — 查询人员信息
- `enterprise_account.tax_assessment` — 查询税种核定
- `enterprise_account.tax` — 查询税务信息
- `enterprise_account.auxiliary_accounting.all` — 查询辅助核算
- `enterprise_account.subject_system.all` — 查询科目体系
- `fund.unbooked.list` — 查询未入账银行流水
- `fund.unbooked.summary` — 查询未入账银行流水
- `invoice.detail` — 读取发票详情
- `invoice.unbooked.list` — 查询未入账发票
- `invoice.unbooked.summary` — 查询未入账发票
- `report.balance_sheet` — 查询资产负债表
- `report.cash_flow_statement` — 查询现金流量表
- `report.income_statement` — 查询利润表
- `period_end.summary` — 盘点期末状态
- `voucher.detail` — 读取凭证详情
- `voucher.draft.summary` — 查询草稿凭证
- `voucher.generated.list` — 查询已生成凭证
- `voucher.generated.summary` — 查询已生成凭证

## 工作流（TODO）

1. 用 `finance_context_resolve` / `account_context` 核对账套与期间。
2. 按需用 `finance_query` 读取数据。
3. 变更类操作必须走审批（开票、申报、凭证入账）。
4. 完成后用 `finance_task_status` 汇报结果。

## 输出约定（TODO）

- 金额单位、期间格式、四舍五入规则。
- 失败/待人工确认的处理方式。

## 参考

- `invoice-issuing/references/native-tool-map.md` — 读取开票工具规则
- `invoice-issuing/references/tax-code-filtering.md` — 读取本地赋码规则
