---
name: finance-tools
description: 按业务直接调用本机中国财税工具，核对账目、税费和凭证，并按需追溯自动保存的计算与原件记录。
---

# 本机财税直接工具

此目录保留历史路径兼容，默认业务已改为`direct`工具连接。主Agent自主调查原始资料、判断业务和选择工具；后台自动保存调用、计算及原件索引。不要求手工来源登记、事实登记、版本摘要或运行时任务图。

## 工作流程

### 1. 明确业务与目标

核实企业、实际账套、期间、币种和授权资料。已有目标用`account_context`核实；首次旧账接手按[导入旧账](../legacy-book-import/SKILL.md)调查、预检及导入。不要猜首个账套或用显示名称替代稳定企业身份。

### 2. 只读所需合同

| 任务 | 直接入口与按需参考 |
|---|---|
| 账簿、科目、报表 | 实际`finance_query`、`ledger_query`等工具合同；[核算](references/accounting.md) |
| 原始业务与字段 | `finance_record_contract`；[原件与整理输入](references/agency-input.md) |
| 业务底稿 | `finance_workpaper`；[直接适配](references/adapters.md) |
| 税费、规则与地区限制 | `finance_tax_calculate`、`finance_rules`；[税务](references/tax.md) |
| 全年原件计算 | `finance_annual_workpaper`；[年度核对](../annual-close/SKILL.md) |
| 调查、差异与方案 | [分析](references/analysis.md) |

合同按当前披露完整度给出字段、示例及原生规则引用，不证明客户具备该事实。普通业务优先用`target:{accountSetId,period}`，内部企业/实例身份由后台据实际账库绑定，无需客户提供。缺资料时保留未核项，已有支持的独立业务仍可继续。月、季度和年度范围按实际工具核验。

### 3. 调用和核对

Agent从获准原件整理实际业务输入，调用选中的工具。工具自动保存来源、参数、版本、结果和失败；正常业务不先建立Store、请求事实或DAG。输入中的业务日期、资格、用途及结算状态须有根据，不能为通过校验补造。

核对内层业务状态、金额、凭证、规则及缺项，不将调用成功当作全部业务完成。一般VAT的交易税额不等于本期法定应纳；应纳、计提、实缴和未证实支付分开。

### 4. 交付和深入排错

默认按[报告顺序](references/reporting.md)展示账本金额→凭证/计算结果→规则依据。需要调查时再查工具调用→输入与原件，完整自动记录始终保存。哈希与引用一致不证明语义提取正确。

正式写账、期间更正和恢复使用当前真实业务工具与授权；不直接SQL改账，不伪造人审、申报或付款。结果未知先核原操作，见[恢复](references/recovery.md)。
