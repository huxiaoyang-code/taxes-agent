# 交接 · LOCAL-02 会计金额、期末完整性与连续期间

- 任务单：[tasks/LOCAL-02](../tasks/LOCAL-02.md) · 契约：[ACCOUNTING-PERIOD-INTEGRITY](../ACCOUNTING-PERIOD-INTEGRITY.md)
- 负责人：`huxiaoyang-code`（已核实）；远端载体：[Issue #47](https://github.com/huxiaoyang-code/youshu-fork/issues/47)
  （`Refs #20` / `Refs #13` / `Refs #14`）
- 基线（源码）：`1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（LOCAL-01 源码 PR #46 合并）
  - 工作区已由管理者快进到 `94a79ef4a5e1c19e1320aed2e848ba42a7121712`（LOCAL-01 交接 PR #48，仅 10 个文档，源码无变化）
- 分支：`codex/huxiaoyang-code/local-02`
- 状态：**实现与自测完成（含 review1 定向返工 F1–F4 与历史状态），未提交、未推送、未建 PR、未合并，待管理者验收**
  - head / merge 由管理者后补；本交接**不预报**审查结论、head 或 merge。
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
  （`100 / 3 → 33.33 + 33.33 + 33.34`），寿命外不再提，不提前多提。
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

## 4. 实际测试与退出码（本机实跑）

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `npm test` | `06-workbench` | **50 / 50 套 exit 0** |
| `node test/accounting-period-integrity.test.mjs` | `06-workbench` | **38 / 38**，exit 0 |
| `node test/accounting-period-http.test.mjs` | `06-workbench` | **13 / 13**，exit 0 |
| `node accounting-period-test.mjs` | `finance-mcp` | **4 / 4**，exit 0 |
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
