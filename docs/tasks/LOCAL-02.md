# 任务单 · LOCAL-02 会计金额、期末完整性与连续期间

- 类型：后端领域（金额 / 计提 / 结转 / 封账 / 反操作守卫）+ 存储迁移 + 本地接线 + 契约文档 + 测试
- 状态：**最终候选已独立审查通过；已提交、已推送并创建 Draft PR [#60](https://github.com/huxiaoyang-code/youshu-fork/pull/60)（未合并，尚无 merge SHA，本文件不预报）**
  - 源码 head（本分支实际）`98a29d1c2e3e8d2e513aadf79a0aca7b04cc45c7`，其中已包含已合入 main 的 `e86d248c2a573b12c884f311fb01952f209e2563`（LOCAL-06 审计 A，PR #58）。
  - 独立审查（均未参与实现、不继承实施上下文）已接受，**每项在各自的候选上独立接受、不合并成同一次审查**：核心 `review_core02_final` 在 `bd05415fe6de080b41f0dd9f6f56fb1f57d8dae0`（其业务源码经后续提交到 98a 未改变）、输出协议 `review_output08_final` 在 `3a8ae7ab0a3ca61ed15ddc6aa112eba6c4837795`（源后续未改）、备份 `review_backup06_final` 在**精确 98a**（最终 22 / 22 与旧备份兼容独审）。
  - root 在精确 98a 上实跑：完整 **55 / 55 套 exit 0**、Office **21 / 21**、真实 **11 PDF** 几何检查、备份 **22 / 22**；日志为忽略目录内相对证据名 `local-02-manager-indexkeys-final55.log`（员工自带日志另计，不混归属）。
  - 下文 §12–§14 的「未提交 / 未建 PR / 待 root 独审」是各自**阶段快照**（当时事实），最终状态以本节与 §15 为准，历史文本不改写。
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
10. **取得期间一致性（review3 P2）**：取得期间晚于被生成 / 被查询期间时，生成与校验**共用同一口径**：
   状态 `not_existed`、不写任何计提凭证、不算「应计提未计提」、不阻塞封账；改取得期间并删除旧计提后**不会又写回错误凭证**；
   已存在的旧数据（取得期间之前的已过账计提）仍报 `depreciation_run_stale` 并可撤销重算；正确适用期可计提并封账；
   名称 / 备注仍不锁死。

## 5. 实际测试（本机实跑，退出码为真实结果）

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `npm test`（`scripts/test-all.mjs`） | `06-workbench` | **50 / 50 套 exit 0**（最终代码实跑；含本包新增 3 套） |
| `node test/accounting-period-integrity.test.mjs` | `06-workbench` | **45 / 45** 通过，exit 0 |
| `node test/accounting-period-http.test.mjs` | `06-workbench` | **18 / 18** 通过，exit 0 |
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
LOCAL-06 备份 CLI 当时尚未合并且只支持 v3，本轮未触碰它；v4 兼容增量由 root 整合已审 LOCAL-06 后另派（已完成，见 §11）。

## 10. review3：取得期间一致性（同影响面 P2）

独立审查确认原四项复现（P1–P4）均已关闭（域 43 / HTTP 17 / MCP 5 通过）后，新增一项同影响面 P2：
`period-end-controls.mjs` 的 `expectedDepreciationCents`（校验已过账计提）在 `acquired_period > period` 时返回 `not_existed` / 应提 0，
而 `assetCardPeriodStatus` 的「本期无计提记录」分支自己按分期表算 `due`、不看取得期间。
真实复现：卡片 100 / 寿命 10 / 取得与起提 1 月 → 计提 10 → 反过账 → 改取得为 2 月 → 旧凭证重过账被正确拒绝 →
按指引删除旧凭证 → **`generateDepreciation(1 月)` 又成功写入 10** → 检查立即 `depreciation_run_stale`（期望 0）→ 再生成也 stale：
纠正后的业务路径陷入循环。

| 项 | 修复 | 回归 |
|---|---|---|
| 生成 / 校验两套口径 | 「本期无计提记录」分支**删除自算**，直接复用 `expectedDepreciationCents`；新增状态 `not_existed`（与 `not_started` 分开），`not_existed` / `not_started` 不给 `dueAmount`（保持既有 DTO 口径）；`depreciation` 步骤不阻塞，`generateDepreciation` 返回 `voucher: null` + `skipped` | 领域 2 项（域 43 → 45）、HTTP 1 项（17 → 18） |
| 已存在旧数据一致 | 旧库已有「取得期间之前」的已过账计提仍报 `posted_stale` / `depreciation_run_stale`（`expectedStatus = not_existed`）并阻止封账；撤销后不再写回，检查恢复 | 领域第 2 项（直接改库模拟旧数据） |
| 不选「写前拒绝」 | 只加写入口拦截无法处理旧数据，并会掩盖两套判定矛盾（本次复现就是「写入允许、校验拒绝」）；改用统一适用期口径，真实矛盾（总账仍有原值）由 `asset_missing_card` 如实暴露 | 领域第 1 项（把购入凭证也移到 2 月后才可封账） |
| 纯显示字段 | 名称 / 备注不参与一致性判断；2 月已过账后改名 / 备注仍为 `posted`，可结转并封账 | 领域第 1 项、HTTP 链末段 |

既有断言变更 1 处：P3 用例「取得 2026-03 / 起提 2026-04」的 1 月卡片状态 `not_started` → `not_existed`（附理由注释，
**金额 / 阻塞 / 原子性断言全部保留**）。既有四项 / 累计舍入 / 反操作 / 原子性规则未回退；未新增存储列、未改迁移。

## 11. 合并后的备份兼容整合轮（root 派工）

PR [#55](https://github.com/huxiaoyang-code/youshu-fork/pull/55) 已合并（merge `98977e0`，已审源码 head `b2dcba3`）后，
备份子包当时严格只认 v3，而本包已把 `IMPORT_SCHEMA_VERSION` 推到 4。root 已在本 worktree 派单完成兼容整合：
**不改本包任何业务实现**（金额 / 期末 / v4 迁移与守卫均为原样），只改 LOCAL-06 自有的 3 个源码 / 测试文件
与仅追加的 `scripts/test-all.mjs` 登记：

1. 备份模块改为 **v3 / v4 各自独立的精确结构契约**：列名 / 声明类型 / NOT NULL / **默认值** /
   主键列顺序 / UNIQUE 约束列组 / 外键完整集合与动作 / 迁移记录连续性 / 迁移前备份记录；
   版本号只用于选契约；未知表（未来组件）、未来版本、旧版本、只抬版本号、缺列、错默认值 /
   NOT NULL / 类型、迁移记录不连续均拒绝；
2. **v3 旧备份**：只读 `verify` + `restore-new` 到全新目录成功，备份与源库**都不被迁移 / 改写**；
   恢复的 v3 由产品入口**显式**打开才走本包的 v3→v4 迁移，实际差异（5 列按默认值落库、
   旧卡片报 `asset_acquired_period_missing` / `asset_accumulated_mismatch`）已写入备份套件断言；
3. **v4 备份**：用本包真实 API 合成建库（资产 5 个补项列 + 期初累计 + 连续两期计提与总账 +
   真实封账 + 两批导入批次 / 来源），`createBackup → verifyBackup → restoreNew` 后用真实入口读取
   （金额 / 凭证 / 卡片 / 计提 / 批次 / 期间状态均为独立手算预期）并在恢复库上继续记账与计提；
4. 契约文档 `docs/ACCOUNTING-PERIOD-INTEGRITY.md` 新增 §5.1 记录该备份边界；本任务单只追加事实，
   **不改既有验收结论**。

测试：备份套件 **20 / 20 exit 0**；`06-workbench` 下 `npm test` **53 / 53 套 exit 0**（含 Office 真实 PDF
几何校验；本包领域 / HTTP / MCP 三套也在这次全量内均 exit 0，但本轮未单独重跑计数）。
本包业务代码本轮未改，因此不声称对本包金额 / 期末逻辑做了新的独立审查。

## 12. LOCAL-08 新工具模型边界兼容增量（上一轮，head `04c38d4`）

在**不改本包会计 / DB / 期间业务实现**、不改 LOCAL-08 已有边界的前提下，把本包新增的 `period_end_check` / `asset_update` 按真实 DTO 接入 LOCAL-08 自有的可测试适配层 / transport 合约；**未挂载**共享 HTTP / Agent / MCP / CLI 入口（该共享窗口尚未移交）。

- `period_end_check`：登记只读 `query/account_set`；模型投影只含期间、`ready`、固定步骤状态计数、blocked 步骤 id、阻塞计数与固定阻塞码。标题 / 原因 / `message` / `details` / 资产名 / 科目名 / 备注等任意用户文本不进入投影；未知步骤 / 状态 / 阻塞码 fail closed。其后由 §13 把形状校验升级为**全局一致性**（7 步唯一齐全 + `ready` / blocking / blocked 步骤语义一致）。
- `asset_update`：登记写 `write/account_set`；只有显式写调用才执行，未知 / 只读工具不会因名称相似被当成写。成功必须真实结果含卡片 `id` 才 `applied:true`；失败保留 `applied:"unknown"` / `needsLocalReview:true`。投影最小白名单：`assetId` / `kind` / `startPeriod` / `acquiredPeriod` / `originalCost` / `usefulLifeMonths` / `openingAccumulated` / `accumulated` / `remaining` / `ledgerStatus` / `origin`；不含名称 / `ledger_note` / 科目 / 备注。
- 新期间 / 资产校验错误与 `period_end_check_failed` 在 policy / transport 两层都有固定 code → category 映射（如 `acquired_period_invalid → asset`、`asset_card_affects_closed_period → asset`、`period_end_check_failed → period_end`、`profit_not_carried_forward → period_end`、`depreciation_run_stale → depreciation`），不再落 `unknown`；错误仍只回声已登记 code。
- 适配层真实临时库 fixture 改为**真实完整资产登记**：原值 1200、`2026-02` 取得 / 起提、借贷平衡购入凭证（借 1601 / 贷 1002 各 1200）、真实计提 95；保留**真实封账成功**与 `period_end_check_failed` **前置拒绝**两条路；禁止 mock / bypass / 跳过封账保护。
- 原有边界未放宽：错误清洗、参数快照、引用绑定 / 过期 / 跨账套、4 MiB / 64 MiB / 节点预算、写后降级、不可变 snapshot 与并发隔离均保持原语义。

测试（**上一轮，head `04c38d4`** 实际输出；回修后的本轮结果见 §13）：

| 套件 | 结果 |
|---|---|
| `finance-output-policy` | **35/35**，exit 0（原 34 项含义保留） |
| `finance-model-adapter` | **20/20**，exit 0（原 19 项含义保留） |
| `finance-model-transport-test` | **17/17**，exit 0（原 16 项含义保留） |
| 完整 `npm test`（设 `REPORT_OFFICE_PYTHON`） | **55/55 套 exit 0**；Office **21/21**、真实 **11 PDF** 几何通过（外部 poppler + pdfplumber）。首次全量时 `import-incremental-http` 曾一次异常退出 exit 3221226505，**原因未定位**，不下因果结论；该套件单独重跑 22/22、后续完整重跑均 55/55 exit 0 |

范围：本轮跨包只改已登记的 LOCAL-08 6 个源码 / 测试文件与 3 份 08 文档，另补 `docs/LOCAL-BACKUP.md` 独审非阻塞项；**未改**本包 `accounting.mjs` / `money.mjs` / `period-end-controls.mjs` / `import-storage.mjs` / DB / 期间业务，未改 `agent-tools.mjs` / `server.mjs` / MCP 入口 / `scripts/test-all.mjs`。状态：**未提交 / 未建 PR / 未合并**，待 root 最终增量独审 / PR。

## 13. 输出协议独立审查 2 项 P2 回修（本轮，回修候选待 root 复审）

独立审查在 head `04c38d4` 上复现两个 P2（均不是“绿测试能覆盖”的问题），已逐项回修并补先红后绿定向回归；**不改本包会计 / DB / 期间业务源码**。

| 项 | 复现 | 回修 | 回归 |
|---|---|---|---|
| P2-1 真实长阻塞码被通用预算吞掉 | `depreciation_life_expired_underprovided`（39 字符）/ `previous_period_depreciation_pending`（36 字符）虽在白名单，仍被通用 `PROJ_TOKEN_RE`（最多 32）过滤；真实输出 `ok:true` / `blockingCount:1` / `blockingCodes:[]` / `projectionDropped:1`，transport 却通过 | 通用 32 字符 token 预算与 40 字符长度上限**均未改**，只给**已登记固定代码常量的精确字面量**开窄通道（`REGISTERED_CODE_LITERALS` + `isProjectionStringAllowed`，sanitize 标量 / 数组两路共用）；policy、adapter、transport 三层都要求同一批已登记码，未知码仍 fail closed | 策略：19 条真实阻塞码**逐条**（非仅两个示例）完整投影 + `projectionDropped:0`；两条长码同时出现、同一码多条原因仍完整；未登记 37 字符串 / 41 字符串 / 中文原文仍被丢弃或拒绝。transport：长码信封通过、未登记 / 超长 / 中文 token 仍 `envelope_projection_invalid` |
| P2-2 只验单字段不验 DTO 全局一致性 | `ready:true` + `steps:[]` + `blocking:[]`、`ready:true` + 7 个重复 `draft_vouchers`、`ready:true` + 全 blocked 且 `blocking` 非空，都被投影成功、建 ref、transport 通过 | 新增纯函数 `isPeriodEndCheckConsistent`（policy 内，**不 import** 会开业务 DB 的 `period-end-controls.mjs`，保持纯模块边界）：7 个已登记步骤唯一齐全、状态值域、每条顶层 `blocking` 归属真实 blocked 步骤、`ready` ⇔ 无阻塞、每个 blocked 步骤至少一条原因（不机械比较原因数 = 步骤数）；policy 据此 fail closed，adapter 在同一判定上直接报 `model_result_invalid` 且不建 ref | 策略：10 类矛盾 / 缺步 / 重复 DTO 均 `summaryUnavailable`，合法正例仍投影。适配层：以**真实临时库 7 步 DTO**为基底注入同类负例，均 `model_result_invalid`、`localRef` 不存在、policy 引用池不变；同 harness 不改内容的对照仍成功建引用；真实长码正例 `blockingCount:3` / `projectionDropped:0` / transport 通过 |

测试（本轮实际输出）：

| 命令 | 结果 |
|---|---|
| `node test/finance-output-policy.test.mjs`（`06-workbench`） | **37 / 37**，exit 0（原 35 项含义保留） |
| `node test/finance-model-adapter.test.mjs`（`06-workbench`） | **21 / 21**，exit 0（原 20 项含义保留） |
| `node finance-model-transport-test.mjs`（`05-reconstruction/codex/mcp/finance-mcp`） | **18 / 18**，exit 0（原 17 项含义保留） |
| 设 `REPORT_OFFICE_PYTHON` 后 `npm test`（`06-workbench`） | **55 / 55 套 exit 0**，Office **21 / 21**、真实 **11 PDF** 几何通过；最终代码日志 `.agent-runs/local02-55-suites-20261022-204605-rewrite2-final.log` |

限制与事实边界：共享 HTTP / Agent / MCP / CLI 入口仍未接线（本包自己的 `period_end_check` / `asset_update` 真实入口不在输出协议层）；真实账套 / 税局未使用；本轮**未定位** §12 记录的 `import-incremental-http` exit 3221226505 原因（本次完整重跑未重现，不下因果结论，由 root 的 Windows 交付稳定性检查继续跟踪）。状态：**回修候选，待 root 独立增量复审**；未提交 / 未建 PR / 未合并。

改动文件：`server/finance-output-policy.mjs`、`server/finance-model-adapter.mjs`、`test/finance-output-policy.test.mjs`、`test/finance-model-adapter.test.mjs`、MCP `finance-model-transport-test.mjs`。**transport 源码未改**（其 token 表已登记这 19 条码、上限 40 能容纳 39 字符），因此只补测试锁定一致性。本包会计 / DB / 期间源码与备份（339 / 53 同 worktree 已交付部分）均未改。

## 14. 核心备份索引键语义回修（本轮，待 root 冻结与备份独审）

独立审查在银行候选上发现并**实际证实**：继承旧版本（339，无 bank 组件）的核心备份模块也存在缺陷——
`import_voucher_sources` 表级 `UNIQUE (source_system, enterprise_key, source_voucher_id)` 只把最后一列改成
`COLLATE NOCASE`（列 / 默认值 / 外键全部不变）时，旧模块 `create` / `verify` / `restore` **全部放行**；
恢复后真实增量导入已存 `Ref-A` 再追加 `ref-a` 抛 `ERR_SQLITE_ERROR`，而正常 `BINARY` 对照是 `applied`
且两条来源并存。根因：`uniqueColumnGroups` 只用 `pragma_index_info` 读列名，没有校验真实唯一性的**比较规则**。

本轮只改备份自有文件（本模块源码 / 测试 + 三份文档：契约 / 任务单 / 交接），**未改**会计 / DB / 期间 / 金额 / schema 迁移、
输出 policy / adapter / transport、其它测试、`scripts/test-all.mjs`（无需重登记，套件已在其中）。

| 项 | 修复 | 回归 |
|---|---|---|
| 唯一性键语义不完整 | 契约从「列名组」升级为 `uniqueConstraint(origin, collationKey(...))`：主键索引（`pk`）/ `UNIQUE` 约束（`u`）逐条声明，键列默认 `BINARY` + `ASC`；验证改用 `PRAGMA index_xinfo` 的键列 / `cid`（表达式）/ `coll`（排序规则）/ `desc`（方向）+ `index_list` 的 `unique` / `origin` / `partial`，与契约**一对一**匹配 | 域：`NOCASE` / `RTRIM` / 主键文字键 `NOCASE` / 主键键列 `DESC` 四种变体均 `unique`（语义不同，给 `reason` 与固定令牌明细） |
| 额外 / 重复 / `origin=c` 唯一索引被忽略 | 不再只看 `origin='u'`：`origin=c` 的命名唯一索引同样参与比对，契约外一律 `unexpected_unique_index`；v1 已删除的 `idx_import_bindings_set` 不要求存在，重新加回即被拒 | 域：复活旧命名唯一索引 / 同一唯一键重复声明 / 表达式（令牌 `expression`）/ `WHERE` 部分索引四种变体均拒绝 |
| `INTEGER PRIMARY KEY` 只看列名 | 新增 `rowidAlias` 契约：`true` 的表必须**没有**主键索引且 `rowid` 与主键列逐行相等（`WITHOUT ROWID` / `INTEGER PRIMARY KEY DESC` 都不符）→ `rowid_alias`；多列文字主键按真实主键索引比对 | 域：`vouchers.id INTEGER PRIMARY KEY DESC` 被拒（`rowid_alias` + 额外主键索引） |
| 正常结构 / 旧产物不得误拒 | 非唯一查询索引不作为结构证据、也不据此拒绝；清单格式与 `formatVersion` **未变**（只强化验证，不新增字段） | 域：与真实 DDL **同义重建**的表、额外非唯一索引均正常备份 / 验证；两种 v3 / v4 均继续通过 |
| 旧工具产物向后兼容 | 修改**前**用冻结源码生成真实 v4 / v3 合成备份（16 表 / 88 行与 87 行），修改后核对 | 实跑事实：清单 / 快照 sha256 未变、`verify` + `restore-new` 成功、恢复文件仍是备份时版本、期初 / 余额 / 凭证 / 来源一致；恢复库上真实增量导入追加 `ref-a` 仍 `applied` 且 `Ref-A` / `ref-a` 共存（费用 700 → 705）；同一 `NOCASE` 变体改前被放行、改后被源库与快照两侧同时拒绝 |
| 错误输出边界 | 明细只含表名 / 列名 / 计数 + 固定令牌（`pk` / `u` / `c`、`BINARY` / `NOCASE` / `RTRIM`、`expression`、布尔升降序），未知排序规则只报 `nonstandard` | 域：每个变体都断言明细**不含** `CREATE TABLE` / `COLLATE` / `SELECT` / 本机路径 / 账套名 / 企业标识 / 表达式原文 |

测试（本轮实跑）：`node test/local-backup.test.mjs`（`06-workbench`）→ **22 / 22 exit 0**（原 20 项含义全保留，
新增第 21 项 v4 十变体 + 两组正常对照、第 22 项 v3 旧快照三变体 + v3 正常对照）；
设 `REPORT_OFFICE_PYTHON` 后 `npm test` → **55 / 55 套 exit 0**（Office **21 / 21**、真实 **11 PDF** 几何通过）。
先红后绿：同一套测试换回修改前模块（SHA256 回位核实）为 **20 / 22**，两个新项均以「期望拒绝、实际接受」失败，
恢复修改后代码后 **22 / 22**。

限制与事实边界：只对**唯一性**索引做语义比对（非唯一索引不改变业务规则）；`AUTOINCREMENT` 等存储选项不在本轮范围；
表达式 / 部分索引目前只作为拒绝依据（真实 v3 / v4 没有）；未使用真实账套 / 税局；未改清单格式。
状态：**实现与自测完成，待 root 冻结与备份独立审查**；未提交 / 未建 PR / 未合并。

改动文件：`06-workbench/server/local-backup.mjs`、`06-workbench/test/local-backup.test.mjs`、
`docs/LOCAL-BACKUP.md`、`docs/tasks/LOCAL-02.md`、`docs/handoffs/LOCAL-02.md`。

## 15. 最终出版状态（本轮纯文档，权威）

本节只记录**已经发生的事实**，不预报合并结果。§11–§14 的阶段结论（含各自「未提交 / 未建 PR / 待独审」）按其时点阅读。

### 15.1 源码构成（head `98a29d1`）

| 组成 | 提交 | 独立审查 |
|---|---|---|
| 核心金额 / 期末 / 连续期间（金额、期末、期间真实入口与 schema v4） | `bd05415fe6de080b41f0dd9f6f56fb1f57d8dae0` | `review_core02_final` **接受** |
| 输出协议（长阻塞码窄通道 + 期末检查 DTO 全局一致性） | `3a8ae7ab0a3ca61ed15ddc6aa112eba6c4837795` | `review_output08_final` **接受** |
| 备份精确 v3 / v4 契约 | `33995009109cb922c86c9a5e9847e95554faaa4b` | 已独审 |
| 备份唯一性键语义加强 | `75b448dccbb964653713fae2b62fa3e365417d1a` | 已独审，合当前 main 后冻结为 98a |

- 核心 `bd05415` 的业务与输出源 `3a8ae7a` **在 `75` / `98a` 上未被改动**；`75` 只改备份自有源码 / 测试与三份文档。
- 审查对应必须逐项一致，不合并成「均在 98a」：核心 `review_core02_final` 在 `bd05415`、输出 `review_output08_final` 在 `3a8ae7a`、备份 `review_backup06_final` 在**精确 98a**；核心业务源码与输出源码经后续提交到 98a 未改变。不引用更早候选的绿测试代替。

### 15.2 独立审查接受要点（事实）

- `review_core02_final`：金额 / 期末 / 期间**真实入口**与 v4 迁移接受，无剩余阻塞。
- `review_backup06_final`：自跑备份 **22 / 22 exit 0**；用**修复前**工具对真实合成产品 v3 / v4 生成旧备份，新工具 `verify` / `restore-new` 后 schema 3 / 4 与 manifest / snapshot 哈希**均不变**；恢复库上真实 `importIncremental` 追加 `ref-a` 与既有 `Ref-A` **并存**；v3 仅在业务入口显式打开时升 v4。`NOCASE` 变体：旧工具接受，新工具 `source` / `verify` / `restore` **三入口均拒绝且无目标输出**；`xinfo` 完整键 / 来源 / 一一数量与额外 unique 拒绝通过。限制：`AUTOINCREMENT` 等存储选项**不在**严格验证范围（不声明已验证）。
- `review_output08_final`：**61** 回修探针 + **47** 旧控制 + **3** 真实临时领域场景，两项 P2 均关闭。其中 **37 policy / 21 adapter / 18 transport 为员工自测结果**，不是 root 计数；**共享模型入口（HTTP / Agent / MCP / CLI）仍未接线**。

### 15.3 root 实跑与已知未定位项

- 精确 98a：`npm test` **55 / 55 套 exit 0**；Office **21 / 21** 与 **11 PDF** 几何检查通过；备份套件 **22 / 22**。root 此前在 `3a` 的 55 / 55 是**另一次运行**，两者日志不互相冒充。
- 一次历史 HTTP 原生退出 **3221226505** 的原因**仍未定位**：后续定向 22 项与多轮 55 套重跑均通过，但**不得**据此宣称已定位或修好本机环境；Windows 交付稳定性（Issue #59，含七份新增文件包）继续跟踪。
- 9.6 曾把员工 `214500` 日志误记为 root 日志的写法**已更正**，不回退。

### 15.4 PR 与合并（不预报）

- PR [#60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 已创建为 **Draft**，标题 / 正文范围为本包已审候选（核心 + 备份 v3 / v4 + 输出协议 + LOCAL-08 兼容增量），**当前未合并**。
- 本任务单与交接的最终文档提交在该 PR 上；**文档验收与合并由 root 执行**，合并后由 root 补记实际 merge SHA。本节不写任何 merge SHA，也不声称文档已通过 root 验收。
- Issue [#47](https://github.com/huxiaoyang-code/youshu-fork/issues/47) 随 PR 合并与交接归档后按 root 安排关闭；当前未关闭。

### 15.5 边界

- 全部证据来自**合成临时库 / 随机回环端口**；未使用真实账套、凭据或税局，**真实接入仍为 0**，税局现场仍暂停。
- 本轮（最终文档轮）**只改 8 份交付文档**，不改源码 / 测试 / 脚本 / `package.json`：`docs/tasks/LOCAL-02.md`、`docs/handoffs/LOCAL-02.md`、`docs/handoffs/STATE.md`、`docs/tasks/README.md`、`docs/tasks/INDEPENDENT-PRODUCT-WORK.md`、`docs/FINANCE-OUTPUT-BOUNDARY.md`、`docs/tasks/LOCAL-08.md`、`docs/handoffs/LOCAL-08.md`。
