---
name: tax-filing
description: 核对中国企业本期税费、抵扣与账税差异，给出申报依据和具体缺件；仅本机底稿，不执行税局申报或缴款。
---

# 中国税费核对与申报依据

主Agent按实际税种和资料选择直接工具，系统记录实际过程，不为Agent编排固定流程。

## 工作流程

1. 核实主体、税务身份、申报频次、期间、地区、资格和原件。福建漳州不自动确定市区分类或所有地方参数。
2. 用`finance_rules`核实适用规则、来源、支持期间和边界；按业务通过`finance_record_contract`读取字段。
3. 用`finance_tax_calculate`实际计算；原始业务整体用`finance_workpaper`，全年原件用`finance_annual_workpaper`。缺件和未覆盖保留状态，不填假的完整资料。
4. 核账面交易税、计提、法定应纳和实缴的区别。引用实际工具结果；模型推导单列，不把工具未返回的due补成0。
5. 按[报告顺序](../harness/references/reporting.md)给账本金额、凭证/抵扣清单和计算、规则依据。说明本月为何这样处理，哪些仍不能确定。调用与原件深入索引始终保存。

## 按需参考

- [企业税费](references/enterprise-tax.md)：一般VAT销项抵扣、留抵、附加、小规模季度和企业所得税。
- [工资等个税](references/individual-income-tax.md)：逐人累计扣缴及合法扣除。
- [本机申报资料核对](references/declaration-data-query.md)：已提供申报表与账税数据对照，不代表在线查询。
- [更正与作废边界](references/correction-cancel.md)：本机更正和实际税务处理区分。
- [年度](references/annual-tax.md)：全年原件、年度计算和未决。
- [29项义务范围](references/supported-obligations.md)：固定分支与地区边界。

没有税局登录、在线采集、正式申报、缴款或开票能力。此名称保留旧入口兼容，不能把本机计算写成已申报。
