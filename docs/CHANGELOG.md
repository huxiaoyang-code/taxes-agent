# 变更日志 · CHANGELOG

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added — 本机产品路线 LOCAL-02：会计金额、期末完整性与连续期间（2026-10-22）

- 实现与自测完成，**未提交 / 未建 PR / 未合并**，待管理者验收；[Issue #47](https://github.com/huxiaoyang-code/youshu-fork/issues/47)，基线（源码）`1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`，分支 `codex/huxiaoyang-code/local-02`；**税局现场仍暂停、真实接入仍 0**，本条不涉及税局能力。
- 新增[金额 / 期末 / 连续期间契约](ACCOUNTING-PERIOD-INTEGRITY.md)、[任务单](tasks/LOCAL-02.md)、[交接](handoffs/LOCAL-02.md)。
- 新增 `06-workbench/server/money.mjs`：人民币**分精度**（内部 BigInt 整数分）+ 唯一 `ROUND_HALF_UP` 舍入；上限按完整原值判定（`999999999999.994` / `999999999999.9900000001` 拒绝）；极小负数（含 `-1e-10` / `-0.000…1`）拒绝、极小正数带 `subCent` 标记不静默归 0；存续金额（累计余额、补项累计）不受单笔上限约束；输出合计不能保分即 `money_total_not_representable`，不静默丢一分。
- 新增 `06-workbench/server/period-end-controls.mjs`：七步期末检查（草稿 / 试算平衡 / 应计提 / 卡片与总账核对 / 损益结转 / 年末结转 / 连续期间顺序，每步给 `ok` / `blocked` / `not_applicable` 与理由）、封账前置断言、前期可改性守卫、卡片期间状态（按被查询期间计算累计，另给全局参考值）与卡片/总账核对。连续期间不只按凭证：零凭证但应计提的更早期间报 `previous_period_depreciation_pending`，真正无适用业务的空期仍可跳过。
- `accounting.mjs`：凭证 / 期初 / 导入 / 资产 / 折旧 / 结转 / 余额 / 报表全部改整数分；折旧按分期表在寿命内恰好提足（`100 / 3 = 33.33 + 33.33 + 33.34`，不再把尾差推到寿命外），极小金额前期 `no_amount_due`；结转失效检测（`carryforward_stale`），不再按「曾经执行过」放行；封账同时校验草稿、试算、计提、卡片/总账、损益/年末结转与连续期间顺序。
- 反操作守卫覆盖新建 / 过账 / 反过账 / 删除 / 反结账 / 计提 / 结转 / 增量导入与资产卡片维护：更晚期间已封账给 `later_period_closed`（含倒序反结账顺序），更晚期间已过账年末结转给 `later_year_end_carryforward_depends_on_period`；普通损益结转读累计余额，因此更晚已过账普通结转 / 计提同样构成依赖（`later_profit_carryforward_depends_on_period` / `later_depreciation_depends_on_period`）；卡片事实影响已封账期间或已有已过账计提时给 `asset_card_affects_closed_period` / `asset_card_locked_by_posted_runs`（纯显示信息可改）。全部先判定后写库，拒绝时库不变。
- schema **v4**（`import-storage.mjs`）：`asset_cards` 只加 5 列（`acquired_period` / `opening_accumulated` / `ledger_status` / `ledger_note` / `origin`），沿用「先备份、后建结构、事务回滚、版本记录」；缺取得期间是显式缺项（不回落 `start_period`），经 `asset_update` 补登记可解除；「尚未入固定资产账」需显式登记并写原因，但登记本身不是原值入账证据：仍报原值差异、不得计提（`asset_ledger_pending`），需真实补录购入 / 期初入账后改回 `booked`。
- 接线：`server.mjs`（`GET /api/account-sets/:id/period-end-check`、`PATCH /api/account-sets/:id/assets/:assetId`、守卫错误码 → 409）、`agent-tools.mjs`（`period_end_check` / `asset_update`）、MCP `tools.mjs`（同两个工具，`origin: local`）。
- 测试（全合成临时库 + 随机回环端口，不连旧后端 / 真实账套 / 税局）：**最终代码**新增领域 **43 / 43**、HTTP + Agent **17 / 17**、MCP **5 / 5**；`npm test` **50 / 50 套 exit 0**（实跑）；**旧候选的 50 / 50 与 38 / 13 / 4 不能代表最终通过**（见下条 review2）。既有套件只补真实业务事实（封账前结转、卡片取得期间 / 期初已入账固定资产），金额与失败原子性断言保留；`accounting-derived` 的折旧尾差期望按新舍入规则更新并附独立手算。
- 管理者实施中提前复现的四类金额边界已修复并补独立回归：9 位标度截断导致的极小值 / 超界原值误收、合计转 Number 丢一分、单笔上限误加给存续金额、资产取得期间静默回落与期间口径累计被后期污染。
- 独立合成预审 F1–F4 与历史状态残留已逐项修复并补定向回归：资产卡片写入口已封账 / 已过账守卫（F1）、普通后期损益结转与计提的前期依赖拒绝（F2）、零凭证但应计提期间不得跳过封账（F3）、`pending_purchase_voucher` 不再豁免原值差异与计提（F4）、历史状态与应提额不受未来 run 污染且执行时另设总额守卫。
- 限制与下游：双准则 / 辅助核算（LOCAL-03）、复杂现金流与导出（LOCAL-05a / 05b）、完整审计与业务备份（LOCAL-06）、批量任务与 CLI（LOCAL-07）不在本包；`report-export.mjs` 未改写；空月份不自动登记，倒序反结账规则已写入契约。
- 最终独审 review2（`fork_turns=none`）四项阻塞已逐项修复并补先红后绿定向回归：① 反过账后改寿命 / 原值 / 残值 / 起提 / 取得 / 期初累计 / 账簿状态 / 科目再重过账旧草稿一律拒绝（`depreciation_run_stale`，含分录科目校验；期末检查 / 计提入口同一口径，`posted_stale` 不再按「已过账」放行；名称 / 备注不锁死）；② 凭证**逐金额字段**拒绝非零亚分数（`0.001` / `1e-7` / `0.0049` 不再静默存 0，`0.005 → 0.01` 等正常边界保留）；③ 未入账登记（`asset_purchase_voucher_pending`）只在取得期间之后的期间计入阻塞（缺取得期间仍保守报告），不放宽真实未入账旁路；④ 计提期数写入前验证 `1 ~ 1200` 整数（`useful_life_months_invalid` / `useful_life_months_out_of_range`，技术边界不冒充法定年限），分期取额改 O(1)（`evenSplitAmountCents` / `cardMoney(card).amountAt`，`splitEvenlyCents` 限展开上限），新增 / 修改的落库 + DTO 构造同一保存点、任何后续计算失败整体回滚。
- 修正 `import-storage.mjs` 中 `acquired_period` 迁移注释（原称「核对时回落 start_period」与实际「不回填、报 `asset_acquired_period_missing`」矛盾）；**迁移语义不变**，本轮回工未新增存储列（schema 仍 v4 同一 5 列），v3→v4 升级 / WAL 备份恢复 / 失败回滚验证保持。LOCAL-06 备份 CLI 尚未合并且当前只支持 v3，本轮不触碰。
- 状态：**实现与自测完成（含 review1 F1–F4 与 review2 P1–P4 定向返工），未提交 / 未建 PR / 未合并**；head / merge 与 root 最终审查结果由管理者后补，本条不预报。

### Added — 本机产品路线 LOCAL-01：增量导入与批次幂等（2026-10-22）

- 用户 2026-10-22 新指示允许本机产品方向工作（覆盖旧「暂停本地扩建」）；**税局现场仍暂停、真实接入仍 0**，本条不改变税局状态。
- 用户同日澄清：**一家企业只需要一个账套**，多企业批量处理对应多个账套；旧文档中「一企多账套」含义被覆盖，**一企多账簿 / `bookKey` 方向已撤回、从未实施、不得新增**。
- 新增[增量导入契约](LOCAL-IMPORT.md)、[任务单](tasks/LOCAL-01.md)、[交接](handoffs/LOCAL-01.md)与[八包总览](tasks/INDEPENDENT-PRODUCT-WORK.md)（按用户原任务单完整映射八包：LOCAL-05a 导出模块 #45 常规 16 项 / 7 个 PDF 共 31 页初验通过、超长字段边界返工中；LOCAL-08 输出边界 #44 独立模块 28 项已过独审但尚未实际接线；其余待开工；本包随后合并为 PR #46）。
- 新增 `06-workbench/server/import-incremental.mjs`：区分旧首次创建（`importAccountSet` 兼容不变、无身份认定）/ `mode=create`（有规范企业身份 + 批次首次建账）/ `mode=append`（指定同一企业账套追加）；规范 `source.enterpriseKey`（NFKC + trim，不按名称 / 大小写猜认）+ `batchId` + 来源凭证 ID + sha256 内容指纹；同批重试（含重启）幂等、跨批同来源凭证去重、内容修订 / 本批自身重复 / 业务字号冲突 / 身份不匹配 / 科目不兼容 / 封账 / 期初覆盖返回结构化冲突且不写入。
- 一企一账套：`import_enterprise_account_sets` 以 `enterprise_key` 主键 + `account_set_id` UNIQUE 在数据库层保证；同企业跨来源 `create` 返回 `enterprise_already_bound` 并引导 `mode=append` 到已有账套（不新建第二本）；同账套绑另一企业一律拒绝；新增来源证据需 `confirmNewBinding=true` 且身份一致。
- 来源凭证状态：本机反过账 / 修改 / 删除后，去重与回放返回 `source_voucher_voucher_unposted` / `_modified` / `_missing` 结构化冲突，不按来源指纹伪报完成；删除后来源登记保留（去掉 `vouchers` 外键）；`markBatchFailed` 不会覆写已完成批次。
- 第二轮独审修复：填空账套期初同批只读回放（核对库内实际期初，换批改期初 / 库内被改动仍拒绝）、自动取号在计划阶段统一预分配（预检所见 = 落库，同期间同字号不重号）、跨批去重逐张批次追踪（`import_batch_vouchers`，查询 / 回放 / 首调一致并指向既有凭证）。
- 最后定向返工（Issue #43）：`create` 同批回放也按 `batchRecord.account_set_id` 核验当前真实期初（合法 API 改期初后给 `batch_replay_state_incomplete`，首次正式执行仍合法，无期初批次不凭空要求快照）；`sourceTrace` 正式执行补齐 `action`，与批次查询 / 回放使用同一组逐张 DTO 字段，新建 / 纯去重 / 混合批次首调与查询全对象一致。
- 新增 `06-workbench/server/import-storage.mjs`：schema **v3**（7 张表，含 `import_enterprise_account_sets` 与 `import_batch_vouchers`）；**先备份、后建新结构**（备份保持迁移前结构）；迁移事务失败原库 schema / 业务不变；每次升级重新备份（失败重试也重新备份），不复用 `size>0` 的过期 / 损坏快照；v1 / v2 候选库可逐级升级并回填落库指纹与批次关联；回退方式已文档化：**恢复会回到备份（快照）时点，备份时点后新增业务会丢失，必须先保护现库 / 停写 / 恢复后核对；最小工具不冒充 LOCAL-06 全备份恢复完成**。
- 接线（只导入）：`db.mjs` 启动迁移、`server.mjs`（`POST /api/import/incremental`、`GET /api/import/batches/:id`）、`agent-tools.mjs`（`book_import_incremental` / `book_import_batch`）、MCP `tools.mjs`（同两个工具，`origin: local`）。旧 `importAccountSet` / `/api/import/account-set` / `legacy_book_import` 行为与返回结构不变。
- 测试（全合成临时库 + 随机回环端口，不连旧后端）：上一冻结候选领域 46 / 46、HTTP + Agent 21 / 21、MCP 7 / 7，`import-strict` 54 / 54、`voucher-amount-guards` 103 / 103、`npm test` **47 / 47 套 exit 0**；最终代码（精确 head `e12e71e`）只实跑领域 **49 / 49**、HTTP + Agent **22 / 22**、MCP **7 / 7**，均 exit 0（管理者与独立审查者分别实跑），**未再重跑全套 47 套**，不写「最终小修后 47 / 47 又跑过」。
- 验收与合并（已完成）：基线 `0c4e0dd` → 已审 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7` → [PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 于北京时间 **2026-10-22 17:13:24** 实际 MERGED → merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`，管理者 fetch 核实 merge 完整树与已审 head 完全一致。独立审查（未参与实现、`fork_turns=none`、未读员工日志）无剩余阻塞；独立合成复现期初合法改动后回放冲突且零写入、首调 / 查询 / 回放 trace 全对象相等、auto + explicit `[2, 1]` 不重号。仓库**无 CI**，不冒充 GitHub 第二账号批准。
- 前端、`report-export.mjs`、`tax-report-format.mjs`、`public/*`、`package.json` 与税局模块未改；限制照旧：旧无企业 ID 导入入口身份未验证 / 不能自动识别唯一企业；追加需随 `payload.accounts` 声明自定义科目；迁移前 WAL 一致备份**不等于**完整 LOCAL-06 恢复系统；税局真实接入仍 0，本包未碰真实现场。其余包未因本包合并标为完成。

### Added — 税局数据与往期文件探索（2026-10-20 启动，2026-10-21 更新）

- [PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40) 已创建、开放候审；用户今日停止探索，仅收尾交接。代码已独审，当前文档待最终 head 审查，未合并。

- 新增[探索契约 / 接口目录](TAX-DOWNLOAD-EXPLORATION.md)、[任务](tasks/TAX-DOWNLOAD-EXPLORATION.md)与[交接](handoffs/TAX-DOWNLOAD-EXPLORATION.md)，明确只探索网站取数与复用命令，不生成下一期账套。
- 本机管理员页面探索 CLI 只接 source 引用和固定目标；菜单隔离读取、精确只读标签、两读同原 URL、被动主 frame 取证，全部资料 quarantine / 不可消费。未知 TTL 不当登录失效事实，不授业务 API 权限。
- 实际 GET `getCwbbzlList` / POST `queryZlbscjb` 为 `observed_request_metadata`、HTTP 200。POST 七键全核 `Lrrqq / Lrrqz / ZlbsxlDm / Skssqq / Skssqz / PageNum / PageSize`，query 唯一 `_`；不猜 timestamp / nonce / 日期筛选语义。完整 prefix / 值只在本机模板，外发审批拒绝、未执行不重试；正文 / 新财报独立 replay 0。
- 新增本机快照窄 CLI 文档与测试入口；独审及 root 独立 38 项合成后实测 `live_observed_private_snapshot_partial`，3 份 / 1,326,340 字节 JS 直接 ACL 私有保存、另 1 份预算跳过，无锁 / 清理确认，仅安全摘要。helper HTTP 0 不证明网页后台静默；快照不算财报下载。静态有限词表增加本轮已核技术名与键，20 / 20 合成通过，未知 prefix / 名称 / 业务值继续抑制，不改变旧版本实际分析事实。
- 最新 shape 独审 / root 25 项通过后本机定位：组件 6,016B / 5,790 字符，唯一五键对象不全绑定实际七键；详情 `/zhcx/cwbbxxcxxq` 仅静态候选。query 是 CallExpression 动态构造依赖，queryFieldSchema 空 / complete false，不能推断 token 键，非导航模板。parameter_property 仅语法关联，非完整运行时数据流 / 企业行映射；纯 shape 不是下载命令。
- 被动财报 CLI 固定 Page.reload({})，准确字节独审 / root 42 项后实际 request 28 / matched 2 / bodySaved 1、57B、scopeSealed / cleanup true、无锁 / ownUnknown false；为本接口认证错误，非业务列表。用户确认手动刷新后浏览器仍登录，要求暂停财报：不等待重登、不再本分支重试、不作其他取数前置，不据此推企业财报适用规则。
- 最新 C81 opt-in bootstrap 经独审 / root 63 项后真实正常导航固定门户，sourceCreated / runCreated，fresh 3 attempted / settled / performed / complete、unknown false / 企业匹配，cleanup true / 无锁，确认当前登录有效；不恢复旧 history context。旧 bootstrap 39 项 not_live_run 仅旧版本事实。
- 发票入口实际 nav ACK 有 15 条 scripts / 认证 metadata、无已识别列表 query，不重放 getPublicKey。先四份私有 JS 后因 scope 不匹配重建当前快照：最新 7 / 9 份、4,034,109B、44 事件 / 35 拒绝 / 2 预算跳过、scope / cleanup true / 无锁；A16D 离线 7 sources + 38 focused functions、parse fail 0，原 JS 仅 ACL。
- invoice observer 准确字节独审 / root 37 项后，先两次未 armed（第二次固定 guard 为 TargetURLmatchesSnapshot false、FrameTree 未读），均零业务 / cleanup true / 无锁；重建当前快照后 120 秒 / 180 秒真实窗均 armed / scopeStable / 全 scope 布尔 true，事件 / metadata / bodies 0、cleanup true / 无锁，现全停。用户后续确认已手动查询无结果，空或报错未区分；不推点击在上述窗内，不确认官网无数据 / 接口坏 / 登录失效。今天按用户要求停止探索、仅收尾交接 PR；下次用户明确继续后才核作用域 + armed，再安排人工查询。
- 41 组首跑 40 组通过，旧 tax-browser-session-mcp lost-response 模拟子 Node 异常退出 3221226505；未改实现或测试，定向 4 / 4 通过，root 随后全 41 组重试 exit 0、41 / 41 全部通过；仅 static / contract-shape 两组 `--expose-internals`。本轮仅探索支撑候审，可先交 PR 审合、总目标继续；真实 query → 原件下载 → 后端 MCP fresh 复采仍未证，业务下载 / 新 repeat 0，不转企业补资料。

### Changed — 多人跨电脑协作与任务分配（2026-10-15，2026-10-16 更新状态）

- 用户明确确认多人协作方式：同事账号 `xiaoyihaishiaini`（个人私有仓库协作者）已**接受** write 邀请（邀请 ID `337920044`），管理者 2026-10-16 通过 GitHub API 实测 `permission = write`。负责人 `huxiaoyang-code` 负责税局登录与数据接入（RC-0 / RC-1 / RC-2a / RC-2b 及数据处理集成，协调 RC-3），同事负责两类报表口径核对与导出（RC-4 / RC-5）。**开发多人不等于产品多租户**：产品仍为本机单用户、可多账套批量。
- 已建立总任务 [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)（RC-A-LOGIN-DATA，assignee `huxiaoyang-code`）与 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)（RC-B-REPORTS，已实际绑定 assignee `xiaoyihaishiaini`），均 OPEN。子 PR 用 `Refs #13` / `Refs #14`，**不因 A0 / B0 完成就 Closes 总任务**；新子需求可另开 Issue 链接总任务。
- 新增 [团队协作协议](TEAM-COLLABORATION.md)（双层角色、权限、共享同步、交接契约、文件所有权矩阵、任务生命周期 / 认领、跨成员评审、凭据与数据边界，以及官方资料短摘要）、[成员入场包](handoffs/MEMBER-ONBOARDING.md)（可直接转发同事）、[任务看板](tasks/README.md)、[任务单模板](tasks/TEMPLATE.md)、[RC-A-LOGIN-DATA](tasks/RC-A-LOGIN-DATA.md)、[TEAM-HANDOFF 交接](handoffs/TEAM-HANDOFF.md)，以及 `.github/pull_request_template.md` 与 `.github/ISSUE_TEMPLATE/requirement.md`（**8 个新增**；`RC-B-REPORTS` 任务单不在此列——它是 PR #15 已有、本轮修改）。
- 修改 `AGENTS.md`、[项目章程](PROJECT-CHARTER.md)、[团队实施计划](TEAM-PLAN.md)、[报表闭环补全方案](REPORT-CLOSURE-PLAN.md)、[阶段状态](handoffs/STATE.md)、[新会话入口](handoffs/NEXT-SESSION.md)、[索引](INDEX.md)、[交接模板](handoffs/TEMPLATE.md)、[RC-B-REPORTS 任务单](tasks/RC-B-REPORTS.md) 与本文（**10 修改**，共 **18 文件**）；**新增「先识别自己成员与已分配任务」**，避免所有机器默认接 RC-0 导致重复派工。
- **2026-10-16 已接受（已核实）**：本轮团队协作文档已被管理者接受；同事 `xiaoyihaishiaini` 已接受 write 邀请，管理者经 GitHub API 实测 `permission = write`；总任务 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) 已实际绑定 assignee `xiaoyihaishiaini`（OPEN）。`docs/tasks/RC-B-REPORTS.md` 属 PR #15 已有任务单的本轮修改，**不是新增，也不新增任何 B 任务单**。
- **新任务**初始状态为**「已分配 / 待开工」**（不是「开发完成」）；但不使已有进展退回：**RC-B B0 / B1 已随 PR #15 交付，B2 继续推进**，A 的 RC-0 等仍为待开工。本轮本地员工**未代发 Issue**，总任务 Issue #13 / #14 已由管理者建立（#14 已绑定 assignee）。成员可在满足验收与整合约束后自动合并自己的 PR；本机 Codex 审查不冒充 GitHub 第二账号批准。
- 本轮**不新增 GitHub Actions / CODEOWNERS / 规则集，不声称已有 CI / 分支保护；未改任何远端设置；未改 `team-skills/`；未改业务代码 / 测试**。这是本轮实现范围，不是永久禁止后续经负责人授权的治理变更。
- 团队文档变更不要求员工重跑业务回归；**管理者已在本轮对新基线 `c2d5619` 独立复验 `npm test` 10 套 336 项、exit 0**（合成临时库，未读真实数据），见 [TEAM-HANDOFF 交接](handoffs/TEAM-HANDOFF.md)。

