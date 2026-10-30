# 个税直接工具

使用`finance_rules`核实际个税分支、来源及限制，`finance_record_contract`读取工资、官方贡献核定、支付等所需记录类型，`finance_tax_calculate`执行固定算法。税种可按真实合同的`obligationIds`选择`salary_withholding`或其他适用分支。

工具不自动补齐居民身份、扣除资格和历史已扣数据。原始资料载体见[整理输入](../../harness/references/agency-input.md)。输出是本机核对，不是在线个税申报、查询或付款；没有返回应纳时保留未知。
