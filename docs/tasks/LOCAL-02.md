# 任务单 · LOCAL-02 会计金额、期末完整性与连续期间

- 类型：后端领域（金额 / 计提 / 结转 / 封账 / 反操作守卫）+ 存储迁移 + 本地接线 + 契约文档 + 测试
- 状态：**实现与自测完成（含 review1 定向返工 F1–F4 与 review2 最终独审四项返工 P1–P4），未提交 / 未建 PR / 未合并，待管理者验收与 root 最终审查**（head / merge 由管理者后补，本文件不预报）
- 基线（源码）：`1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（LOCAL-01 源码 PR #46 合并）
  - 工作区已由管理者快进到 `94a79ef4a5e1c19e1320aed2e848ba42a7121712`（LOCAL-01 交接 PR #48，**仅 10 个文档**，源码无变化）
- 分支：`codex/huxiaoyang-code/local-02`
- 负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #47](https://github.com/huxiaoyang-code/youshu-fork/issues/47)（`Refs #20` / `Refs #13` / `Refs #14`）
- 契约文档：[ACCOUNTING-PERIOD-INTEGRITY](../ACCOUNTING-PERIOD-INTEGRITY.md) · 交接：[handoffs/LOCAL-02](../handoffs/LOCAL-02.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)（八包，本包进行中）

## 1. 目标

把本机会计核心的「金额 / 期末 / 连续期间」缺口补齐到可验收，而不是只给工具名或预留接口：

1. **金额精度与舍入唯一**：人民币分精度 + 十进制边界规则（整数分 + ROUND_HALF_UP），
   避免 `1.005` 等二进制误差、极小负数 / 极小正值被静默归 0、超界原值因舍入被接受、累计合计静默丢分；
   合法导入格式保留，旧非法输入仍拒绝。
2. **资产卡片 / 总账 / 连续月份计提**：按卡片实际业务适用性给出「应计提 / 未到期 / 已提足 / 无卡片不适用」；
   累计舍入在寿命内恰好提足，不早提也不漏最后一分；不得用未来期间已计提总额污染前期重算；
   缺卡片、原值 / 累计与总账差异明确阻止封账；`start_period`（计提开始）与取得日期分离，
   缺元数据有显式补项契约与真实维护入口，不制造无法解除的阻塞。
3. **可用期末检查 + 封账前置**：领域检查经现有 HTTP / Agent / MCP 实际入口可查，逐步给状态、
   适用 / 不适用理由与明确缺项；封账校验草稿清零、试算平衡、应计提完整、卡片 / 总账核对、
   必要损益 / 年末结转、连续期间顺序；无资产 / 无损益等明确不适用；重复动作不重复入账；
   已做步骤被后续分录改变时检测失效，不只按「曾经执行过」放行。
4. **反操作与前期变动的影响**：反结账 / 反过账 / 重算 / 删除 / 更早期间新增过账都受同一守卫；
   后续已封账或已过账年末结转时明确拒绝并给可执行顺序；失败时原库不变。
5. **持久结构迁移**：复用 LOCAL-01 的「先备份、后建结构、事务回滚、版本记录」，合成旧库升级、
   WAL 备份恢复与故障迁移回滚均有实测。
6. **独立验收**：十进制中点 / 上限 / 非法值、100 元分 3 月与小金额长寿命的累计舍入、连续月与跨年、
   卡片 / 总账差异、无适用步骤、缺计提 / 未结转阻断、重复动作、故障回滚、反操作守卫；
   通过真实 HTTP / Agent / MCP 串一条合成两月处理链与关键负例；全部合成临时库 + 随机回环端口。

## 2. 非目标

- 不做两套准则的科目 / 报表映射与辅助核算（**LOCAL-03**）、银行对账（LOCAL-04）、
  复杂现金流口径与 Excel/PDF 导出（LOCAL-05a / 05b）、完整审计与业务备份恢复（LOCAL-06）、
  持久批量任务与 CLI（LOCAL-07）。