### Added — RC-B 内部报表导出与模板前置核验（PR #15，2026-10-15）

- 同事 PR [#15](https://github.com/huxiaoyang-code/youshu-fork/pull/15)（head `843cad08c0e42e0614459bbbfc77160eadf498ad`，代码验证提交 `b913409d420cdd1d8264ad0d64a474880604c90f`）合并入 main `c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0`；见 [RC-B 交接](handoffs/RC-B-REPORTS.md)。
- 新增五类内部 CSV 下载及同口径预览：三表、各科目余额表、按科目/期间追踪的明细账。区分期间期初、本月发生、本年累计、期末；只读已过账范围，封账可读，拒绝未登记期间及非法参数。中文 BOM、CSV 转义、公式注入防护、试算与现金流勾稽标志、数据完整性未核实和算法限制随文件输出。
- 新增 21 项独立金额验收，预先手算跨月/跨年、父子科目、结转/折旧及简单混合现金流的预期值，同时校验下载 CSV 关键行；覆盖草稿/反过账、年中启用、空账、异常请求、封账只读、账套隔离及非有限金额。旧断言不变；实际全套复验结果见 [交接](handoffs/RC-B-REPORTS.md)。
- 新增官方小企业报表法定结构参考及校验，实际电子税局上传模板未核实，因此 **B2 仍未完成**。三表算法继续沿用现有核心，复杂混合现金流、准则映射和来源完整性等 RC-3 / RC-6 工作尚需整合；不宣称整个报表闭环或税局申报文件已完成。详见 [导出说明](REPORT-EXPORT.md)、[税局格式研究](TAX-REPORT-FORMAT.md)。
- 本任务遵循用户本轮明确授权，由 Codex Subagent 实施、主 Codex review / 验证 / PR / 合并；不改其他成员长期执行规则。

### Changed — 报表闭环优先级与补全方案（2026-10-15）

- 用户明确最终交付为**报表闭环**（办税员账号登录 → 授权企业 / 账套 → 财务操作 → 出报表），且**两类报表都需要**：内部资产负债表 / 利润表 / 现金流量表 + 余额表 / 明细账，以及税局财务报表申报格式；前端展示次要。新增 [报表闭环补全方案](REPORT-CLOSURE-PLAN.md) 与 [REPORT-CLOSURE 交接](handoffs/REPORT-CLOSURE.md)，把现行排序从「IMPORT-IDEMPOTENCY 第一优先」切换为 **RC-0 ~ RC-6**（IMPORT-IDEMPOTENCY 并入 RC-2，泛用批量队列后排）。
- 更新 [项目章程](PROJECT-CHARTER.md)、[路线图](ROADMAP.md)（新增 P1.5 报表闭环里程碑）、[团队实施计划](TEAM-PLAN.md)、[阶段状态](handoffs/STATE.md)、[新会话入口](handoffs/NEXT-SESSION.md)，并同步本索引与本变更日志；已完成表补记 PR #11（IMPORT-STRICT 交接文档归档，`cc6e789`）。
- 首审返工修订：RC-0 拆「代码审查 / 合成验证」与「用户本机人工可行性」两步（原 tax-browser 只读保留，隔离工作区仅复制源码 / 补丁与基线快照，不复制 DB / 凭据 / 临时 profile / 日志；先复现旧草稿测试再在最新 main 复用必要改动）；RC-1 补实际账号 / 凭据入口、适配器与最少 UI（凭据与验证码只由用户本机输入；模型侧 MCP / Agent 仅收安全引用与不含真实业务 / 身份原文的状态摘要，本机 UI 专用回环通道可处理瞬时凭据 / OTP，不送模型）；RC-2 补目标账套定向导入、标准 DTO 转换、完整性与映射预检、稳定业务键与最小恢复能力；报表验收补独立预期金额 / 会计口径；范围弹性与未知源数据边界明确。
- 纯文档变更，未改业务代码、算法或测试，不重复整套 208 / 262 项回归。**整体不宣称报表闭环已达成**。
- 该方案已由 PR [#12](https://github.com/huxiaoyang-code/youshu-fork/pull/12) 合并入 main `8ebc73917123b7057dec7d00f28f5651b6fd8a4a`（2026-10-15，文档变更，未重跑业务测试）；后续团队协作交接以该 SHA 为基线。

### Changed — 方向修正为本机单用户批量 + 工作范式技能（2026-10-14）

- 明确产品为**本机单用户**工具，目标支持多个企业 / 账套的批量处理（批量队列与管理尚待开发）；删除 SaaS、多租户、租户权限平台方向，保留账套隔离、操作日志、备份恢复、凭据安全等本机实际需要。涉及 `AGENTS.md`、PROJECT-CHARTER、TEAM-PLAN、ROADMAP、INDEX、CONVENTIONS 及 README。
- 新增仓库权威技能 `team-skills/local-agent-first/SKILL.md`（含 `references/windows-launch.md`）：本地 pi / Claude Code 实施，Codex 只派工、审查、Git/PR 与合并；模型仍锁定 GLM 5.3 / DeepSeek V4.1 Flash。员工维护仓库副本，Codex 全局技能由管理者审查后安装；不直接修改用户全局技能与 Codex 配置。本机安装与校验结果见 [新会话入口](handoffs/NEXT-SESSION.md)。
- 新增 [新会话入口](handoffs/NEXT-SESSION.md) 并更新 [阶段状态](handoffs/STATE.md)：固定“每部分验收+合并+交接后关闭员工会话、下一部分新进程新会话”的交接方式。
- 分支前缀统一为 `codex/`；原站 `catalog.json` 保持冻结，本地能力改在 `agent-tools.mjs` / `tools.mjs` / `tax-tools.mjs` 维护。
- 纯文档与 Skill 变更，未改业务代码或算法，不重复整套 208 项回归。

### Added / Fixed — 第一期可靠性与本机 Agent 接入（2026-10-13）

- MCP 补齐账套、科目、期初、期间、凭证状态、查账、资产、折旧和结转入口；工具/查询目录如实说明可用状态，未实现不再伪报成功，导入默认预检。
- 封账后的反过账/删除受保护；期初按完整合并结果校验平衡并原子写入，已有正式账务后禁止重写；合法新期间可登记。
- 明细科目参与报表和总账归集；零利润/反向损益/年末结转可用，失败回滚；折旧删除同步清理计提记录，恢复旧凭证不能超额折旧。
- 预留全国电子税务局 7 个接口，按地区选择适配器，验证异步登录状态、会话隔离、过期/退出和输出脱敏。当前真实接入地区为 0。
- 补齐记账及旧账导入规则，新增临时账套的完整 MCP 闭环验收和统一 `npm test` 入口。
- 新增项目章程、`AGENTS.md` 和阶段交接：每部分验收合并后归档，下一部分以全新本地员工会话执行。
- 验收命令、结果及限制见 [第一期验收](PHASE1-ACCEPTANCE.md)，PR 与阶段状态见 [交接](handoffs/STATE.md)。

### Added — 逆向分析：账套导入
- 新增主题报告 [`04-report/10-account-set-import.md`](../04-report/10-account-set-import.md)：
  `page=account-sets` 的导入实现（建账向导“期初旧账/旧账文件” + `legacy-book-import` 子智能体）
- 新增证据 [`03-analysis/account-set-import.json`](../03-analysis/account-set-import.json)：向导字段/默认值/接口契约/附件管道/状态机
- 归档实时复核 bundle `02-scripts/work/index-CiSnIgwe.js`（sha256 `691cf9c2…`），与旧版 `index-yoSd2Nx7.js` 行为一致
- 关键结论：向导中的 `openingBalanceFile` 被提交前丢弃，`createAccountSet` 零调用；导入由 Agent 附件管道完成

### Added — 本地复现「导入旧账」（Codex 客户端）
- `finance-mcp` 修复 Windows 下 `skills_read` 路径误判（正/反斜杠）
- `legacy_book_import` 新增 `paths` 参数：MCP Server 直接读本地 CSV，免 base64
- 新增 `codex/mcp/finance-mcp/import-demo.mjs`：读规则 → 预检 → 导入 → 报表勾稽 一条龙演示
- 新增 `examples/legacy-book/` 示例旧账（4 张 CSV）与 `tools/xlsx-to-csv.py`（openpyxl，Excel → CSV）
- `codex/README.md` 新增「本地复现：导入旧账」步骤（工作台 + MCP + Codex 提示词）

### Planned
- 报表闭环工作包 RC-1 ~ RC-6（见 [报表闭环补全方案](REPORT-CLOSURE-PLAN.md)）
- 辅助核算（客户/供应商/部门/项目）
- 银行流水对账
- 打印/导出（PDF/Excel）
- 发票 / 申报工具对接

---

## [0.4.0] - 2026-10-12

### Added — 导入旧账
- **导入账套**：一次导入「账套信息 + 科目 + 期初余额 + 历史凭证」
  - `parseImportTexts()`：解析 4 张 CSV（账套/科目/期初余额/凭证），支持 GBK/GB18030 中文 Excel 导出
  - `validateImportPayload()`：借贷不平、科目不存在、类别/方向非法均显著报错
  - `importAccountSet(payload, {dryRun})`：先预检后落库，**事务包表失败回滚**
  - 支持新增非标准科目（如企业会计准则 6602）
- API：`POST /api/import/parse`、`POST /api/import/account-set`、`GET /api/import/templates`
- Agent 工具：`legacy_book_import`（默认 `dryRun=true` 仅预检），对应原子智能体 `legacy-book-import`
- 网页：顶部「↓ 导入账套」（JSON 或 4 CSV + 编码选择 + 预检结果 + 下载模板）

### Fixed
- 利润表改为按**科目名称/编码尾号**归集（兼容小企业 5xxx 与企业准则 6xxx），
  修复导入的非标准损益科目不计入利润表的问题；未匹配的损益科目归入「其他收入/其他费用」

### Tests
- 端到端测试 22 → **28 例**（新增 CSV 解析/预检、期初不平、科目不存在、事务导入、导入后报表）

---

## [0.3.0] - 2026-10-12

### Added — P1 会计闭环
- **期末结转损益** `carryForwardProfit(setId, period, {yearEnd})`
  - 各损益科目余额结转到 `3103 本年利润`，`yearEnd=true` 再结转 `3103 → 3104`
  - 结转凭证 `kind='carryforward'`，**不计入利润表发生额**，避免重复计算
  - 同期重复结转被拒绝（`already_carried_forward`）
- **固定资产折旧 / 无形资产摊销**
  - 新增资产卡片表 `asset_cards`（直线法、残值率、使用月数、起提期间、费用科目）
  - `generateDepreciation(setId, period)`：一键计提、生成凭证、记录 `asset_depreciation_runs`
  - 同期幂等；提足/未到计提期自动跳过
- **现金流量表** `cashFlowStatement(setId, period)`
  - 直接法（按货币资金对方科目分类为经营/投资/筹资）+ 与货币资金变动勾稽
  - 附「净利润 → 经营活动净额」的**间接法补充资料**
- 凭证新增 `kind` 字段（`normal` / `carryforward` / `depreciation`），含老库自动迁移
- 网页新增「资产」页签、现金流量表、「结转本期损益」按钮
- Agent 工具新增：`carry_forward_profit`、`asset_list`、`asset_create`、`depreciation_run`；
  `finance_query` 的 `report.cash_flow_statement` 改为真实实现
- 端到端测试扩到 **22 例**（新增折旧、结转、现金流量表、勾稽等），全部通过

### Changed
- 资产负债表「未分配利润」= `3104 + 3103 + 尚未结转的本年损益`（兼容已结转/未结转两种状态）

---

## [0.2.0] - 2026-10-12

### Added
- **`06-workbench/` 记账 + 报表 MVP**（可运行）
  - 后端：Node + `node:sqlite`，零第三方依赖
  - 账套 / 标准科目表（小企业会计准则）/ 期初余额 / 期间结账
  - 凭证：多分录、借贷平衡校验、草稿 / 过账 / 反过账 / 删除
  - 报表：科目余额表（试算平衡）、资产负债表、利润表、明细账
  - 前端零构建网页（`public/`）
  - 端到端测试 `test/smoke.test.mjs`（11 用例，全部通过）
- **Codex / MCP 打通**：`/agent/tools/:name` 接口，`finance-mcp` 默认指向工作台
- **`docs/` 代码管理索引目录**：`INDEX.md`、`CONVENTIONS.md`、`CHANGELOG.md`、`ROADMAP.md`
- 根 `README.md` 项目落地页；`.gitignore` / `.gitattributes` / `.editorconfig`

### Fixed
- 资产负债表中「本年利润」方向错误导致资产 ≠ 负债 + 权益
  （改为 `本年利润 = −Σ(损益类 net)`）
- 静态资源根路径 `/` 返回 404（Windows 路径分隔符问题）

---

## [0.1.0] - 2026-10-12

### Added
- **REA 逆向分析归档**
  - 目标更正：`daizhang.youshu.yuork`（不存在）→ `daizhang.youshu.yun`
  - `00-recon/` 侦察证据；`01-capture/` 被动抓取与截图
  - `02-scripts/` 前端脚本（`work` 工作台、`finance` 登录）
  - `03-analysis/` REA 原始证据：应用图、接口、路由、分包、WebMCP
  - `04-report/` 主题报告 01–09 + `build_report.py`
  - `REPORT.md` 分析总索引与证据台账（8 个 Evidence ID）
- **`05-reconstruction/` 复刻方案**
  - 关键发现：`/work` 财税工作台是 **OpenAI Codex app-server 客户端**
  - `catalog.json`：5 子智能体 / 22 工具 / 21 查询能力 / 21 技能文件 / 协议
  - `codex/`：`config.toml`、MCP Server 骨架（22 工具）、5 份 SKILL.md 模板
  - `extract_catalog.py`、`generate_skill_stubs.py` 可复现脚本

[Unreleased]: #unreleased
[0.4.0]: #040---2026-10-12
[0.3.0]: #030---2026-10-12
[0.2.0]: #020---2026-10-12
[0.1.0]: #010---2026-10-12
