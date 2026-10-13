# 读取固定资产入账规则

购入凭证与资产卡片**分别创建、分别验证**。`asset_create` 只建卡片，**不会**自动生成购入凭证；
卡片本身也**不会**增加 `1601 固定资产` 的账面原价——账面原价只来自购入凭证。

## 一、购入凭证

资产达到可用状态时登记（科目以 `account_list` 为准）：

| 科目 | 借方 | 贷方 |
|---|---|---|
| 固定资产 1601 | 原值（不含可抵扣进项税） | |
| 应交税费 2221（进项税额，若可抵扣） | 税额 | |
| 银行存款 1002 / 应付账款 2202 | | 价税合计 |

- 先 `voucher_check`，再 `voucher_create`（默认草稿），在当前授权范围内 `voucher_post`；
  只有授权缺失时才向用户确认。
- 用 `ledger_query({ accountSetId, code: "1601", period })` 或
  `finance_query({ nodeId: "report.trial_balance", accountSetId, period })` 确认 1601 账面原价。

## 二、资产卡片

`asset_create` 参数（字段名以后端 schema 为准）：

| 参数 | 说明 |
|---|---|
| `kind` | `fixed`（缺省）或 `intangible` |
| `name` | 资产名称 |
| `original_cost` | 原值 |
| `residual_rate` | 残值率；固定资产缺省 0.05，无形资产缺省 0 |
| `useful_life_months` | 使用期数（月） |
| `start_period` | 开始计提期间 `YYYY-MM` |
| `asset_account` / `accum_account` | 缺省固定资产 1601 / 1602，无形资产 1701 / 1702 |
| `expense_account` | 折旧/摊销费用科目，缺省 5602 |

创建后用 `asset_list` 核对卡片：`original_cost`、`depreciable`、`monthly`、`remaining`、`accumulated`。
卡片不会写凭证，此时 `1601` 原价应仍等于购入凭证金额，不得重复计算。

## 三、计提折旧/摊销

- `depreciation_run({ accountSetId, period })`：按直线法对全部卡片计提，生成**一张已过账**折旧凭证。
- 月折旧 = `原值 × (1 − 残值率) ÷ 期数`，逐期按两位小数取整；因每期取整，尾差**可能**落在
  到期后的后续期间补提，而非一定在"到期期间"一次提足。例：原值 1000、残值率 0、3 期，
  前 3 期各 333.33，第 4 次计提再补 0.01 才提足。这是当前实现的已知限制，如实告知用户。
- 同期重复计提幂等：返回 `voucher: null`，不重复入账。
- 折旧凭证 `kind='depreciation'`，进入损益（默认 `5602`），不影响 1601 原值、只增加 1602。
- 用 `asset_list` 的 `accumulated` 与总账 `1602`、卡片 `original_cost` 与总账 `1601` 交叉勾稽。

## 四、反向操作与一致性规则（已修复，必须遵守）

- 反过账折旧凭证后，卡片累计只统计**已过账**计提；重新过账会恢复累计。
- 同期存在**未过账**的计提记录时，`depreciation_run` 报 `depreciation_draft_exists`，必须先把该草稿
  删除或重新过账，不得据"无需计提"或双重入账。
- 恢复一张被反过账的旧折旧凭证时，会校验"该资产其他已过账累计 + 本凭证计提 ≤ 可折旧额"；
  超出则整单拒绝 `depreciation_exceeds_depreciable`，**绝不部分过账**，账簿与卡片保持不变。
  合法且未超额的恢复不受影响；删除被拒的旧草稿后仍可合法重算，不会永久阻塞。
- 折旧凭证删除会同步清理计提记录（`asset_depreciation_runs`），删除前必须先反过账。

## 五、封账与期初限制

- 期间 `closed` 时 `depreciation_run`、凭证创建/过账/反过账/删除、结转均被拒绝（`period_closed`）；
  先 `period_set_status(..., "open")` 反结账。
- 已有已过账凭证或存在封账期间后，不能改写期初余额
  （`opening_rewrite_after_posting` / `opening_rewrite_period_closed`）。

## 明确不做

- 不自动生成购入/处置凭证，不做资产处置、清理（1606 仅科目存在，无专用工具）、减值、重估。
- 不导入资产台账 Excel；卡片需按用户提供并核实的原值、残值率、期数创建。
