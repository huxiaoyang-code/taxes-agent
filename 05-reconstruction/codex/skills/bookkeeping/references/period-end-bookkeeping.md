# 读取期末做账规则

期末按"核对期间 → 计提折旧摊销 → 结转损益 → 出报表 → 结账"推进。所有操作都必须显式提供
`accountSetId` 和 `period`（`YYYY-MM`）。

## 0. 核对期间

- `period_list({ accountSetId })` 查看已登记期间及状态；未登记的目标期间先用
  `period_set_status({ accountSetId, period, status: "open" })` 登记（期间不得早于账套启用期间，
  否则报 `period_before_start`）。
- `finance_query({ nodeId: "period_end.summary", accountSetId, period })` 盘点期间与试算。

## 1. 计提折旧与摊销

- `depreciation_run({ accountSetId, period })`：直线法、生成一张已过账折旧凭证；同期重复计提幂等。
- 细节与反向操作约束见 `fixed-asset-bookkeeping.md`；建议在结转前完成。

## 2. 结转本期损益

- `carry_forward_profit({ accountSetId, period })`：把本期损益科目结转到 `3103 本年利润`。
- `yearEnd: true` 时再把 `3103`（含下级明细）结转到 `3104 利润分配`。**仅当用户明确指定做年末结转时才传 `yearEnd`**；
  后端不校验是否为 12 月，也不会自动在年末触发，不要自作主张做年末结转。
- 已过账的损益结转再次调用报 `already_carried_forward`；已过账的年末结转报 `already_year_end_carried`。
- 反过账或删除旧的结转草稿后可重新结转；重算时会先清理残留的草稿结转凭证，避免日后过账造成重复。
- 结转凭证 `kind='carryforward'`，**不计入利润表发生额**，因此结转后净利润不会翻倍。
- 操作是原子的：结转（含年末结转）任一步失败会整体回滚，不留下半张凭证或新建的空期间。

## 3. 出报表与核对

- `finance_query` 可用于：`report.trial_balance`、`report.balance_sheet`、`report.income_statement`、
  `report.cash_flow_statement`、`period_end.summary`、`ledger.general`（需 `params.code`）。
- 核对要点：试算平衡（`closing_debit == closing_credit`）、资产负债表 `balanced == true`、
  现金流量表 `reconciles == true`、结转后损益科目余额归零。
- 未分配利润口径：只有在**无历史未分配利润、无利润分配**的测试场景，未分配利润才恰好等于本期利润。
  真实核对需计入 `3104 利润分配` / `3103 本年利润` 的历史余额以及尚未结转的本期损益，
  不要把"未分配利润 = 本期利润"当作普遍断言。
- 金额预期应由业务数据独立推算后再与报表比较，不要只用同源函数互相印证。

## 4. 结账（封账）

`period_set_status({ accountSetId, period, status: "closed" })` 的约束：

- 期间必须已登记（否则 `period_not_found`）；当期不能有草稿凭证（`period_has_draft_vouchers`）；
  试算必须平衡（`period_unbalanced`）。**不强制**先做损益结转。
- 封账后，创建/过账/反过账/删除凭证、计提折旧、结转损益等影响账目的操作一律被拒
  （`period_closed`），且不改变账簿。需要调整时先
  `period_set_status({ accountSetId, period, status: "open" })` 反结账。

## 5. 期初限制

- 已有已过账凭证后不可改写期初（`opening_rewrite_after_posting`）。
- 存在封账期间时不可改写期初（`opening_rewrite_period_closed`）。
- 期初保存必须整体借贷平衡（`opening_unbalanced`），失败不产生部分写入。

## 明确不做

- 不做正式纳税申报、不做税局报税、不登录电子税务局；本技能只封闭账簿期间。
- 不生成正式财务报表文件（Excel/PDF）；本地只返回结构化报表数据。
- 不承诺完整会计准则适配；科目表为小企业会计准则节选，准则字段变化不会自动切换完整科目体系。