- 不改 `coa.mjs`、`report-export.mjs`、税局模块（`tax-*`）、`public/*`、`package.json` / 锁文件。
- 不做一企多账簿 / `bookKey`；不把税局 / 银行未实现能力当作所有账套的封账前置。
- 不执行 Git 提交 / 推送 / 合并；不切换模型、不启动子 agent；不读真实账套 / 凭据 / 私有采集 / 其它 worktree。

## 3. 精确文件清单（本包唯一改动范围）

新增：

| 文件 | 作用 |
|---|---|
| `06-workbench/server/money.mjs` | 人民币分精度与十进制边界规则（解析 / 舍入 / 合计 / 比率 / 分期 / 输出保分校验） |
| `06-workbench/server/period-end-controls.mjs` | 期末检查步骤、封账前置断言、前期可改性守卫、卡片期间状态与卡片/总账核对 |
| `06-workbench/test/accounting-period-integrity.test.mjs` | 领域层独立验收（金额 / 计提 / 核对 / 封账 / 反操作 / 故障 / 迁移） |
| `06-workbench/test/accounting-period-http.test.mjs` | HTTP + Agent 真实入口两月处理链与关键负例 |
| `05-reconstruction/codex/mcp/finance-mcp/accounting-period-test.mjs` | stdio MCP → HTTP → Agent → SQLite 真实链路 |
| `docs/ACCOUNTING-PERIOD-INTEGRITY.md` | 金额 / 期末 / 连续期间契约与下游口径 |
| `docs/tasks/LOCAL-02.md` | 本任务单 |
| `docs/handoffs/LOCAL-02.md` | 本包版本化交接 |

修改：

| 文件 | 改动 |
|---|---|
| `06-workbench/server/accounting.mjs` | 金额路径改整数分；折旧按分期表 + 期间/全局口径；卡片补项与维护；封账 / 反操作守卫接线；结转失效检测 |
| `06-workbench/server/import-storage.mjs` | schema **v4**（`asset_cards` 补 5 列，只加列）；指纹金额按分归一 |
| `06-workbench/server/server.mjs` | 新增 `GET …/period-end-check`、`PATCH …/assets/:assetId`；守卫错误码 → 409（含导入入口） |
| `06-workbench/server/agent-tools.mjs` | 新增 `period_end_check`、`asset_update` |
| `05-reconstruction/codex/mcp/finance-mcp/tools.mjs` | 新增两个 MCP 工具契约（`origin: local`）；`asset_create` 补项字段；更新两处描述 |
| `06-workbench/scripts/test-all.mjs` | 仅追加三套测试入口 |
| `06-workbench/test/accounting-derived.test.mjs` | 折旧尾差断言按新分期表规则更新（含独立手算）；过账超额守卫改用手算场景 |
| `06-workbench/test/smoke.test.mjs` | 卡片补 `acquired_period` 与「未入账」显式登记（真实业务步骤，金额断言不变） |
| `06-workbench/test/report-export.test.mjs` | 补卡片取得期间、缺失卡片补项、封账前结转与按序封账（金额断言不变） |
| `06-workbench/test/report-export-http.test.mjs` | 封账前先结转本期损益（金额断言不变） |
| `06-workbench/test/import-incremental.test.mjs`、`import-incremental-http.test.mjs` | 封账前先结转本期损益（断言不变） |
| `05-reconstruction/codex/mcp/finance-mcp/contract-test.mjs`、`workflow-test.mjs` | 卡片补 `acquired_period` / 未入账登记（断言不变） |
| `docs/tasks/README.md`、`INDEPENDENT-PRODUCT-WORK.md`、`docs/handoffs/STATE.md`、`NEXT-SESSION.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`、`docs/DEVELOPMENT-TAKEOVER-PLAN.md` | 共享文档已由管理者 release（`local-02-docs-release.md`），按本包事实追加 |

未改：`coa.mjs`、`report-export.mjs`、`tax-*` 全部模块、`public/*`、`package.json` / 锁、`import-incremental.mjs`、
`db.mjs`（新列全部由 v4 迁移添加，基础建表语句保持原样）、`06-workbench/README.md`（API 表未登记新路由，需管理者确认归属）、
其它 worktree 与真实数据。

## 4. 验收口径（逐条可核验）

