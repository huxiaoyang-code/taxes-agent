# 会计金额精度 · 期末完整性 · 连续期间契约（LOCAL-02）

- 任务：[tasks/LOCAL-02](tasks/LOCAL-02.md) · 交接：[handoffs/LOCAL-02](handoffs/LOCAL-02.md)
- 远端载体：[Issue #47](https://github.com/huxiaoyang-code/youshu-fork/issues/47)（`Refs #20` / `Refs #13` / `Refs #14`）
- 代码：`06-workbench/server/money.mjs`、`period-end-controls.mjs`，以及 `accounting.mjs` / `import-storage.mjs` /
  `server.mjs` / `agent-tools.mjs` / `finance-mcp/tools.mjs` 的接线。
- 本契约只覆盖**本机会计域**（金额、计提、结转、封账、反操作）。两套准则的科目 / 报表映射与辅助核算属 LOCAL-03，
  复杂现金流口径属 LOCAL-05b；税局现场暂停、真实接入数仍为 **0**，本契约不含任何税局能力。

---

## 1. 金额精度与舍入（唯一规则）

| 项目 | 规则 |
|---|---|
| 最小单位 | **分（整数分）**。内部一律用 BigInt 整数分计算，落库 / 出参时再转两位小数 Number。 |
| 舍入 | **ROUND_HALF_UP（四舍五入，远离零）**，只作用于「转成分」这一步。 |
| 输入判定 | 直接按十进制文本 / 最短往返十进制表示判定，**不先做浮点乘法**，因此 `1.005 → 1.01`，不会得到 `1.00`。 |
| 两位以上小数 | 逐笔四舍五入到分后再求和；合计在整数分上完成（`1.005 + 0.005 = 1.02`）。 |
| 单笔上限 | `999999999999.99`（12 位整数 + 2 位小数，**本包不扩大上限**）。超界按**完整原值**判定：`999999999999.994`、`999999999999.9900000001` 一律拒绝，不因舍入被收进界内。 |
| 负数 | 按完整原值判定（含 `-0.001`、`-1e-10`、`-0.000…1`）；会计金额不接受负数金额，一律拒绝，绝不因为舍成 0 而被接受。 |
| 极小正值 | 非零但不足一分（如 `0.001`、`1e-7`、`0.0049`）带 `subCent` 标记：凭证**逐个金额字段**（借方 / 贷方）、期初、导入期初一律**拒绝**，不会静默写成 0。`0.001` 不被允许“舍成 0 后仍算合法分录”。 |
| 非法类型 | `NaN` / `Infinity` / 对象 / 数组 / 布尔 / 指数记法 / 千分位（凭证入口）一律拒绝，不按 0 兜底。 |
| 存续金额 | 累计余额、补项期初累计等**不受单笔上限约束**（按「整数分可精确表示」范围，`±(2^53−1)` 分）。单笔上限只管单笔金额。 |
| 合计输出 | 转回 Number 前必须能「十进制最短表示 → 再解析」精确还原为同一分数；不能保分即抛 `money_total_not_representable`，绝不返回少一分 / 多一分的数字。 |
| 保留格式 | 导入既有合法格式保持不变：`¥` / `￥` 前缀、千分位、空白按 0、缺省值为空。 |

覆盖的数值路径：凭证分录与合计、期初余额、导入（含 CSV / JSON）、资产卡片原值 / 残值 / 累计、折旧摊销、
损益结转与年末结转、科目余额、试算平衡、资产负债表、利润表、现金流量表、明细账。报表合计全部在整数分上完成，
不再用 `COALESCE(SUM(...))` 对 REAL 求和。

`06-workbench/server/report-export.mjs` 是独立的导出 DTO 层（RC-B / LOCAL-05b 范围），本包不改它；
它读取的落库值本身是「分精度已归一」的两位小数，输出前用带 EPSILON 的两位小数归一，因此不会引入新的误差。

## 2. 折旧 / 摊销与卡片

### 2.1 分期表（累计舍入）

```
可计提及额 = 原值 − 残值            // 残值 = 原值 × 残值率，四舍五入到分
月额       = 可计提及额 ÷ 期数 向下取整到分
第 k 期额  = k < 期数-1 ? 月额 : 可计提及额 − 月额 × (期数-1)
```

- 寿命内**恰好**提足：`100 元 / 3 期 = 33.33 + 33.33 + 33.34 = 100.00`；寿命外不再计提（不得把尾差推到寿命之后）。
- 极小金额按分取整后前期月额为 0（如 `0.05 元 / 12 期`）：前期状态为 `no_amount_due`（不阻塞封账），
  最后一期一次提足 0.05。
- 跨年连续期间（如 `2026-11 → 2027-02`）按期序计算，不构造具体日期。
- **取单期金额是 O(1)**（`money.evenSplitAmountCents`），不需要展开整张分期表；`splitEvenlyCents`（会展开数组）
  上限 `MAX_SCHEDULE_PERIODS = 1200` 期，防止巨大期数线性吃内存。
- **计提期数是受验证的输入**：卡片写入（新增 / 修改）只接受 `1 ~ 1200` 的整数（`useful_life_months`
  为负 / 0 / 非整数 / `2^32` 一类巨大值 → `useful_life_months_invalid` / `useful_life_months_out_of_range`）。
  1200 期是**技术输入边界，不是法定会计年限**；实际寿命仍由操作者按准则判断。落库与 DTO 构造在同一个保存点内，
  任何后续计算失败都整体回滚，不会留下“卡片已落库但列表 / 期末检查持续报错”的半成品。

### 2.2 取得期间 ≠ 计提开始期间

- `start_period`：**开始计提**的期间（可为空档之后，例如取得于 12 月、1 月开始计提）。
- `acquired_period`：显式登记的**取得 / 入账期间**，参与「该期间是否存在」的判断。
- 缺 `acquired_period` 时**不回落**到 `start_period`：卡片按「已存在」保守参与原值核对，并给出结构化缺项
  `asset_acquired_period_missing`（可经 `asset_update` 补登记后解除），不会伪造「前期不存在 / 本期刚购入」的证据。
- 历史卡片可用 `origin=supplement` + `opening_accumulated`（已入账历史累计）补项；补项不改既有金额，只让核对可解释。
- **适用期只有一套判定**（`expectedDepreciationCents`）：取得期间晚于被查询 / 被生成期间的卡片状态是 `not_existed`
  （理由里带登记取得期间）：`generateDepreciation` 对该期间**不生成任何计提凭证**（`voucher: null` + `skipped`），
  期末检查的 `depreciation` 步骤也不把它算作「应计提未计提」。「卡片尚未取得」与「未到起提期间」分开报
  （`not_existed` / `not_started`），两者都不阻塞封账。
- 反过账 → 删除旧计提 → 改 `acquired_period`（把取得 / 入账期间后移）之后，**同一期间不会再被写回旧金额**：
  生成与验证共用同一个 helper，不会出现「生成时按分期表写入 → 检查立刻判 stale → 删除后又写回」的循环。
  若旧库（或修改前的落库）已留下「取得期间之前」的已过账计提，一律按已过账 ≠ 已完成处理：状态 `posted_stale`、
  `depreciation_run_stale`（`expectedStatus = not_existed`）、阻止封账并给「反过账 + 删除旧计提凭证」的撤销顺序；
  撤销后该期间不再被写回错误凭证，检查恢复。真实矛盾（总账仍有原值、卡片说该期间不存在）由
  `asset_reconciliation` 如实报 `asset_missing_card`，需把购入 / 期初入账凭证调到真实取得期间，而不是改判定规则迁就。
- 若卡片同时把起提期间留在取得期间之前（`start_period < acquired_period`，本身就是矛盾登记），取得后按分期表序号
  继续，不会自动跳期：寿命外仍未提足时 `depreciation` 步骤如实报 `life_expired`（阻止封账），修法是
  「反过账 + 删除旧计提 run → 把 `start_period` 改到 ≥ `acquired_period` → 重新计提」。规则不把这种矛盾抹平。

### 2.3 期间口径 vs 全局口径

- 卡片列表（`listAssetCards`）展示「迄今」累计（全部已过账计提 + 补项期初累计）。
- 期末检查 / 计提状态（`assetCardPeriodStatus`）按**被查询期间**计算：累计只含**本期及以前**的已过账计提，
  并按同一口径给出 `remaining`；另给 `accumulatedTotal`（全局，仅参考）。
- **历史状态与执行上限分离**：历史 `status` / `accumulated` / `remaining` / 应提额只由「截至该期间」的事实决定，
  **不用未来已计提的全局余额**决定 `not_started` / `fully_depreciated` 或截断历史应提额。
  例：100 元 / 3 期卡片在 1、2、3 月已提足后查询 **2025-12**（计提开始前）仍必须是 `not_started`、累计 0、剩余 100。
- 本期应计提额 = `min(分期表金额, 期间口径剩余额)`；**执行时**另有全局总额守卫：
  若 `opening_accumulated + 全部已过账计提 + 本期应提 > 可计提额`（旧库后期 run / 多提），
  `generateDepreciation` 明确拒绝 `depreciation_global_over_depreciable` 并给撤销顺序，
  不改写历史 DTO 来掩盖超提。

### 2.4 卡片与总账核对

| 项 | 规则 |
|---|---|
| 资产侧 | `ledger_status=booked` 且在该期间已存在的卡片原值合计 ↔ 总账 `1601 / 1701`（含下级）自然余额 |
| 累计侧 | 全部卡片的 `opening_accumulated + 截至该期间已过账计提` ↔ 总账 `1602 / 1702`（含下级）自然余额 |
| 缺卡片 | 总账资产科目有余额但没有卡片 → `asset_missing_card`（阻止封账，可用补项卡片解除） |
| 差异 | 原值不一致 → `asset_cost_mismatch`；累计不一致 → `asset_accumulated_mismatch`（均带科目、总账值、卡片值、差额） |
| 未入账登记 | `ledger_status=pending_purchase_voucher` + `ledger_note`（必填）：**不是原值差异豁免**。登记只表示「购入凭证待补」，仍必须参与原值核对并额外报 `asset_purchase_voucher_pending`；`depreciation` 步骤会把该卡片报为 `asset_ledger_pending` 并阻止计提与封账 |
| 解除阻塞 | 只能是真实补录购入 / 期初入账凭证后核对一致，再把卡片改回 `booked`；任意 `ledger_note` 都不能替代 |
| 已过账后锁定 | 已有已过账计提时，禁止改原值 / 残值率 / 寿命 / 计提开始期间 / 期初累计 / 账簿状态 / 资产与累计科目（`asset_card_locked_by_posted_runs`）；名称、费用科目、取得期间、备注仍可维护 |
| 封账后锁定 | 受影响期间（取得期间 / 计提开始期间起算）已有封账时，任何事实字段变更都拒绝（`asset_card_affects_closed_period`）；名称 / 备注等纯显示信息可改 |

卡片维护入口：`PATCH /api/account-sets/:id/assets/:assetId`、Agent / MCP `asset_update`、Web `GET /assets`
与 `POST /assets`（新增，支持上述补项字段）。

### 2.5 「已过账」不是「已完成」：计提定义一致性

一张计提凭证只代表卡片**当时定义**下的应提额。任何影响计提定义的字段变了，旧凭证（草稿或已过账）都不再成立：

| 字段 | 影响 |
|---|---|
| `useful_life_months` / `original_cost` / `residual_rate` | 分期表金额（月额） |
| `start_period` | 期序（当期是否到计提期） |
| `acquired_period` | 该期间卡片是否存在 |
| `opening_accumulated` | 截至本期剩余可计提额 |
| `ledger_status` | 是否允许计提（未入账不得计提） |
| `asset_account` | 卡片与总账核对的原值科目（由 `asset_reconciliation` 步骤报差异，不影响计提凭证分录） |
| `accum_account` / `expense_account` | 计提凭证分录科目，改变后旧凭证与卡片不一致 |
| `name` / `ledger_note` | 纯显示信息，**不影响**一致性判断（不无意义锁死） |

- 反过账后改定义再**重过账旧草稿**会被拒绝：`depreciation_run_stale`（`details.stale` 给资产 / 期间 / 旧金额 /
  当前应提额 / 原因；科目变更则给 `entries` 差异），`guidance` 指明「删除旧草稿（连带旧 run）→ 按当前定义重新计提」。
  **不接受静默改写原凭证，也不接受旧草稿直接恢复过账。**
- 期末检查与 `generateDepreciation` 用同一口径重算：已过账金额与当前定义不一致时状态为 `posted_stale`，
  计提步骤报 `depreciation_run_stale` 并阻止封账（不再把「存在已过账 run」当作已完成）。
- **「本期没有计提记录」这一支不再自己算适用期 / 金额**：`assetCardPeriodStatus` 直接复用 `expectedDepreciationCents`
  （与校验已过账计提、`assertDepreciationRunsCurrent` 同一个 helper）。两处各写一套会导致自相矛盾：
  生成按分期表写入一个「卡片当时还不存在」的期间计提，检查又立刻判它 `posted_stale`，
  用户按指引删除后重新生成又写回同一张错误凭证（业务路径陷入循环）。
- 可执行解除路径：`反过账 → 删除旧计提凭证（连带 run）→ 按期间顺序重新计提 → 重新结转 → 重新检查 / 封账`，
  与 F2 的倒序撤销一致；历史已过账金额在未被撤销前按原样保留，不被静默改写。

## 3. 期末检查与封账前置

`buildPeriodEndCheck`（HTTP `GET /api/account-sets/:id/period-end-check?period=`、Agent / MCP `period_end_check`）
逐步返回 `ok` / `blocked` / `not_applicable` 与理由、阻塞项（`code` + 明细）和明确缺项；
封账 `setPeriodStatus(..., "closed")` 与它**共用同一套规则**。

| 步骤 | 适用条件 | 阻止封账的情形 |
|---|---|---|
| `draft_vouchers` | 总是适用 | 本期仍有草稿凭证（先过账或删除） |
| `trial_balance` | 总是适用 | 期末借贷不平 |
| `depreciation` | 账套有资产卡片；无卡片 → `not_applicable` | 本期应计提未计提（`depreciation_missing` + 应提金额）、本期有未过账计提（`depreciation_draft_exists`）、已过寿命仍未提足（`depreciation_life_expired_underprovided`）、卡片登记为未入固定资产账（`asset_ledger_pending`）、**已过账但与卡片当前定义不一致（`depreciation_run_stale`）**。取得期间晚于该期间的卡片为 `not_existed`（不阻塞，也不会被生成计提） |
| `asset_reconciliation` | 有卡片或相关总账科目有余额；都没有 → `not_applicable` | 缺卡片 / 原值差异 / 累计差异 / 缺取得期间 / **该期间已存在**卡片的未入账登记（`asset_purchase_voucher_pending`，且如实报原值差异）。取得期间晚于查询期间的卡片不提前计入阻塞；缺取得期间按「已存在」保守报告 |
| `profit_carry_forward` | 本期有损益发生或有未结转损益余额；都没有 → `not_applicable` | 损益类科目仍有余额：未结转（`profit_not_carried_forward`）或结转后又有损益分录（`profit_carry_stale`） |
| `year_end_carry_forward` | 12 月且 3103 有余额；非 12 月 → `not_applicable` | 12 月末 3103 未结转（`year_end_not_carried`） |
| `period_sequence` | 总是适用 | 更晚期间已封账（`later_period_closed`）；更早有业务证据的期间未封账：已有凭证（`previous_period_open`）**或**仍有应计提而未计提的资产（`previous_period_depreciation_pending`，零凭证也算业务）。真正无适用业务的空期间不阻塞 |

- 每一步都说明「不适用理由」，不对所有企业一刀切要求同一动作：无资产 / 无损益 / 非年末均显式 `not_applicable`。
- **只认业务证据，不认「曾经执行过」标志**：结转步骤重新核对损益类科目余额，结转后再补损益分录会被判为失效并阻止封账。
- 拒绝封账时期间状态、账簿完全不变（`period_end_check_failed` 带逐步明细）。

## 4. 反操作 / 前期变动对后续期间的影响

### 4.1 依赖是「实际读取的余额」，不是「曾经执行过」

| 后继派生结果 | 实际读取 | 因此依赖 |
|---|---|---|
| 普通损益结转（`carryForwardProfit`） | 截至该期的**累计**损益类科目余额（`accountBalances`） | **所有前期**损益发生额、前期结转、前期折旧 / 摊销（费用） |
| 资产计提（`asset_depreciation_runs`） | 卡片事实（原值 / 残值 / 寿命 / 计提开始 / 补项累计 / 账簿状态）+ 截至该期已过账计提 | 同一卡片的前期计提状态、卡片金额 / 期间事实 |
| 年末结转（3103 → 3104） | 本年 `3103` 余额 | 本年全部损益与普通结转 |

「普通结转只依赖本期」是错误假设并已废弃：1 月收入 100 + 2 月收入 20 时，2 月普通结转会结转 120，
因此它依赖 1 月。**未封账的后期同样受守卫保护**（判断依据不是期间状态，而是已过账派生凭证是否存在）。

统一守卫 `assertPeriodMutable(db, setId, period, { operation, touches })`，`touches` 由写入口按实际内容给出：

| 写入口 | touches | 受拒的后续依赖 |
|---|---|---|
| 新建 / 过账 / 反过账凭证 | 分录命中损益科目 或 `kind=carryforward` → `profit`；`kind=depreciation` → `depreciation` | `later_profit_carryforward_depends_on_period` / `later_depreciation_depends_on_period` |
| 删除草稿凭证 | 无（草稿不在任何已过账余额里） | 仅更晚封账 / 年末结转 |
| 计提（新增本期） | `profit`（折旧费用进入损益） | `later_profit_carryforward_depends_on_period` |
| 结转 | `profit` | 同上 |
| 资产卡片新增 / 修改 / 删除 | 按字段：金额 / 期间 / 账簿状态 / 科目 / 取得期间 | `asset_card_affects_closed_period`、`asset_card_locked_by_posted_runs`、`later_profit_carryforward_depends_on_period` |
| 期初写入 | 既有约束已要求「本账套无已过账凭证、无封账期间」 | 因此不存在可依赖的后期派生结果（无需额外依赖检查） |
| 增量导入 | 经 `createVoucher` → 与手工凭证同一守卫 | 同上（HTTP 409 + `details`，单事务回滚） |

### 4.2 拒绝顺序与可执行撤销路径

| 情形 | 结论 |
|---|---|
| 目标期间本身已封账 | `period_closed`（既有行为） |
| **更晚期间已封账** | `later_period_closed`，`details.laterClosedPeriods` + 按倒序反结账 |
| **更晚期间已有已过账年末结转** | `later_year_end_carryforward_depends_on_period`，先反过账该年末结转 |
| **更晚期间已有已过账普通损益结转** | `later_profit_carryforward_depends_on_period`，`details.dependencies`（凭证） |
| **更晚期间已有已过账计提** | `later_depreciation_depends_on_period`，`details.runs`（资产 / 期间 / 凭证） |
| 资产卡片事实影响已封账期间 | `asset_card_affects_closed_period`，`details.closedPeriods` |
| 卡片已有已过账计提时改金额 / 期间 / 账簿状态 / 科目 | `asset_card_locked_by_posted_runs`，`details.postedRuns` |
| 旧草稿计提凭证与卡片当前定义不一致（改寿命 / 原值 / 残值 / 期间 / 期初累计 / 账簿状态 / 科目） | `depreciation_run_stale`（重过账时拒绝），期末检查 / 计提入口同一结论，`details.stale` / `guidance` 给删除重算顺序 |

正确顺序（文档化的可执行路径）：

```
反结账更晚期间（倒序）
  → 反过账 / 删除更晚期间的普通结转、计提、年末结转（倒序）
  → 修改 / 补项前期（凭证、卡片、期初）
  → 按期间顺序重新计提 / 重新结转（yearEnd=true）
  → 重新运行期末检查并封账
```

- 已封账的后期不允许把前期重新打开：`setPeriodStatus(period, "open")` 同样走该守卫（反结账本身不改余额，因此不额外要求撤销结转）。
- 拒绝一律在写库之前判定，失败后账簿与期间状态完全不变。
- 重复动作不重复入账：同期重复计提返回 `voucher: null`；重复结转返回 `already_carried_forward` /
  `already_year_end_carried`；重复封账幂等返回 `closed`。
- 结转已失效时 `carryForwardProfit` 返回 `carryforward_stale`（带残留科目余额与处理顺序），
  而不是笼统的「曾经执行过」。

## 5. 持久结构与迁移（schema v4）

只做**加列**，不改旧行语义，不新建业务表：

| 列 | 默认 | 含义 |
|---|---|---|
| `asset_cards.acquired_period` | `NULL` | 显式取得 / 入账期间；`NULL` = 未登记（报缺项，不推测） |
| `asset_cards.opening_accumulated` | `0` | 补项期初累计（已入账历史累计折旧 / 摊销） |
| `asset_cards.ledger_status` | `'booked'` | `booked` / `pending_purchase_voucher` |
| `asset_cards.ledger_note` | `''` | 未入账 / 补项原因（非 `booked` 时必填） |
| `asset_cards.origin` | `'purchase'` | `purchase` / `supplement` / `import` |

迁移沿用 LOCAL-01 机制：**先做迁移前一致备份（含 WAL 已提交数据）→ 备份之后在同一事务内加列 + 记录版本**；
失败整体回滚（版本、列、业务数据都不变），失败尝试的备份保留为孤儿、重试重新备份（不复用过期快照）。

**回退**：停后端 →（先另行复制现库留档）→ 用 `schema_backups` 记录的备份覆盖 `workbench.db` → 删除残留
`-wal` / `-shm` → 重启（会重新迁移并再备份一次）→ 逐项核对。回退把库带回**快照时点**，备份时点之后新增的
业务会丢失，必须先保护现库并停写。完整业务备份 / 恢复体系仍归 LOCAL-06，本包不冒充完成。

### 5.1 备份工具的 v3 / v4 兼容边界（LOCAL-06 备份子包）

已合并的 `06-workbench/server/local-backup.mjs` / `scripts/local-backup.mjs`（LOCAL-06 备份子包）在
**v3 与 v4 各持有独立的真实结构契约**（列 / 类型 / NOT NULL / **默认值** / 主键 / UNIQUE / 外键完整集合与动作 /
迁移记录连续性）：

- **v4 备份**：按上面 5 列的真实 `ALTER TABLE` 契约校验（`acquired_period TEXT` 可空；
  `opening_accumulated REAL NOT NULL DEFAULT 0`、`ledger_status TEXT NOT NULL DEFAULT 'booked'`、
  `ledger_note TEXT NOT NULL DEFAULT ''`、`origin TEXT NOT NULL DEFAULT 'purchase'`），默认值必须逐字一致；
- **v3 旧备份**：按 v3 契约**只读验证**并**原样**恢复到全新目录（不迁移备份也不迁移源库）；
  恢复出来的库仍是 v3，只有在**显式交给当前产品打开**时才走本包的 v3→v4 迁移（先落
  `workbench.db.pre-v4-*.bak`）；升级后新列按默认值落为 `NULL / 0 / 'booked' / '' / 'purchase'`，
  旧卡片因此会如实报 `asset_acquired_period_missing` / `asset_accumulated_mismatch`（不会凭空补出历史累计）；
- **仍然拒绝**：v0 / v1 / v2 旧库（`schema_outdated`）、未来 v5+（`schema_unsupported`）、
  bank / batch / audit 等尚未合入的组件表（`unexpected_tables`），以及只抬高版本号而结构仍是旧版本、
  缺列、错误默认值 / NOT NULL / 类型、迁移记录不连续的伪结构（`structure_invalid` + 具体 `kind`）。

因此本包的 v4 迁移与 LOCAL-06 备份可共存：先按 v4 契约备份新库，同时仍能验证 / 恢复旧 v3 备份。
口径细节与错误码见 [LOCAL-BACKUP](LOCAL-BACKUP.md) §4 / §5。

## 6. 错误码（结构化）

| code | 含义 |
|---|---|
| `money_negative` / `money_not_finite` / `money_not_decimal` / `money_type_invalid` / `money_over_limit` | 金额输入非法 / 超界 |
| `money_total_out_of_range` / `money_total_not_representable` | 合计超出可精确表示范围 / 无法保分输出 |
| `period_end_check_failed` | 封账前置未通过（`details.blocking` 逐项） |
| `depreciation_missing` / `depreciation_draft_exists` / `depreciation_life_expired_underprovided` | 计提缺项 |
| `asset_ledger_pending` / `depreciation_global_over_depreciable` / `depreciation_exceeds_depreciable` | 未入账卡片不得计提 / 全局累计会超可计提额 / 重过账会超可计提额 |
| `depreciation_run_stale` | 旧草稿 / 已过账计提及与卡片当前定义（金额或科目）不一致：必须反过账 + 删除后重算 |
| `useful_life_months_invalid` / `useful_life_months_out_of_range` | 计提期数不是正整数 / 超过技术上限（1 ~ 1200 期，非“法定年限”） |
| `asset_missing_card` / `asset_cost_mismatch` / `asset_accumulated_mismatch` / `asset_acquired_period_missing` / `asset_purchase_voucher_pending` | 卡片 / 总账核对 |
| `asset_card_locked_by_posted_runs` / `asset_card_affects_closed_period` / `ledger_note_required` / `ledger_status_invalid` / `acquired_period_invalid` | 卡片维护 |
| `profit_not_carried_forward` / `profit_carry_stale` / `year_end_not_carried` / `previous_period_depreciation_pending` | 结转与连续期间 |
| `later_period_closed` / `later_year_end_carryforward_depends_on_period` / `later_profit_carryforward_depends_on_period` / `later_depreciation_depends_on_period` | 前期变动 / 卡片维护依赖守卫 |
| `previous_period_open` / `period_has_draft_vouchers` / `period_unbalanced` / `period_closed` | 既有封账错误码（保留） |

HTTP 映射：封账前置 / 前期变动守卫返回 **409**（带 `details`）；金额与参数错误返回 400；
Agent / MCP 侧保留同一 `code` 与 `details`。

## 7. 下游接口（供 LOCAL-03 / 04 / 05 / 06 / 07 使用）

- 金额：`money.mjs` 的 `parseMoney` / `requireCents` / `storedCents` / `centsToNumber` / `formatCents` /
  `sumCents` / `mulCentsByRatio` / `mulDivCents` / `evenSplitAmountCents`（O(1) 取单期） / `splitEvenlyCents`
  （展开整表，上限 `MAX_SCHEDULE_PERIODS`） / `monthsBetween`。
  **新代码禁止**再用 `Math.round(x*100)/100` 或 SQL `SUM()` 直接汇总金额。
- 卡片：`cardMoney(card)`（含 `amountAt(index)` 的 O(1) 分期口径）、`assetCardPeriodStatus(db, card, period)`、
  `expectedDepreciationCents(db, card, period)`（按当前定义重算单期应提额，用于校验旧计提是否失效）、
  `cardAcquiredPeriod(card)` 是唯一口径；新增字段向下兼容（旧行默认 `booked` / `0` / `NULL`）。
- 卡片维护：任何 add / update / delete 必须先进 `assertAssetCardWriteAllowed(db, setId, { operation, previous, next })`，
  不要绕过它直接改 `asset_cards`（否则会再次打开「已封账后被静默改事实」的缺口）。
- 期末：`buildPeriodEndCheck(db, setId, period)`（只读）、`assertPeriodCloseable(...)`（封账）、
  `assertPeriodMutable(db, setId, period, { operation, touches })`（前期可改性，`touches` 必须按实际写入的
  损益 / 计提影响传入）、`laterProfitCarryforwards` / `laterDepreciationRuns`（依赖探测）。
  LOCAL-07 批量任务应直接复用这些，不要另写一套封账规则。
- 期初 / 凭证 / 导入的金额入口统一走 `money.mjs`；LOCAL-04 银行对账、LOCAL-05b 现金流也要沿用同一分精度规则。

## 8. 已知限制（不在本包范围）

1. 两套准则的科目 / 报表映射与辅助核算（项目 / 部门 / 往来）→ **LOCAL-03**；本包只统一金额与期末规则。
2. 现金流量表的「按对方科目前分摊」仍是近似口径（本包改为分上精确分摊并把余数补给最后一项，保证与现金变动勾稽），
   复杂现金流口径 → **LOCAL-05b**。
3. `report-export.mjs` 的独立汇总层未改写（LOCAL-05b / 05a 范围），只保证输入值是分精度归一值。
4. 完整审计留痕、业务备份 / 恢复体系 → **LOCAL-06**；本包只有迁移前最小备份与回退手段。
5. 批次取消 / 多账套批量编排 / CLI → **LOCAL-07**。
6. 空期间不会被自动登记：封账只要求「更早有业务证据（凭证或应计提资产）的期间」已封账；完全没有适用业务的月份不阻塞后期封账，
   但后期封账后再回填该月份会被 `later_period_closed` 拒绝，需按倒序反结账。
7. 增量导入的**预检**阶段未单独预判「后续结转 / 计提依赖」：预检只报已封账等既有冲突，依赖冲突在正式写入时由同一守卫
   拒绝（HTTP 409 + `details` + 事务回滚，库不变）。统一预检归 LOCAL-07 批量编排。
8. 税局现场暂停、真实接入 **0**；本契约不涉及税局、银行、浏览器或凭据。
9. 计提期数上限 `1200` 期是**技术输入边界**（避免巨大期数把分摊 / DTO 计算推入不可控规模），
   不是任何准则下的法定折旧年限；准则口径的“合理寿命”仍需 LOCAL-03 的双准则映射与人工判断。
10. 旧库若已存在直接用 SQL 写入的不合法寿命（`<= 0` / 非整数），读路径仍会报错；API 已不再能产生这类行，
    需要时由维护入口按 `1 ~ 1200` 的整数修正（本包不提供批量修复脚本）。
11. 本轮回工（review2）**未新增存储列**：schema 仍为 v4 的同一 5 列，真实 v3→v4 升级 / WAL 备份恢复验证保持不变。
