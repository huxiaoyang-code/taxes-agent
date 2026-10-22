# 交接 · LOCAL-02 会计金额、期末完整性与连续期间

- 任务单：[tasks/LOCAL-02](../tasks/LOCAL-02.md) · 契约：[ACCOUNTING-PERIOD-INTEGRITY](../ACCOUNTING-PERIOD-INTEGRITY.md)
- 负责人：`huxiaoyang-code`（已核实）；远端载体：[Issue #47](https://github.com/huxiaoyang-code/youshu-fork/issues/47)
  （`Refs #20` / `Refs #13` / `Refs #14`）
- 基线（源码）：`1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（LOCAL-01 源码 PR #46 合并）
  - 工作区已由管理者快进到 `94a79ef4a5e1c19e1320aed2e848ba42a7121712`（LOCAL-01 交接 PR #48，仅 10 个文档，源码无变化）
- 分支：`codex/huxiaoyang-code/local-02`
- 状态：**最终候选已独立审查通过（每项在各自候选上独立接受：核心 `review_core02_final` 在 `bd05415fe6de080b41f0dd9f6f56fb1f57d8dae0`、其业务源码经后续到 98a 未改变；输出协议 `review_output08_final` 在 `3a8ae7ab0a3ca61ed15ddc6aa112eba6c4837795`、源后续未改；备份 `review_backup06_final` 在精确 `98a29d1c2e3e8d2e513aadf79a0aca7b04cc45c7`）；已提交、已推送并创建 Draft PR [#60](https://github.com/huxiaoyang-code/youshu-fork/pull/60)，未合并（尚无 merge SHA，本交接不预报）**；文档验收与合并由 root 执行，合并后由 root 补记实际 merge SHA（详见 §10）。
  - root 在精确 98a 上实跑：完整 **55 / 55 套 exit 0**、Office **21 / 21**、真实 **11 PDF** 几何检查、备份 **22 / 22**；日志为忽略目录内相对证据名 `local-02-manager-indexkeys-final55.log`；`3a` 上的另一次 55 / 55 是**独立运行**，两者不互相冒充归属。
  - 下文 §9.6–§9.8 与任务单 §12–§14 的「未提交 / 未建 PR / 待 root 独审」是各自**阶段快照**（当时事实），最终状态以本节与 §10 为准，**不改写历史**。
  - **重要测试口径**：管理者在该 head 上跑过的 50 / 50 与已合 Office 21 / 21 **不能代表最终通过**；
    最终独立审查（`fork_turns=none`）实测四个阻塞（P1–P4），本轮回工后才在**最终代码**上重跑全套。
    review3 又发现一项同影响面 P2（见 §9.4），已统一口径并补定向回归后重新实跑。
  - **测试结果分段**：`04c38d4` 上的 55 / 55（含 §9.6）属回修前事实；§9.7 回修后的完整 55 / 55
    重跑结果在 §9.7 末尾按实际日志记录，不把回修前绿测试当成回修后验收；
    §9.8（备份索引键语义回修）另有自己的定向 22 / 22 与一次完整 55 / 55 日志，不引用旧 55 / 55 代替。
- 共享文档 release：管理者已在 `.agent-runs/local-02-docs-release.md` 释放 STATE / NEXT-SESSION /
  任务看板 / 八包总览 / INDEX / CHANGELOG / 接管计划，本包按自身事实追加（不覆盖前包已验收结果）。

## 1. 交付内容（按任务要求逐条）

### 1.1 金额精度与舍入一致

- 新增 `06-workbench/server/money.mjs`：人民币**分精度**统一规则。内部一律 BigInt 整数分，
  舍入唯一 `ROUND_HALF_UP`，输入按十进制文本 / 最短往返表示判定（`1.005 → 1.01`，不是 `1.00`）。
- 上限按**完整原值**判定（含全部小数位）：`999999999999.99` 合法，`999999999999.994` /
  `999999999999.9900000001` 拒绝；`-0.001` / `-1e-10` / `-0.000…1` 按负数拒绝；
  非零但不足一分（`0.001`）带 `subCent` 标记，在凭证 / 期初 / 导入期初**拒绝**而不是写成 0。
- 存续金额（累计余额、补项期初累计）**不受单笔上限约束**；输出侧要求「最短十进制 → 再解析」精确还原，
  不能保分即 `money_total_not_representable`（例如 `9007199254740991 分`），不静默少一分。
- 全路径改造：凭证分录 / 合计、期初、导入（CSV / JSON）、资产原值 / 残值 / 累计、折旧摊销、损益 / 年末结转、
  科目余额、试算平衡、三大报表、明细账。报表合计不再对 REAL 做 `SUM()`，改用分上累加。
- 导入合法格式（`¥` / 千分位 / 空白按 0）保持不变；旧非法输入仍拒绝（`import-strict` 54 / 54 通过）。

### 1.2 资产卡片 / 总账 / 连续月份计提

- 分期表：`月额 = 向下取整(可提提及额 ÷ 期数)`，余额落在最后一期 → 寿命内**恰好**提足
  （`100 / 3 → 33.33 + 33.33 + 33.34`），寿命外不再提，不提前多提。取单期金额为 O(1)
  （`money.evenSplitAmountCents` / `cardMoney(card).amountAt(index)`），不展开整张分期表。
- **计提期数是受验证的输入**：新增 / 修改只接受 `1 ~ 1200` 期整数（技术输入边界，不冒充法定年限）；
  负数 / 0 / 非整数 / `2^32` 一类巨大值在**写入前**拒绝，落库与 DTO 构造同一保存点，
  任何后续计算失败整体回滚（不留下“已落库但列表 / 检查持续报错”的卡片）。
- 极小金额（`0.05 元 / 12 期`）前 11 期 `no_amount_due`（不阻塞封账），第 12 期一次提足。
- **期间口径**：卡片状态按被查询期间计算累计（只含本期及以前已过账计提），另给全局 `accumulatedTotal` 参考；
  本期应提额 = `min(分期表、截至本期剩余)`；**历史状态 / 历史应提额不用未来全局余额决定**
  （跨年查询计提开始前期间仍为 `not_started`、累计 0、剩余 100）。
  旧库已存在后期 run 时由**执行时**总额守卫 `depreciation_global_over_depreciable` 明确拒绝并给撤销顺序，不改写历史 DTO。
- 卡片与总账核对：原值（`1601/1701` 含下级）↔ `booked` 卡片原值合计；累计（`1602/1702`）↔
  全部卡片 `opening_accumulated + 截至该期间已过账计提`。缺卡片 / 原值差异 / 累计差异**定位到科目与差额**并阻止封账。
- **未入账登记不是豁免**：`pending_purchase_voucher` 只表示「购入凭证待补」，仍参与原值核对并额外报
  `asset_purchase_voucher_pending`；`generateDepreciation` 对这类卡片明确拒绝 `asset_ledger_pending`（先于任何凭证写入），
  任意 `ledger_note` 都不能替代真实购入 / 期初入账。
- **补项契约**（schema v4，只加列）：`acquired_period`（显式取得 / 入账期间）、`opening_accumulated`
  （已入账历史累计）、`ledger_status` + `ledger_note`（显式「尚未入固定资产账」，原因必填）、`origin`。
- `acquired_period` 缺失**不回落** `start_period`：保守按「已存在」参与原值核对并报
  `asset_acquired_period_missing`，可经真实维护入口补登记后解除；`start_period` 只表示计提开始
  （12 月取得 / 1 月计提：12 月仍核对原值，计提不适用）。
- **适用期 / 金额只有一套判定（review3 P2）**：`assetCardPeriodStatus` 的「本期无计提记录」分支复用
  `expectedDepreciationCents`（与已过账计提校验共用）。取得期间晚于被查询 / 被生成期间的状态为 `not_existed`：
  `generateDepreciation` 不写任何凭证（`voucher: null` + `skipped`），期末检查不算「应计提未计提」，也不阻塞封账；
  旧数据（修复前落库的「取得期间之前」已过账计提）仍报 `posted_stale` / `depreciation_run_stale`（`expectedStatus = not_existed`）
  并给撤销顺序，撤销后不再写回 —— 不会出现「生成 → 立即 stale → 删除 → 再次生成」的循环。
- 真实维护入口：`PATCH /api/account-sets/:id/assets/:assetId` + Agent / MCP `asset_update` + `asset_create` 补项字段 +
  Web `GET/POST /assets`。**维护按实际影响守卫**：受影响期间（取得 / 计提开始起算）已封账时任何事实变更都拒绝
  （`asset_card_affects_closed_period`）；已有已过账计提时禁止改原值 / 残值率 / 寿命 / 计提开始期间 / 期初累计 /
  账簿状态 / 资产与累计科目（`asset_card_locked_by_posted_runs`）；名称 / 备注 / 费用科目等纯显示或非追溯字段可改。
  新增 / 删除卡片同样受这些守卫（不会在已核对封账后静默改变资产事实）。

### 1.3 可用期末检查与封账前置

- 新增 `period-end-controls.mjs`：`buildPeriodEndCheck`（只读检查）/ `assertPeriodCloseable`（封账前置）/
  `assertPeriodMutable`（前期可改性）/ `assetCardPeriodStatus`（卡片期间状态）。
- 七个步骤：草稿清零、试算平衡、应计提完整、卡片与总账核对、损益结转、年末结转、连续期间顺序；
  每步给 `ok` / `blocked` / `not_applicable` 与**理由**，无资产 / 无损益 / 非 12 月显式不适用。
- 计提步骤不只认「已过账」：已过账金额与卡片**当前**定义不一致时报 `posted_stale` /
  `depreciation_run_stale` 并阻止封账（review2 P1）。
- 未入账登记（`asset_purchase_voucher_pending`）只在**该期间卡片已存在**时计入阻塞；
  取得期间晚于查询期间的卡片不提前阻塞，缺取得期间仍按「已存在」保守报告（review2 P3）。
- 连续期间不只按凭证：更早期间有应计提而未计提的资产（**零凭证也算业务**）→ `previous_period_depreciation_pending`，
  需按期间顺序先完成该期计提 / 结转 / 封账；真正无适用业务的空期仍可跳过。
- 真实入口：`GET /api/account-sets/:id/period-end-check?period=`、Agent `period_end_check`、
  MCP `period_end_check`（`origin: local`）。
- 封账与检查共用同一规则；拒绝封账返回 `period_end_check_failed`（逐步明细），期间状态与账簿不变。
- 只认业务证据：结转步骤重新核对损益类科目余额；结转后再补损益分录 → `profit_carry_stale` 阻止封账，
  `carryForwardProfit` 也返回 `carryforward_stale` 并给「反过账旧结转 → 重新结转」的顺序。
- 重复动作不重复入账：同期重复计提返回 `voucher: null`；重复结转 `already_carried_forward` /
  `already_year_end_carried`；重复封账幂等。

### 1.4 反操作 / 前期变动对后续期间的影响

- 统一守卫覆盖**所有实际写入口**：新建凭证、过账、反过账、删除草稿、反结账、期初、计提、结转，
  以及增量导入（`createVoucher` 抛错 → HTTP 409 带 `details`，`server.mjs` 新增守卫码映射）。
- **依赖按实际读取的余额判定**：普通损益结转读「截至本期的累计损益余额」，所以依赖**所有前期**损益发生额 /
  结转 / 折旧；计提依赖卡片事实与前期计提状态。原先「普通结转只依本期」的错误假设已废弃，
  未封账的后期同样受保护（判据不是期间状态，而是已过账派生凭证是否存在）。
- 更晚期间已封账 → `later_period_closed`（`laterClosedPeriods` + 倒序反结账指引）。
- 更晚期间已有已过账年末结转（3103→3104）→ `later_year_end_carryforward_depends_on_period`。
- 更晚期间已有已过账普通结转 → `later_profit_carryforward_depends_on_period`（`details.dependencies`）。
- 更晚期间已有已过账计提 → `later_depreciation_depends_on_period`（`details.runs`，含资产 / 期间 / 凭证）。
- 已封账后期不允许重开前期（`setPeriodStatus(..., "open")` 同样走期间 / 年末守卫）；
  全部为「先判定后写库」，失败库不变；按文档化的倒序路径可完成修正与重算。

### 1.5 持久结构与迁移

- schema **v4**：`asset_cards` 加 5 列（`acquired_period` / `opening_accumulated` / `ledger_status` /
  `ledger_note` / `origin`），旧行默认值 `NULL / 0 / 'booked' / '' / 'purchase'`，语义不变；
  基础建表语句（`db.mjs`）未改，新列全部由版本化迁移添加。
- 迁移时序沿用 LOCAL-01：**迁移前一致备份（含 WAL 已提交数据）→ 备份之后在同一事务内加列 + 记录版本**；
  失败整体回滚（版本 / 列 / 业务数据都不变），失败尝试的备份保留为孤儿、重试重新备份。
- 已实测：合成 v3 库（带未 checkpoint WAL）升级；备份保持 v3 结构且可恢复为完整库；故障注入中途失败回滚；
  迁移后旧卡片默认 `booked` 参与核对（不被静默排除）。

## 2. 精确文件归属

新增（8）：

- `06-workbench/server/money.mjs`
- `06-workbench/server/period-end-controls.mjs`
- `06-workbench/test/accounting-period-integrity.test.mjs`
- `06-workbench/test/accounting-period-http.test.mjs`
- `05-reconstruction/codex/mcp/finance-mcp/accounting-period-test.mjs`
- `docs/ACCOUNTING-PERIOD-INTEGRITY.md`
- `docs/tasks/LOCAL-02.md`
- `docs/handoffs/LOCAL-02.md`

修改：

- 源码：`06-workbench/server/accounting.mjs`、`import-storage.mjs`、`server.mjs`、`agent-tools.mjs`、
  `05-reconstruction/codex/mcp/finance-mcp/tools.mjs`
- 测试 / 入口：`06-workbench/scripts/test-all.mjs`（仅追加 3 行）、`06-workbench/test/accounting-derived.test.mjs`、
  `smoke.test.mjs`、`report-export.test.mjs`、`report-export-http.test.mjs`、`import-incremental.test.mjs`、
  `import-incremental-http.test.mjs`、`05-reconstruction/codex/mcp/finance-mcp/contract-test.mjs`、`workflow-test.mjs`
- 共享文档（已 release）：`docs/tasks/INDEPENDENT-PRODUCT-WORK.md`、`docs/tasks/README.md`、
  `docs/handoffs/STATE.md`、`docs/handoffs/NEXT-SESSION.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`、
  `docs/DEVELOPMENT-TAKEOVER-PLAN.md`

**未改**：`coa.mjs`、`report-export.mjs`、`tax-*`、`public/*`、`package.json` / 锁、`import-incremental.mjs`、
`db.mjs`、其它 worktree、真实账套 / 凭据。

## 3. 既有测试的必要更新（只补真实业务步骤，未删旧断言）

新前置让「先封账」的历史夹具必须先完成真实业务步骤；金额断言、失败原子性断言全部保留：

| 文件 | 更新 | 理由 |
|---|---|---|
| `accounting-derived.test.mjs` | 折旧尾差用例改为「寿命内恰好提足（33.33/33.33/33.34）」；超额 / 重过账用例把 `opening_accumulated` 补项前置到计提前，跨期恢复改为「按倒序反过账后期计提再重过账」 | 旧期望「第 4 期补尾差」与新的明确舍入策略相反（任务允许，附独立手算）；新规则不允许已有已过账计提后改期初累计，因此真实业务顺序应为「补项 → 计提」，断言与金额全部保留 |
| `smoke.test.mjs` | 期初加 `1601 = 60000`（实收资本 160000）作为固定资产已入账真实事实，卡片去掉未入账登记；试算平衡借方 111300 → 171300、资产合计 108350 → 168350（均附手算） | 未入账登记不再能替代原值入账（F4）；原金额（卡片 60000 / 折旧 950 / 净利 7050 / 现金 98000）全部保留 |
| `contract-test.mjs`（MCP） | 期初加 `1601 = 60000`，`asset_create` 不再用未入账登记 | 同上（F4）；断言金额不变 |
| `accounting-period-http.test.mjs` | 新增 F1/F2/F3/F4 真实入口负例；卡片维护错误码从 400 改 409（守卫类） | 新守卫返回结构化 409 + `details`；金额断言不变 |
| `accounting-period-test.mjs`（MCP） | 已封账期间卡片维护改为 409 并补「倒序反结账后可维护」；新增 F2/F4 负例 | 同上 |
| `report-export.test.mjs` | 期初设备补 `acquired_period`、为 180 元购入补卡片、封账前结转并按序封账 2025-12 → 2026-01 | 新核对要求卡片原值与 `1601` 一致；所有报表金额断言不变 |
| `report-export-http.test.mjs` | 封账前先 `carryForwardProfit(2026-01)` | 本期有损益发生，封账前置要求先结转 |
| `import-incremental.test.mjs`、`import-incremental-http.test.mjs` | 封账前先结转本期损益 | 同上 |
| `workflow-test.mjs`（MCP） | 卡片补 `acquired_period` | 同上；断言不变 |
| `accounting-period-integrity.test.mjs` | P3 用例中「取得期间 2026-03 / 起提 2026-04」的 1 月卡片状态断言由 `not_started` 改为 `not_existed`（附理由注释） | review3 P2 把「卡片尚未取得」与「未到起提期间」分开报，旧断言把两者混为一谈；\*\*金额 / 阻塞断言全部保留\*\*，不阻塞行为不变 |

## 4. 实际测试与退出码（本机实跑）

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `npm test` | `06-workbench` | **50 / 50 套 exit 0**（最终代码实跑） |
| `node test/accounting-period-integrity.test.mjs` | `06-workbench` | **45 / 45**，exit 0 |
| `node test/accounting-period-http.test.mjs` | `06-workbench` | **18 / 18**，exit 0 |
| `node accounting-period-test.mjs` | `finance-mcp` | **5 / 5**，exit 0 |
| `node test/accounting-guards.test.mjs` | `06-workbench` | 23 / 23，exit 0 |
| `node test/accounting-derived.test.mjs` | `06-workbench` | 31 / 31，exit 0 |
| `node test/voucher-amount-guards.test.mjs` | `06-workbench` | 103 / 103，exit 0 |
| `node test/import-strict.test.mjs` | `06-workbench` | 54 / 54，exit 0 |
| `node test/smoke.test.mjs` | `06-workbench` | 28 / 28，exit 0 |
| `node test/report-export.test.mjs` | `06-workbench` | 21 / 21，exit 0 |
| `node test/report-export-http.test.mjs` | `06-workbench` | 29 / 29，exit 0 |
| `node test/import-incremental.test.mjs` | `06-workbench` | 49 / 49，exit 0 |
| `node test/import-incremental-http.test.mjs` | `06-workbench` | 22 / 22，exit 0 |
| `node contract-test.mjs` | `finance-mcp` | 44 / 44，exit 0 |
| `node workflow-test.mjs` | `finance-mcp` | 23 / 23，exit 0 |
| `node import-incremental-test.mjs` | `finance-mcp` | 7 / 7，exit 0 |
| `node scripts/seed-demo.mjs`（临时目录） | `06-workbench` | exit 0，输出与脚本固定金额一致 |

全部为合成临时库 + 随机回环端口；未连接旧后端、真实账套库、凭据、税局或浏览器；测试结束清理临时目录。

关键覆盖（独立手算预期，不复用被测 helper 生成 expected）：

- 金额：`1.005/0.125/123.456/2.675`、`0.1×10`、`3×0.005`、上限与超界原值、极小负数 / 极小正数、
  非有限 / 指数 / 千分位（凭证）、存续金额超单笔上限、不可保分合计。
- 计提：100 元 3 期、0.05 元 12 期、跨年 4 期、先提 2/3 月后查 1 月、旧库后期多提（历史应提额不被篡改 + 执行守卫拒绝）、
  跨年查询计提开始前期间 `not_started`、寿命外不再提。
- 核对：缺卡片、原值差异、累计差异（`opening_accumulated` 补项）、缺取得期间、12 月取得 / 1 月计提、
  未入账登记（原因必填、仍报原值差异、不得计提、真实补购入后才可继续）。
- 封账：无资产 / 无损益不适用、缺计提、缺结转、缺年末结转、连续期间（凭证 / 零凭证但应计提的更早期间 / 先封后期）、
  结转失效检测、重复动作幂等、封账失败不改库。
- 反操作：更晚已封账（新建 / 反结账）、更晚年末结转、**更晚普通结转 / 计提依赖**、卡片封账后 / 已过账后维护守卫、
  拒绝时全库不变、正确倒序路径可完成并重算。
- 迁移：v3→v4 备份（含 WAL）/ 恢复 / 默认值 / 故障回滚 / 重试重新备份。
- 真实入口：HTTP 两月链（9050 / 19050 / 累计 28100、资产 132000 = 负债 3900 + 权益 128100）、
  F1/F2/F3/F4 负例与解除路径（含 Agent / MCP），导入前期被拒 409 + 依赖顺序；MCP 两月链与负例。
- review3 P2（取得期间一致性）：领域 2 项（复现原路径：一月计提 10 → 反过账 → 删除 → 取得期间改二月 → 一月不再生成、
  检查不报 stale / missing，把购入凭证也移到二月后一月可封账、二月生成 10 并封账，名称 / 备注不锁死；
  旧数据：库内保留「取得期间之前」的已过账计提 → 报 stale + `generateDepreciation` 拒绝，删除后不写回、检查恢复），
  与 HTTP 1 项（同一业务链走 PATCH `acquired_period` + HTTP / Agent 真实入口，含全库不变断言）。

## 5. 备份与回退

- 迁移前备份：`workbench.db.pre-v4-<时间戳>.bak`（`VACUUM INTO` 单文件自包含快照，含 WAL 已提交数据），
  立即用独立只读连接做 `PRAGMA integrity_check`；验证失败拒绝迁移、保留原库。
- 备份记录在迁移事务内登记（`schema_backups`）；失败尝试的备份文件保留为孤儿、不登记，重试重新备份。
- 回退：停后端 →（先另行复制现库留档）→ 用 `schema_backups` 记录里的备份覆盖 `workbench.db` →
  删除残留 `-wal` / `-shm` → 重启（会重新迁移并再备份一次）→ 逐项核对。
- **回退不是无损**：恢复把库带回快照时点，之后新增 / 修改的业务会丢失；恢复前必须先保护现库并停写。
  本包只是迁移前最小备份 + 回退手段，**不冒充 LOCAL-06 业务备份恢复已完成**。

## 6. 未完成 / 不在本包范围

1. 两套准则的科目 / 报表映射与辅助核算（项目 / 部门 / 往来）—— **LOCAL-03**。
2. 银行流水与对账 —— **LOCAL-04**；复杂现金流口径、Excel / PDF 导出 —— **LOCAL-05b / 05a**。
3. 完整审计留痕、业务数据备份 / 恢复体系、干净 Windows 安装交付 —— **LOCAL-06**。
4. 多账套持久批量任务、重试 / 取消、CLI —— **LOCAL-07**。
5. `report-export.mjs` 的独立汇总层未改写（LOCAL-05b）；当前只保证其输入值为分精度归一值。
6. 空月份不自动登记：封账要求「更早有业务证据（凭证或应计提资产）的期间」已封账；完全没有适用业务的月份不阻塞后期封账，
   但后期封账后再回填该月份会被 `later_period_closed` 拒绝，需按倒序反结账（有意设计）。
7. 增量导入的**预检**未单独预判「后续结转 / 计提依赖」：依赖冲突在正式写入时由同一守卫拒绝并回滚（HTTP 409 + `details`）；
   `import-incremental.mjs` 不在本包精确可写清单内，未自行修改（预检统一归 LOCAL-07 批量编排）。
8. 税局现场暂停、真实接入 **0**；本包不连税局、不改税局模块、不读真实账套 / 凭据。
9. `06-workbench/README.md` 的 **API 表 / 能力说明尚未登记本包新增路由**
   （`GET …/period-end-check`、`PATCH …/assets/:assetId`、卡片补项字段、封账前置）——该文件不在本包授权的精确文件清单内，
   未自行修改；需管理者确认是否由本包补或另开文档小任务（对外行为本身已由新契约文档与本交接描述）。

## 7. 下游输入

- 金额工具：`money.mjs` 的 `parseMoney` / `requireCents` / `storedCents` / `centsToNumber` / `formatCents` /
  `sumCents` / `mulCentsByRatio` / `mulDivCents` / `splitEvenlyCents` / `monthsBetween`。
  **新代码禁用** `Math.round(x*100)/100` 与 SQL `SUM()` 汇总金额。
- 卡片口径：`cardMoney(card)`、`assetCardPeriodStatus(db, card, period)`、`cardAcquiredPeriod(card)`。
- 期末口径：`buildPeriodEndCheck` / `assertPeriodCloseable` / `assertPeriodMutable`
  —— LOCAL-07 批量任务应直接复用，不要另写封账规则；LOCAL-03 增加辅助维度时保持金额入口不变。
- DTO 兼容：`listAssetCards` 只新增字段（`acquired_period` / `opening_accumulated` / `ledger_status` /
  `ledger_note` / `origin` / `final_month` / `accumulated`），既有字段与含义不变；`generateDepreciation`
  返回新增 `skipped`（逐卡状态），既有 `voucher` / `runs` / `note` 不变。

## 8. 会话与审查事实（不预报）

- 本包由本机执行员工在独立 worktree `codex/huxiaoyang-code/local-02` 内实现并自测；
  **未执行 Git 提交 / 推送 / 合并**，未创建 PR；模型与回退模型固定为本项目已核实的 tokenhub / DeepSeek V4.1 Flash，
  未启动子 agent、未切换模型。
- 实施期间管理者已在 `.agent-runs/local-02-manager-feedback.md` 提前复现四类边界（金额截断 / 合计丢分 /
  单笔上限误加给存续金额 / 资产时点与期间口径），员工已全部修复并补独立回归（见 §9.1）。
- review1 由独立 subagent 在工作区做合成预审（`.agent-runs/local-02-subagent-feedback.md`）复现 F1–F4 与历史状态残留；
  前一轮实施会话中断后，root 核实无活进程 / 无正常 exit 记录，保留未提交成果，由**新进程新会话**继续完成
  F1–F4 与历史状态修复（未重做已完成部分）；自测前与最终交付前均重读上述两份反馈输入，写入本交接时无未处理项。
- 管理者最终验收、PR、独立 Codex subagent 审查与合并结果**尚未发生**，待管理者后补登记；
  本交接不声称已合并或已通过最终审查。
- 全部测试使用合成临时目录与随机回环端口，结束后清理；未连接既有后端、真实账套库、税局或浏览器。

## 9. 审查反馈修复对照

### 9.1 管理者提前反馈（金额边界）

| 反馈项 | 修复 | 回归 |
|---|---|---|
| 9 位标度截断后判符号 / 非零 / 超界，接受 `-1e-20`、`-1e-10`、`'-0.0000000001'`，`'999999999999.9900000001'` 被收进界内 | 改为按完整原值判定（全部数字位）；极小正数保留 `subCent`；上限判定不截断小数 | `accounting-period-integrity`「极小负数…」「上限按原值判定」 |
| `centsToNumber(9007199254740991n)` 与 `…990n` 都输出 `90071992547409.9` | 转换后强制「最短十进制 → 再解析」还原同一分数，不能保分抛 `money_total_not_representable` | 同上「合计超出可保分范围」 |
| `storedCents` / 汇总路径可能把单笔上限强加给合法累计余额 | `storedCents` 改用「整数分可精确表示」范围；单笔入口保留原上限；给出清晰范围契约 | 同上「单笔上限不强加给存续 / 累计金额」 |
| 缺 `acquired_period` 时静默回落 `start_period`，制造「前期不存在」证据 | 去回落；按已存在保守核对 + `asset_acquired_period_missing` 显式缺项，经 `asset_update` 解除；12 月取得 / 1 月计提单独回归 | 「缺取得期间是显式缺项」「12 月取得 / 1 月开始计提」 |
| 卡片期间状态累计未按期间过滤，前期 DTO / 应提额可能含未来计提 | 累计改为按被查询期间，另给全局 `accumulatedTotal` | 「历史卡片状态按被查询期间计算」 |

### 9.2 并行 subagent 独立预审 F1–F4 + 历史状态残留

| 反馈项 | 修复 | 回归 |
|---|---|---|
| F1 卡片 add/update/delete 无期间 / 依赖守卫，已封账后改原值仍成功且期间仍 closed | `assertAssetCardWriteAllowed`（新增 / 修改 / 删除共用）：受影响期间有封账 → `asset_card_affects_closed_period`；已过账计提后的金额 / 期间 / 账簿状态 / 科目变更 → `asset_card_locked_by_posted_runs`；只改名称 / 备注仍合法；拒绝时全库不变 | 领域 F1、HTTP F1（含 Agent 409）、MCP 封账后拒绝 + 倒序反结账后可维护 |
| F2 普通后期结转读累计余额，但前期反过账 / 新增不拦截，后期 120 仍 posted | `touches.profit` / `touches.depreciation` 依赖守卫；`later_profit_carryforward_depends_on_period` / `later_depreciation_depends_on_period` + 倒序撤销指引；原「普通结转不构成前期依赖」断言已按业务事实改写（不是删断言） | 领域 F2 两条、HTTP F2、MCP F2 |
| F3 零凭证但应计提的前期被跳过，后期可先封账 | `periodSequenceStep` 扫描更早期间的资产应计提证据，新增 `previous_period_depreciation_pending`；真正无适用业务空期不阻塞 | 领域 F3（1/2/3 月 = 33.33/33.33/33.34，合计 100）、HTTP F3 |
| F4 `pending_purchase_voucher` + 任意 note 成为原值差异旁路，未入账仍能提 10 折旧 | 未入账卡片不排除原值核对 + 额外 `asset_purchase_voucher_pending`；`generateDepreciation` 明确拒绝 `asset_ledger_pending`（先于任何写入）；任意备注不能解除 | 领域 F4、HTTP F4、MCP F4 |
| 历史状态：`assetCardPeriodStatus` 用全局余额判 `fully_depreciated` / 截断历史应提额 | 历史状态 / 应提额只用「截至该期间」事实；全局余额改为执行时守卫 `depreciation_global_over_depreciable`（给撤销顺序）；旧库兼容回归保留 | 「历史状态：跨年查询 2025-12」「旧库已存在后期 run」 |

### 9.3 review2：最终独立审查四项阻塞（P1–P4）

文档与契约同步：`docs/ACCOUNTING-PERIOD-INTEGRITY.md` §1 / §2.1 / §2.5 / §2.4 / §3 / §4.2 / §6 / §7 / §8 已按本轮行为更新，
其中 §2.5 为新增的「已过账 ≠ 已完成」口径。

| 编号 | 问题（审查实测） | 修复 | 回归 |
|---|---|---|---|
| P1 | Jan 开账、卡片 100 / 寿命 10：计提 10 → 反过账 → 改寿命 5 → **重过账原凭证成功** → 结转：月额已变 20 但已提 10，`periodEndCheck ready=true` 且可封账 | `accounting.mjs` 新增 `assertDepreciationRunsCurrent`（`postVoucher` 调用）：按卡片**当前**定义重算每张旧 run 的应提额，并校验凭证分录与卡片费用 / 累计科目；失配报 `depreciation_run_stale` + `guidance`（删除旧草稿连带旧 run → 重新计提）。`period-end-controls.mjs` 新增 `expectedDepreciationCents` 与 `posted_stale` 状态，`depreciationStep` / `generateDepreciation` 同一口径阻止；名称 / 备注不参与，不无意义锁死；既有 `asset_card_locked_by_posted_runs` / `depreciation_exceeds_depreciable` / 历史期间口径全部保留 | 领域 P1 两条（原场景 + 字段覆盖含科目 / 纯显示）、HTTP P1（Agent `voucher_post` 409）、MCP P1 |
| P2 | `parseVoucherAmount` 丢 `subCent`：两行 posted 凭证 `{1002,1,0.001}` / `{1001,0.001,1}` 成功并把 0.001 静默存 0 | 凭证逐金额字段拒绝非零亚分数（含 `1e-7` / `0.0049` / 十进制文本），`checkVoucher` / `createVoucher` 共用；`0.005 → 0.01` 等正常边界保留；拒绝时全库不变 | 领域 P2、HTTP P2（Agent 两入口）、MCP P2 |
| P3 | `asset_reconciliation` 的 `pendingLedger` 未按 `exists` 过滤：取得 2026-03 / 起提 2026-04 的 `pending_purchase_voucher` 卡片把 2026-01 检查阻塞 | 只在 `cardExistsAt(card, period)` 成立时计入 `asset_purchase_voucher_pending`；缺取得期间仍保守报告；真实补录 + 改回 `booked` 才解除（未放宽真实未入账旁路） | 领域 P3（Jan / Mar / Apr、已录入 / 未录入、缺字段）、HTTP P3 |
| P4 | 资产新增先落库、`cardDto` 才在 `splitEvenlyCents` 抛 `Invalid array length`（`4294967296`），卡片已持久化、列表 / 检查持续报错；小于 `2^32` 的巨大值线性 `fill` 耗内存 | `requireUsefulLifeMonths`：add / update 都只接受 `1 ~ 1200` 整数（`useful_life_months_invalid` / `useful_life_months_out_of_range`，技术边界不冒充法定年限）；`money.mjs` 新增 O(1) `evenSplitAmountCents` + `MAX_SCHEDULE_PERIODS`，`cardMoney` 改 `amountAt(index)` 不展开整表；add / update 的落库 + DTO 构造同一保存点，任何后续计算失败整体回滚 | 领域 P4（巨大 / 负数 / 0 / 非整数 / 1201 / 边界 1200 / 更新回滚 / 旧库极端大寿命行读路径）、HTTP P4（Agent `asset_create` + `PATCH`）、MCP P4（参数上下限 + patch 后端边界） |

附带：`import-storage.mjs` 中 `acquired_period` 迁移注释原称“核对时回落 start_period”，与实际「不回填、报 `asset_acquired_period_missing`」矛盾，已修注释（**迁移语义不变**）。
本轮回工**未新增存储列**（schema 仍 v4 同一 5 列），真实 v3→v4 升级 / WAL 备份恢复 / 失败回滚验证未退。
LOCAL-06 备份 CLI 尚未合并且当时只支持 v3，本轮**未触碰**；v4 兼容增量由 root 整合已审 LOCAL-06 后另派
（已完成，见 §10）。

### 9.4 review3：取得期间一致性（同影响面 P2）

独立审查确认原四项复现（P1–P4）均已关闭（域 43 / HTTP 17 / MCP 5 通过），但新增一项同影响面 P2；
两处口径不一致导致**纠正后的业务路径陷入循环**：

- `period-end-controls.mjs` 的 `expectedDepreciationCents`（校验已过账计调用）在 `acquired_period > period` 时返回
  `not_existed` / 应提 0；
- 同一文件的 `assetCardPeriodStatus` 在「本期无计提记录」分支却自己按分期表算 `due`，**不看取得期间**。

复现：卡片 100 元 / 寿命 10 / 取得与起提均为 1 月 → 生成 1 月计提 10 → 反过账 → 取得改为 2 月 →
旧凭证重过账被正确拒绝（`depreciation_run_stale`）→ 按指引删除旧凭证 → `generateDepreciation(1 月)` **再次成功写入 10** →
`periodEndCheck` 立即报 `depreciation_run_stale`（期望 0）→ 再生成也 stale。

| 项 | 修复 | 回归 |
|---|---|---|
| 生成 / 校验两套口径 | `assetCardPeriodStatus` 的「本期无计提记录」分支**删除自算**，改为直接复用 `expectedDepreciationCents`（取得期间 / 未入账 / 未到起提 / 已提足 / 寿命外 / 亚分取整全部同一处判定），并新增状态 `not_existed`（与 `not_started` 分开报）；`not_existed` / `not_started` 不给 `dueAmount`（保持既有 DTO 口径），`depreciation` 步骤不阻塞封账，`generateDepreciation` 返回 `voucher: null` + `skipped`（`note` 同步为「卡片尚未取得 / 未到计提期 / 已提足或按分取整为 0」） | 领域「取得期间一致性」两条、HTTP「取得期间一致性」一条（http 17 → 18） |
| 已存在旧数据也一致 | 旧库（或修复前落库）已有的「取得期间之前」已过账计提：仍报 `posted_stale` / `depreciation_run_stale`（`expectedStatus = not_existed`，`expectedAmount = 0`）并阻止封账；按指引反过账 + 删除后，**同一期间不再被写回错误凭证**，检查回到 ok；正确适用期（2 月）仍可计提；起提期间早于取得期间的矛盾登记不自动抹平，寿命外未提足如实报 `life_expired` | 同上（领域第二条专门覆盖旧数据 + 矛盾登记的 `life_expired`；HTTP 链覆盖新写入路径） |
| 不选「写前拒绝取得晚于起提」 | 采用统一适用期口径而不是只加写入口拦截：否则无法处理已存在的旧数据，且仍会隐藏两套判定矛盾（本次复现就是写入被允许、校验又拒绝）。取得 / 起提矛盾时如实报：历史期间 `not_existed` 不生成、已过账旧计提 stale、总账仍有原值则 `asset_missing_card`（真实矛盾在购入凭证，不由折旧规则掩盖） | 同所属用例：一月把购入凭证也移到二月后才可封账 |
| 不锁死纯显示字段 | 名称 / 备注仍不参与一致性判断；二月已过账计提后改名 / 备注，`depreciation` 步骤仍 `ok` 且卡片状态仍 `posted` | 领域第一条、HTTP 链末段 |

文档同步：`docs/ACCOUNTING-PERIOD-INTEGRITY.md` §2.2（适用期只有一套判定 + 旧数据 / 矛盾登记处理）、§2.5（「本期无计提记录」分支不得自算）、
§3 `depreciation` 行（`not_existed` 不阻塞、也不会被生成计提）。既有断言变更 1 处（P3 用例的
`not_started` → `not_existed`，附理由注释），**金额 / 阻塞 / 原子性断言全部保留**；既有四项与累计舍入 / 反操作 / 原子性规则未回退。
**先红后绿证据**（修复前代码 = `git show HEAD:06-workbench/server/period-end-controls.mjs`，其余不变）：
领域套件 **42 / 45**（新增 2 项 + P3 断言失败），HTTP 套件 **17 / 18**（新增 1 项失败）；恢复修复后代码（SHA256 逐字节回位）
后领域 **45 / 45**、HTTP **18 / 18**，再跑全套 `npm test` **50 / 50 套 exit 0**。
本轮**未新增存储列**、未改迁移，未触碰 LOCAL-06 备份 CLI 与 backup 相关包。

### 9.5 合并后的备份兼容整合轮（root 派工，只改 LOCAL-06 自有文件）

PR [#55](https://github.com/huxiaoyang-code/youshu-fork/pull/55) 已合并（merge `98977e0`，已审源码 head `b2dcba3`）后，
备份子包当时**严格只认 v3**，而本包已把 `IMPORT_SCHEMA_VERSION` 推到 4（`asset_cards` 5 列）。
root 已在本 worktree 派单完成兼容整合（**不改本包任何业务实现**，不开回滚本包已审金额 / 期末 / v4 逻辑）：

- 备份工具改为 **v3 / v4 两个独立精确契约**（列 / 类型 / NOT NULL / **默认值** / 主键 / UNIQUE /
  外键完整集合与动作 / 迁移记录连续性与迁移前备份记录），按库报告的版本选择契约；只抬版本号、缺列、
  错默认值 / NOT NULL / 类型、未知组件表、未来版本、迁移记录不连续、重算清单摘要的伪兼容全部拒绝；
- **v3 旧备份**按 v3 契约只读验证并原样恢复到全新目录（不迁移备份 / 源库）；只有产品入口显式打开才走
  本包的 v3→v4 迁移，升级后 5 列按真实默认值落库（旧卡片因此报 `asset_acquired_period_missing` /
  `asset_accumulated_mismatch`，不凭空补历史累计）；
- **v4 备份**用真实产品合成库验收（本包 API 建账套 + 资产补项 + 连续两期计提与总账 + 真实封账 +
  两批导入），`createBackup → verifyBackup → restoreNew` 后再用真实入口读取并继续记账 / 计提；
- 本包行文与契约同步：`docs/ACCOUNTING-PERIOD-INTEGRITY.md` §5.1 记录了该备份边界；
  本包任务单 / 交接只追加事实，**不改已有验收结论**。

测试口径：备份套件 **20 / 20**（原 16 项保留，schema 版本断言随 v4 更新）+ 新增 4 项；
`06-workbench` 下 `npm test` 为 **53 / 53 套 exit 0**（备份套件已按任务单授权仅追加登记，原 50 套顺序 / 内容不变；
本包领域 / HTTP / MCP 三套随这次全量实跑也均 exit 0，但本轮**未单独重跑并计数**，不引用旧 45 / 18 / 5 作为本轮结果）。

### 9.6 LOCAL-08 新工具模型边界兼容增量（上一轮，head `04c38d4`）

- 目标：在不改本包会计 / DB / 期间业务实现、不改 LOCAL-08 已有边界的前提下，把本包新增的
  `period_end_check` / `asset_update` 按真实 DTO 接入现有可测试 adapter / transport 合约；**未挂载**共享
  HTTP / Agent / MCP / CLI 入口（共享窗口尚未移交）。
- `period_end_check` 只读：投影只含期间、`ready`、固定步骤状态计数、blocked 步骤 id、阻塞计数与固定阻塞码；
  原始标题 / 原因 / `message` / `details` / 资产名 / 科目名 / 备注不进入模型通道；未知值 fail closed。
- `asset_update` 写：显式写调用才执行，未知 / 只读工具不会执行；成功必须真实 `id` 才 `applied:true`，
  失败保留 `applied:"unknown"` / `needsLocalReview:true`；投影最小白名单不含名称 / `ledger_note` / 科目 / 备注。
- 新期间 / 资产校验错误与 `period_end_check_failed` 均有固定 code → category 映射，不再落 `unknown`。
- fixture 改为真实完整资产登记：原值 1200、`2026-02` 取得 / 起提、借贷平衡购入凭证（借 1601 / 贷 1002 各 1200）、
  真实计提 95；保留**真实封账成功**与 `period_end_check_failed` **前置拒绝**两条路，未 mock / bypass / 跳过封账保护。
- 边界未放宽：错误清洗、参数快照、引用绑定 / 过期 / 跨账套、预算、写后降级、不可变 snapshot 与并发隔离保持原语义。
- 定向输出（**上一轮，head `04c38d4`**）：策略 **35/35**（原 34 保留）、适配层 **20/20**（原 19 保留）、transport **17/17**（原 16 保留），均 exit 0。该组结果属**回修前**状态，不能当作本轮（§9.7）已通过。
- 完整 `npm test`（设 `REPORT_OFFICE_PYTHON`，**上一轮，head `04c38d4`**）：**55/55 套 exit 0**；Office **21/21**、真实 **11 PDF** 几何通过
  （外部 poppler + pdfplumber）。**日志归属按实际事实更正**（此前行文有误）：一次 `import-incremental-http` 进程异常退出
  （exit 3221226505）出现在**员工 target22** 那一次运行；随后**员工连续两次完整 55/55**；**root 的独立 55/55 是在 `04c`**，
  日志为 `.agent-runs/local-02-manager-final55.log`——`.agent-runs/local02-55-suites-20261022-214500-final.log` 是**员工**日志，
  **不是 root 日志**。该异常**原因仍未定位**，已登记
  [Issue #49 comment 6340922839](https://github.com/huxiaoyang-code/youshu-fork/issues/49#issuecomment-6340922839)；
  不据此下「与本次改动无关」或其他因果结论，不把偶发崩溃当成业务通过。
- root 在 **3a** 的最终 55/55 是另一次运行，日志名 `.agent-runs/local-02-manager-output-review1-final55.log`；
  独立 output 审查已在 3a 接受。**上述 root / 员工运行与本轮备份自测严格区分**：本轮只实跑
  `node test/local-backup.test.mjs` 与一次 `npm test`（日志名与结果见 §9.8），不引用旧 55/55 作为本轮备份证据。
- 范围：跨包只改已登记的 LOCAL-08 6 个源码 / 测试文件与 3 份 08 文档，另补 `docs/LOCAL-BACKUP.md` 独审非阻塞项；
  **未改**本包业务源码、DB、期间逻辑、`agent-tools.mjs` / `server.mjs` / MCP 入口 / `scripts/test-all.mjs`。

### 9.7 输出协议 2 项 P2 回修（本轮，回修候选待 root 复审）

独立审查在 head `04c38d4` 上复现两个 P2，**均已修复并补先红后绿定向回归**；绿测试不能代替这两项验收：

| 项 | 复现 | 回修 |
|---|---|---|
| P2-1 真实长阻塞码被通用预算吞掉 | `depreciation_life_expired_underprovided`（39 字符）与 `previous_period_depreciation_pending`（36 字符）虽在阻塞码白名单，仍被 `PROJ_TOKEN_RE`（最多 32 字符）过滤；真实结果为 `ok:true` / `blockingCount:1` / `blockingCodes:[]` / `projectionDropped:1`，而 transport 侧却通过（其自有 token 表已含这两条） | 通用 token 32 字符预算与 40 字符长度上限**均未改**，只给**已登记固定代码常量的精确字面量**开窄通道（policy 的 `REGISTERED_CODE_LITERALS` + `isProjectionStringAllowed`，标量与数组两路共用）；未知码仍 fail closed。回归：19 条真实阻塞码**逐条**（非仅两个示例）完整投影 + `projectionDropped:0`；未登记 37 字符串 / 41 字符串 / 中文原文仍丢弃或拒绝 |
| P2-2 只验单字段不验 DTO 全局一致性 | `ready:true` + `steps:[]` + `blocking:[]`、`ready:true` + 7 个重复 `draft_vouchers`、`ready:true` + 全 blocked 且 `blocking` 非空，都被投影成功、建了引用并通过 transport | 新增纯函数 `isPeriodEndCheckConsistent`（policy，**不 import** 会开业务 DB 的 `period-end-controls.mjs`）：7 个已登记步骤唯一齐全、状态值域、每条 `blocking` 归属真实 blocked 步骤、`ready` ⇔ 无阻塞、每个 blocked 步骤至少一条原因（不机械比较原因数 = 步骤数）；policy 据此 fail closed，adapter 在同一判定上直接报 `model_result_invalid` 且**不建 ref** |

- 回修后三层实跑：策略 **37/37**、适配层 **21/21**、transport **18/18**，均 exit 0；原 35 / 20 / 17 项含义保留，snapshot / 引用预算 / 并发隔离未回退。
- 完整门禁（回修后，本轮实跑）：先跑上述三套定向，再在 `06-workbench` 设 `REPORT_OFFICE_PYTHON=<验收 Python>` 跑 `npm test` → **55 / 55 套 exit 0**（汇总行「全部 55 个套件通过（55/55）」，进程 exit 0），Office **21/21**、真实 **11 PDF** 几何通过。最终代码日志 `.agent-runs/local02-55-suites-20261022-204605-rewrite2-final.log`（同一代码状态下的早先一次完整运行 `…-204310-rewrite2.log` 也是 55/55；其后只调整了注释位置，代码行为未变，仍以最终日志为准）。
  本次**未重现** §9.6 的 exit 3221226505；该异常仍**原因未定位**，不下因果结论，后续稳定性由 root 的 Windows 交付检查继续跟踪。
- 新增真实正例（真实临时库，不改业务源码）：`2026-01` 起账 → 1 期寿命导入卡片（`2026-02` 取得、`2026-01` 起提）→ `2026-03` 真实购入凭证 → 期末检查 `blockingCount:3` / `blockingCodes:['depreciation_life_expired_underprovided','previous_period_depreciation_pending','previous_period_open']` / `projectionDropped:0` / `blockedStepIds:['depreciation','period_sequence']`，transport 通过。
- 真负例：以真实 DTO 为基底注入 `ready:true + steps:[]`、7 个重复 `draft_vouchers`、全 blocked + `ready:true`、缺步 / 多步 / 阻塞归属未阻塞或未知步骤，一律 `model_result_invalid`、`localRef` 不存在且 policy 引用池不变；同 harness 不改内容的对照仍成功建引用。
- 改动范围（本轮回修）：`06-workbench/server/finance-output-policy.mjs`（长码窄通道 + `isPeriodEndCheckConsistent` + spec 一致性前置）、`06-workbench/server/finance-model-adapter.mjs`（改用共享一致性判定，不 import 业务 DB 模块）、三套测试文件（`test/finance-output-policy.test.mjs`、`test/finance-model-adapter.test.mjs`、MCP `finance-model-transport-test.mjs`）。**`finance-model-transport.mjs` 源码本轮未改**：它的 `PROJECTION_TOKENS` 已登记这 19 条码且单字符串上限 40 已能容纳 39 字符长码，因此“transport 通过而 policy 丢码”的不一致只在 policy 侧；本轮只是把一致性写进 transport 测试。未改本包会计 / DB / 期间业务、`agent-tools.mjs` / `server.mjs` / MCP 入口 / `scripts/test-all.mjs`、备份 / 339 代码与测试。
- 状态：**回修候选，待 root 独立增量复审**；未挂真实 shared 入口（HTTP / Agent / MCP / CLI）；未提交 / 未建 PR / 未合并。

### 9.8 核心备份索引键语义回修（本轮，待 root 冻结与备份独立审查）

独立审查在银行候选上发现并**实际证实**：继承 339（无 bank 组件）的核心备份模块同样有缺陷——
`import_voucher_sources` 的表级 `UNIQUE (source_system, enterprise_key, source_voucher_id)` 只把最后一列
改成 `COLLATE NOCASE`（列 / 默认值 / 外键全部不变）时，旧模块 `create` / `verify` / `restore` **全部放行**；
恢复后真实增量导入已存 `Ref-A` 再 append `ref-a` 抛 `ERR_SQLITE_ERROR`，而正常 `BINARY` 对照是 `applied`
且两条来源并存。根因：`uniqueColumnGroups` 只用 `pragma_index_info` 读列名，没验真实唯一性的**比较规则**。

| 项 | 复现 / 根因 | 回修 | 回归 |
|---|---|---|---|
| 唯一性比较规则未校验 | 只改 `COLLATE NOCASE` / `RTRIM` 即可改变「哪些写入被拒」，旧版三入口全放行 | 契约升级为 `uniqueConstraint(origin, collationKey(...))`（主键 `pk` / `UNIQUE` `u` 逐条，默认 `BINARY` + `ASC`），验证改读 `PRAGMA index_xinfo`（键列 / `cid` 表达式 / `coll` 排序规则 / `desc` 方向）与 `index_list`（`unique` / `origin` / `partial`），与契约**一对一**匹配 | 域：`NOCASE` / `RTRIM` / 主键文字键 `NOCASE` / 主键键列 `DESC` 均 `unique`（`reason` + 固定令牌明细） |
| 额外 / 重复 / `origin=c` 唯一索引被忽略 | 旧版只看 `origin='u'`，且 `partial` / 表达式 / 无名列直接 `continue` | `origin=c` 的命名唯一索引同样参与比对，契约外一律 `unexpected_unique_index`；v1 已删除的 `idx_import_bindings_set` **不要求存在**，加回即被拒 | 域：复活旧命名索引 / 同键重复声明 / 表达式（`expression` 令牌）/ `WHERE` 部分索引均拒绝 |
| `INTEGER PRIMARY KEY` 只看列名 | 改为 `DESC` / `WITHOUT ROWID` 后不再是 rowid 别名，旧版无感 | 新增 `rowidAlias` 契约：`true` 的表必须**无主键索引**且 `rowid` 与主键列逐行相等 → `rowid_alias`；多列文字主键按真实主键索引比对 | 域：`vouchers.id INTEGER PRIMARY KEY DESC` 被拒 |
| 误拒边界 | 强化后不能把正常库 / 旧产物拦住 | 非唯一索引不作为结构证据、也不拒绝；清单格式与 `formatVersion` **未变**（只强化验证） | 域：与真实 DDL **同义重建**的表 / 额外非唯一索引照常备份与验证；v3 / v4 正常对照均通过 |
| 错误输出 | 不能回 SQL / 路径 / 自由原值 | 明细只含表名 / 列名 / 计数 + 固定令牌（`pk` / `u` / `c`、`BINARY` / `NOCASE` / `RTRIM`、`expression`、升降序布尔），未知排序规则只报 `nonstandard` | 域：逐变体断言明细不含 `CREATE TABLE` / `COLLATE` / `SELECT` / 本机路径 / 账套名 / 企业标识 / 表达式原文 |

- **旧产物向后兼容（实跑事实，不属新用例）**：修改**前**用冻结源码生成真实 v4 / v3 合成备份（16 表 88 / 87 行），
  修改后：清单与快照 sha256 **未变**、`verify` 通过、`restore-new` 成功、恢复文件仍是备份时的 schema 版本（3 / 4），
  恢复库的期初 / 余额 / 凭证 / 来源凭证 ID 与旧事实一致；在恢复库上用真实增量导入追加只差大小写的 `ref-a`
  仍为 `applied` 且 `Ref-A` / `ref-a` 两条并存（费用 700 → 705）。同一 `NOCASE` 变体改前被三入口放行、
  改后被源库与快照两侧同时拒绝且不产恢复目标。本机忽略目录证据：`.agent-runs/l02-backup-prefix/`（旧工具产物、
  `pre-fix-defect.log`、`post-fix-check.log`）与 `.agent-runs/local02-backup-indexkeys-{focused,full55}.log`。
- **测试**（本轮实跑）：`node test/local-backup.test.mjs` → **22 / 22 exit 0**（原 20 项含义全保留，新增第 21 项 v4 十变体
  + 两组正常对照、第 22 项 v3 旧快照三变体 + v3 正常对照）；设 `REPORT_OFFICE_PYTHON` 后 `npm test` → **55 / 55 套 exit 0**
  （Office **21 / 21**、真实 **11 PDF** 几何通过）。**先红后绿**：同一套测试换回修改前模块（SHA256 回位核实）为 **20 / 22**，
  两个新项均以「期望拒绝、实际接受」失败；恢复修改后代码后 **22 / 22**。
- **限制**：只对**唯一性**索引做语义比对（非唯一索引不改变业务规则）；`AUTOINCREMENT` 等存储选项不在本轮范围；
  表达式 / 部分索引目前只作为拒绝依据（真实 v3 / v4 没有它们）；未使用真实账套 / 税局；未改清单格式。
- **范围**：只改 `06-workbench/server/local-backup.mjs`、`06-workbench/test/local-backup.test.mjs` 与
  `docs/LOCAL-BACKUP.md` / 本任务单 / 本交接；**未改**会计 / DB / 期间 / 金额 / 迁移、输出 policy / adapter / transport、
  其它测试、`scripts/test-all.mjs`（该套件已在其中，无需重登记）。
- 状态：**实现与自测完成，待 root 冻结与备份独立审查**；未提交 / 未建 PR / 未合并。
  （上述为 §9.8 阶段快照；已被 §10 的最终审查与 PR 事实取代。）

## 10. 最终出版状态（已发生的审查与 PR 事实）

本节只登记**已实际发生**的事实，不预报合并；任务单 §15 为同一事实的对应章节。

### 10.1 源码构成（head `98a29d1`）

| 组成 | 提交 | 审查 |
|---|---|---|
| 核心金额 / 期末 / 连续期间（含真实入口与 schema v4） | `bd05415fe6de080b41f0dd9f6f56fb1f57d8dae0` | `review_core02_final` **接受** |
| 输出协议（长阻塞码窄通道 + 期末检查 DTO 全局一致性） | `3a8ae7ab0a3ca61ed15ddc6aa112eba6c4837795` | `review_output08_final` **接受** |
| 备份精确 v3 / v4 契约 | `33995009109cb922c86c9a5e9847e95554faaa4b` | 已独审 |
| 备份唯一性键语义加强 | `75b448dccbb964653713fae2b62fa3e365417d1a` | 已独审，合入当前 main 后冻结为 `98a` |

- 核心 `bd05415` 业务与输出源 `3a8ae7a` **未在 `75` / `98a` 改变**；`75` 只动备份自有源码 / 测试与三份文档。
- `98a29d1` 同时包含已合 main 的 `e86d248c2a573b12c884f311fb01952f209e2563`（LOCAL-06 审计 A，PR #58），本包未改审计代码。

### 10.2 审查接受要点

- **`review_core02_final`**：金额 / 期末 / 期间的**真实入口**与 v4 迁移接受，无剩余阻塞。
- **`review_backup06_final`**：自跑 **22 / 22 exit 0**；用**修复前**工具对真实合成产品 v3 / v4 生成旧备份，新工具
  `verify` / `restore-new` 后 schema 3 / 4 与 manifest / snapshot 哈希**全部不变**；恢复库上真实 `importIncremental` 追加 `ref-a`
  与既有 `Ref-A` **并存**；v3 仅在业务入口显式打开时升 v4。`NOCASE` 变体：旧工具接受，新工具 `source` / `verify` / `restore`
  **三入口均拒绝且无目标输出**；`xinfo` 完整键 / 来源 / 一一数量与额外 unique 拒绝通过。限制：`AUTOINCREMENT` 等存储选项
  **不在**严格验证范围，不声明已验证。
- **`review_output08_final`**：**61** 回修探针 + **47** 旧控制 + **3** 真实临时领域场景，两项 P2 均关闭。
  其中 **37 policy / 21 adapter / 18 transport 为员工自测结果**，不是 root 计数；**共享模型入口（HTTP / Agent / MCP / CLI）仍未接线**。

### 10.3 root 实跑与未定位项

- 精确 98a：`npm test` **55 / 55 套 exit 0**；Office **21 / 21** 与真实 **11 PDF** 几何检查通过；备份套件 **22 / 22**。
- 一次历史 HTTP 原生退出 **3221226505** 原因**仍未定位**：后续定向 22 项与多轮 55 套均通过，但**不**据此宣称已定位或
  修好本机环境；Windows 交付稳定性由 Issue #59 继续跟踪。
- 9.6 曾把员工 `214500` 日志当成 root 日志的写法**已更正**，不回退。

### 10.4 PR 与合并（不预报）

- PR [#60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 已创建为 **Draft**，覆盖本包已审候选（核心 + 备份 v3 / v4
  + 输出协议 + LOCAL-08 兼容增量）；**当前未合并**，本交接**不写任何 merge SHA**。
- 本次文档提交落在同一 PR；**最终文档验收与合并由 root 执行**，合并后由 root 补记实际 merge SHA；
  Issue [#47](https://github.com/huxiaoyang-code/youshu-fork/issues/47) 的关闭时点由 root 安排（当前未关闭）。

### 10.5 边界与文档范围

- 全部证据为合成临时库 / 随机回环端口；未使用真实账套、凭据或税局，**真实接入 0**，税局现场仍暂停。
- 本轮（最终文档轮）**只改 8 份交付文档**，不改源码 / 测试 / 脚本 / `package.json`：
  `docs/tasks/LOCAL-02.md`、`docs/handoffs/LOCAL-02.md`、`docs/handoffs/STATE.md`、`docs/tasks/README.md`、
  `docs/tasks/INDEPENDENT-PRODUCT-WORK.md`、`docs/FINANCE-OUTPUT-BOUNDARY.md`、`docs/tasks/LOCAL-08.md`、`docs/handoffs/LOCAL-08.md`。
- 审查对应关系与任务单 §15.1 一致：核心在 `bd05415`、输出在 `3a8ae7a`、备份在精确 98a，**每项独立接受**，不写成「核心与备份均在 98a」。