1. **金额**：`1.005 → 1.01`；`0.125 → 0.13`；`123.456 → 123.46`；`0.1 × 10 = 1.00`；
   `3 × 0.005 = 0.03`；凭证 / 期初 / 导入 / 报表同一口径；`999999999999.99` 合法、
   `999999999999.994` 与 `999999999999.9900000001` 拒绝；`-0.001` / `-1e-10` / `-0.000…1` 拒绝；
   `0.001` 标记不足一分并在期初 / 导入期初拒绝；`NaN` / `Infinity` / 指数 / 千分位（凭证）拒绝；
   存续金额（累计余额、补项累计）不受单笔上限约束；不能保分的合计显式拒绝（不静默丢一分）。
2. **计提**：`100 元 / 3 期 = 33.33 / 33.33 / 33.34`，第 3 期恰好 100，第 4 期不再提；
   `0.05 元 / 12 期` 前 11 期无金额、第 12 期提 0.05 且不阻塞封账；跨年 4 期合计等于可提提及额；
   期间口径累计不被后期污染（先提 2、3 月后查 1 月：累计 0、全局 66.67、应提 33.33）；
   旧库后期已存在 run 时历史应提额仍按期间口径（33.33），执行时由全局总额守卫拒绝并给撤销顺序；
   跨年查询计提开始前期间（2026 年起提、查 2025-12）必须 `not_started`、累计 0、剩余 100（未来 run 不决定历史状态）。
3. **卡片 / 总账**：缺卡片 / 原值差异 / 累计差异均阻止封账并定位科目与差额；
   补项卡片（`origin=supplement` + `acquired_period`）、`opening_accumulated`、未入账登记（必填原因）
   都能经真实维护入口登记；**未入账登记不是原值差异豁免**：登记后仍报原值差异且不得计提（`asset_ledger_pending`），
   需真实补录购入 / 期初入账并核对一致后才能继续；缺 `acquired_period` 是显式缺项而不是静默回退；
   12 月取得 / 1 月计提时 12 月仍核对原值且计提不适用；已过账后禁止改原值 / 寿命 / 期间 / 账簿状态 / 科目。
4. **封账**：无资产 / 无损益 / 非 12 月逐步 `not_applicable`；缺计提、缺结转、缺年末结转、
   跨过有业务的更早期间（凭证**或**应计提资产）、更晚期间已封账都阻止并给结构化明细；结转后补损益分录判为失效；
   重复计提 / 结转不重复入账；重复封账幂等；拒绝封账时期间状态与账簿不变。
5. **反操作 / 卡片维护**：更晚期间已封账时新建 / 过账 / 反过账 / 删除 / 反结账 / 计提 / 结转 / 增量导入一致拒绝
   （`later_period_closed` + 撤销顺序）；更晚期间已过账普通损益结转或计提时，前期损益 / 计提写入口同样拒绝
   （`later_profit_carryforward_depends_on_period` / `later_depreciation_depends_on_period`）；
   已封账期间或已过账计提下的卡片事实维护拒绝（`asset_card_affects_closed_period` / `asset_card_locked_by_posted_runs`），
   纯显示信息可改；按正确顺序可完成。
6. **迁移**：合成 v3 库带未 checkpoint WAL → 先备份（备份保持 v3 结构且含 WAL 数据、`integrity_check` ok）
   → 迁移后新列与默认值正确、旧数据不变；中途失败整体回滚（版本仍 3、无半截新列、业务不变、保留备份、
   重试重新备份）；备份可恢复为完整库。
7. **入口一致性**：领域 / HTTP + Agent / MCP 三套测试都串合成两月完整链（计提 → 结转 → 检查 → 封账）；
   关键负例（缺计提 / 缺结转 / 封账后写入 / 反结账顺序 / 导入前期被拒）在真实 HTTP 与 MCP 入口验证。
8. **测试纪律**：只使用合成临时库与随机回环端口；不 mock 核心会计；不连接旧服务、真实账套、税局或浏览器。
9. **最终独审四项（review2）**：① 反过账后改寿命 / 原值 / 残值 / 起提 / 取得 / 期初累计 / 账簿状态 / 科目再重过账旧草稿必须被拒（`depreciation_run_stale`）
   且旧 posted run 不被当成“已完成”，并按「删除重算」解除；纯名称 / 备注不锁死；② 凭证逐金额字段拒绝 `0.001` 类亚分非零数，全库不变；
   ③ 未入账登记只在取得期间之后计入阻塞，缺取得期间仍保守报告；④ 资产新增 / 修改的寿命非整数 / 负数 / 巨大值在**写入前**拒绝且不留下半张卡片，
   分期取额为 O(1)。

