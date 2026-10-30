---
name: invoice-issuing
description: 核对已有中国发票及合同资料的账税用途和原件关联，明确本机尚无正式开票、红冲、采集或查验能力。
---

# 发票资料核对

本入口保留历史名称，只核对已有资料并接入实际核算，不表示开票服务已连接。

## 工作流程

核实际发票、合同、交付、收付、用途和红字关联；资料或文件名不是查验结果。用`finance_record_contract`查相应业务，以`finance_workpaper`核对账务，税费及抵扣使用`finance_tax_calculate`和`finance_rules`。仅因取得专票不能直接断言本期允许抵扣。

税目、发票类别和税收分类编码的判断需原件及规则；本机没有正式开票、红冲、自动税码选择、在线发票采集或查验。不能调用占位接口制造成功。已有支持的核算可继续，不依赖待开票分支。

按[报告顺序](../harness/references/reporting.md)给金额、凭证/计算和规则依据，保留发票与原件索引。见[工具范围](references/native-tool-map.md)及[税码边界](references/tax-code-filtering.md)。
