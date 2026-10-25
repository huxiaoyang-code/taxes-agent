---
name: tax-filing
description: 发现现有离线税务计算与复核范围，记录不支持分支；本机未接通税局申报。
---

# 离线税务与支持范围

业务入口见 `harness/SKILL.md`，按需读 `harness/references/tax.md`。先发现实际能力，依据原始资料调查税务属性和历史，不要求客户提供固定模板或已算好的申报数字。现有模块只覆盖明确条件下的离线 VAT 部分字段与复核，不代表全税种、年度汇算或正式申报。

全国电子税务局真实接入数为0。登录、在线采集、申报提交、缴款、更正/作废申报在本 Harness 范围外；目录/预留工具存在不代表接入。`invoice_*` 开票占位、`declaration_query`、`tax_declaration_query`、`finance_task_status`、`exec` 不得列为本机可用工作流。

任务、具体补件、计算回执、会计反馈和恢复使用 `harness_*`；`update_plan` 仍仅回显。保留可执行核算分支，不把税务阻塞隐藏或猜成完成。该目录原 references 为历史模板，仅调查历史描述时读取，不作为可执行规则。