## 5. 实际测试（本机实跑，退出码为真实结果）

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `npm test`（`scripts/test-all.mjs`） | `06-workbench` | **50 / 50 套 exit 0**（最终代码实跑；含本包新增 3 套） |
| `node test/accounting-period-integrity.test.mjs` | `06-workbench` | **43 / 43** 通过，exit 0 |
| `node test/accounting-period-http.test.mjs` | `06-workbench` | **17 / 17** 通过，exit 0 |
| `node accounting-period-test.mjs` | `05-reconstruction/codex/mcp/finance-mcp` | **5 / 5** 通过，exit 0 |
| `node test/accounting-guards.test.mjs` | `06-workbench` | 23 / 23，exit 0 |
| `node test/accounting-derived.test.mjs` | `06-workbench` | 31 / 31，exit 0 |
| `node test/voucher-amount-guards.test.mjs` | `06-workbench` | 103 / 103，exit 0 |
| `node test/import-strict.test.mjs` | `06-workbench` | 54 / 54，exit 0 |
| `node test/smoke.test.mjs` | `06-workbench` | 28 / 28，exit 0 |
| `node test/report-export.test.mjs` | `06-workbench` | 21 / 21，exit 0 |
| `node test/report-export-http.test.mjs` | `06-workbench` | 29 / 29，exit 0 |
| `node test/import-incremental.test.mjs` | `06-workbench` | 49 / 49，exit 0 |
| `node test/import-incremental-http.test.mjs` | `06-workbench` | 22 / 22，exit 0 |
| `node contract-test.mjs` | `05-reconstruction/codex/mcp/finance-mcp` | 44 / 44，exit 0 |
| `node workflow-test.mjs` | `05-reconstruction/codex/mcp/finance-mcp` | 23 / 23，exit 0 |
| `node import-incremental-test.mjs` | `05-reconstruction/codex/mcp/finance-mcp` | 7 / 7，exit 0 |
| `node scripts/seed-demo.mjs`（临时数据目录） | `06-workbench` | exit 0，输出与脚本内固定金额一致（净利 8000 / −6900、资产 107400、勾稽 true） |

## 6. 实施中发现并修复的独立问题（管理者提前复现）

管理者在实施中提前复现并写入 `local-02-manager-feedback.md` 的四类边界，已在最终代码中修复并补独立回归：

1. **金额边界截断**：原先用固定 9 位标度判上限 / 符号 / 非零，会接受 `-1e-20`、`-1e-10`、
   `'-0.0000000001'`、`'999999999999.9900000001'`，并把正 `1e-20` 当真 0。现改为按**完整原值**判定：
   符号与非零看全部数字位，上限按整数位 + 全部小数位比较；极小正数保留 `subCent` 标记。
2. **合计输出丢分**：`centsToNumber` 原先只有 `MAX_SAFE_INTEGER` 护栏，`9007199254740991 分`
   转成 Number 后 JSON 会输出 `90071992547409.9`（少一分）。现在转换后必须能「最短十进制 → 再解析」
   还原为同一分数，否则抛 `money_total_not_representable`；`9007199254740990 分`（可表示）仍可用。
3. **单笔上限误加给存续金额**：`storedCents` 不再套用单笔上限（累计余额、补项期初累计可超过单笔上限），
   输出侧另有保分校验；单笔入口（凭证 / 期初 / 导入 / 卡片原值）保持原上限。
4. **资产时点与期间口径**：
   - `acquired_period` 缺失时不再回落 `start_period`：按「已存在」保守参与原值核对并报
     `asset_acquired_period_missing`（经 `asset_update` 补登记可解除），不制造「前期不存在」的证据；
     新增回归：12 月取得 / 1 月计提时 12 月仍核对原值、计提不适用、可正常封账。
   - `assetCardPeriodStatus` 的累计改为**按被查询期间**计算（另给全局 `accumulatedTotal` 参考值），
     本期应提额同时受期间剩余与全局剩余约束；新增回归：先提 2、3 月后查 1 月独立金额，
     以及旧库存在后期多提 run 时前期不超可提提及额。

