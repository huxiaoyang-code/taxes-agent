---
name: bookkeeping
description: 根据中国企业已核实业务直接编制凭证、核对账簿报表、资产和期末处理，保留原件、计算和未决差异。
---

# 中国企业核算

主Agent理解资料并选择直接业务工具，后台自动记录实际调用。工作步骤可按目标和资料调整，不需要先登记来源、事实、计划或运行时依赖图。

## 工作流程

### 1. 明确业务与资料

用`account_context`核实账套，核实际准则、期间、币种和原件。客户提供原始发票、合同、流水、工资或资产资料，内部整理由Agent完成。已有旧账按[旧账导入](../legacy-book-import/SKILL.md)核验，不把人员说明当完整账目。

### 2. 按业务选工具

原始业务通过`finance_record_contract`查字段，以`finance_workpaper`生成实际分录、库存和账税底稿；已有分录用`voucher_check`。按需读取：

| 业务 | 参考 |
|---|---|
| 发票及采购销售 | [发票核算](references/invoice-bookkeeping.md) |
| 银行收付 | [银行](references/bank-transaction-bookkeeping.md) |
| 报销与费用 | [报销](references/reimbursement-bookkeeping.md) |
| 工资 | [薪酬](references/payroll-bookkeeping.md) |
| 资产 | [固定资产](references/fixed-asset-bookkeeping.md) |
| 其他业务 | [其他](references/other-business-bookkeeping.md) |
| 期末 | [期末](references/period-end-bookkeeping.md) |

### 3. 查询与复核

`finance_query`和`ledger_query`取得真实账簿及报表；科目、期初、资产、导入和期间工具按当前合同使用。核对科目用途、金额精度、价税、借贷、数量批次、核销及期间，不将平衡或执行成功当全部业务正确。税费规则及金额交`finance_rules`和`finance_tax_calculate`。

### 4. 草稿与写账

先给凭证草稿及支持计算。按实际授权和工具控制使用创建、过账、反过账或期末操作，保留原始业务和当前账簿引用；不直接SQL改账或绕过期间检查。准备、人审、已入账分别核实，结果未知先核原操作。

### 5. 输出

按[报告顺序](../harness/references/reporting.md)先给账本金额、凭证/计算、规则依据，调用及输入原件供深入排错。未接通的开票、红冲、税局采集、申报、缴款保留不支持，不能因预留工具存在就称已完成。