## 7. 已登记限制

见 [ACCOUNTING-PERIOD-INTEGRITY §8](../ACCOUNTING-PERIOD-INTEGRITY.md)：双准则 / 辅助核算（LOCAL-03）、
复杂现金流（LOCAL-05b）、`report-export.mjs` 独立汇总层、完整审计与业务备份（LOCAL-06）、
批量编排与 CLI（LOCAL-07）、空月份不自动登记导致的倒序反结账要求、
**增量导入预检未预判后续派生依赖**（正式写入时由同一守卫拒绝并回滚）。税局现场暂停、真实接入 0。

## 8. 本轮定向返工（review1：独立预审 F1–F4 + 历史状态）

预审独立复现的 5 个问题已逐项修复，并把每个复现场景写成定向回归（先红后绿）：

| 编号 | 问题 | 修复 | 回归 |
|---|---|---|---|
| F1 | `add/update/deleteAssetCard` 无期间 / 依赖守卫，可在已封账期间改原值 / 累计 / 取得期间 / 起提期间 / 账簿状态 / 科目 | 新增 `assertAssetCardWriteAllowed`：受影响期间（取得 / 计提开始起算）有封账则拒绝 `asset_card_affects_closed_period`；已有已过账计提时金额 / 期间 / 账簿状态 / 科目字段拒绝 `asset_card_locked_by_posted_runs`；名称 / 备注 / 费用科目可改；拒绝时全库不变 | 领域 F1、HTTP F1（含 Agent）、MCP 已封账拒绝 |
| F2 | 普通后期损益结转读累计余额，但前期修改不拦截 | `touches.profit` / `touches.depreciation` 依赖守卫：后续已过账普通结转 / 计提时拒绝 `later_profit_carryforward_depends_on_period` / `later_depreciation_depends_on_period`，`details` 给依赖凭证与倒序撤销顺序 | 领域 F2 两条、HTTP F2、MCP F2 |
| F3 | 期间连续性只看凭证，零凭证但应计提的前期可被跳过并封后期 | `periodSequenceStep` 增加资产应计提证据扫描（`due` / `draft_pending` / `life_expired`），新增阻塞码 `previous_period_depreciation_pending`；真正无适用业务空期仍可跳过 | 领域 F3（1/2/3 月合计 100 手算）、HTTP F3 |
| F4 | `pending_purchase_voucher` + 任意备注成为原值差异 / 封账旁路，未入账仍能提 10 折旧 | 未入账卡片**不再**排除原值核对，额外报 `asset_purchase_voucher_pending`；`generateDepreciation` 对未入账卡片明确拒绝 `asset_ledger_pending`，且阻断判定先于任何凭证写入；真实补购入 / 期初入账 + 改回 `booked` 才能继续 | 领域 F4、HTTP F4、MCP F4 |
| 历史状态 | `assetCardPeriodStatus` 用全局余额决定 `fully_depreciated` / 截断历史应提额 | 历史状态 / 应提额只用「截至该期间」的事实；全局余额改为执行时总额守卫 `depreciation_global_over_depreciable`（给撤销顺序），并保留旧库兼容回归 | 领域「历史状态：跨年查询 2025-12」「旧库已存在后期 run」 |

因新规则而不成立的旧断言 / 夹具已按「补真实业务步骤、保留金额与失败原子性断言」处理，理由记录在交接 §3：
`smoke` / `contract` 改用期初已入账固定资产（替代未入账旁路）、`accounting-derived` 把补项前置到计提前并按倒序撤销后期计提、
`period-end-check` 不再产生 `acknowledged` 状态。

## 9. review2：最终独立审查四项阻塞的定向返工

管理者已在该 head 上完整跑过 50 / 50 套（含 Office 21 / 21），但最终独立审查（`fork_turns=none`）实测四个阻塞；
**旧 50 / 50 候选结果不能代表最终通过**。四项已逐项修复并补先红后绿的定向回归：

| 编号 | 问题 | 修复 | 回归 |
|---|---|---|---|
| P1 | 反过账 → 改寿命（10→5）→ 重过账旧草稿 → 结转：旧草稿金额 10 与新定义 20 失配，但仍被当成“已计提完成”，期末检查 `ready=true` 并可封账。卡片变更只锁 posted runs，`postVoucher` 只看累计是否超原值，检查把任何 posted run 当完成 | 新增 `depreciation_run_stale`：① `postVoucher` 对 `kind=depreciation` 的旧草稿按卡片**当前定义**（寿命 / 原值 / 残值 / 起提 / 取得 / 期初累计 / 账簿状态）重算并校验金额与分录科目，失配即拒绝并给「删除旧草稿 → 重新计提」路径，不静默改原凭证；② `assetCardPeriodStatus` 新增 `posted_stale`（已过账但与当前定义不一致），`depreciationStep` / `generateDepreciation` 同一口径阻止，不再按“有 posted run”放行；名称 / 备注等纯显示字段不参与判断（不无意义锁死） | 领域 P1（复现原场景 10→20 + 直接写库形态 + 撤销重算 20 后可封账）、P1 字段覆盖（原值 / 残值 / 起提 / 取得 / 期初累计 / 账簿状态 / 科目，纯名称备注可重过账）、HTTP P1（含 Agent 409）、MCP P1 |
| P2 | `accounting.mjs` 的 `parseVoucherAmount` 丢 `subCent`：`{1002, debit:1, credit:0.001}` + `{1001, debit:0.001, credit:1}` 成功并把两个 0.001 静默存 0 | 凭证**逐金额字段**拒绝非零但不足一分（数字 / 十进制文本 / 极小指数 / 舍入成 0 的正数），`check` 与 `create` 共用同一入口；正常边界（`0.005 → 0.01`、`0.01`）保留，拒绝时全库不变 | 领域 P2、HTTP P2（含 Agent `voucher_check` / `voucher_create`）、MCP P2 |
| P3 | `period-end-controls` 的未入账登记阻塞未按「该期间卡片是否存在」过滤：取得期 2026-03 / 起提 2026-04 的待补卡片把 2026-01 检查阻塞 | `assetReconciliationStep` 只在 `cardExistsAt(card, period)` 成立时计入 `asset_purchase_voucher_pending`；缺取得期间仍按「已存在」保守报告（不放宽真实未入账旁路）。真实补录购入 + 改回 `booked` 才解除 | 领域 P3（Jan / Mar / Apr，已录入 / 未录入，缺取得字段）、HTTP P3 |
| P4 | 资产新增先落库、后 `cardDto` → `splitEvenlyCents` 才失败：`useful_life_months=4294967296` 抛 `Invalid array length`，卡片已持久化且列表 / 检查持续报错；小于 `2^32` 的巨大值线性 `fill` 耗内存 | ① 写入口验证计提期数为 `1 ~ 1200` 的整数（技术输入边界，不冒充法定年限），负数 / 0 / 非整数 / 巨大值一律拒绝；② 分期改为 O(1) 取单期（`evenSplitAmountCents` / `cardMoney().amountAt`），`splitEvenlyCents` 保留但限展开上限；③ 落库 + DTO 构造同一保存点，任何后续计算失败整体回滚；add / update 两路同规则 | 领域 P4（`2^32` / `2^32-1` / 负数 / 0 / 非整数 / 1201 / 边界 1200 / 更新失败回滚 / 旧库极端大寿命行读路径 O(1)）、HTTP P4（含 Agent `asset_create` 与 `PATCH`）、MCP P4（含参数上下限） |

顺带修正：`import-storage.mjs` 中 `acquired_period` 迁移注释原写“核对时回落 `start_period`”，与实际「不回填、报缺项」矛盾，
已改为准确描述（**不改迁移语义**）。本轮回工**未新增存储列**，schema 仍为 v4 的同一 5 列，v3→v4 升级 / WAL 备份恢复验证不变。
LOCAL-06 备份 CLI 尚未合并且当前只支持 v3，本轮不触碰它；v4 兼容增量由 root 后续整合后另派。
