> **2026-10-23 LOCAL03 最终整合候选（未提交 / 未 PR / 未合并）**：负责人 `huxiaoyang-code`，输入 `502640906262d6eefbe81b3460361e74ea0811b5`，分支 `codex/huxiaoyang-code/local-03a`。双准则持久 profile / core3、4、5 × bank0、1严格备份、五类内部 CSV/XLSX/PDF、固定模型投影、显式一企一套全入口均已实施；原 main65 注册逐字原序保留并末尾追加8套，共73套。实施者实际完整73套为71/73、1907/1909项、exit1；仅两旧税务MCP建账fixture漏enterprise，按Issue56精确扩窗修后定点59/59+2/2均exit0，原完整红例保留，不能改称最终hash全73已通过。JSON/CSV UI 上传/预检经root受支持工具尝试仍因工具超时未受控而结果未知，暂不继续该工具流程；最终独立全套、fresh独审、PR合并未发生。LOCAL01全入口、LOCAL03辅助Issue64、LOCAL05整体不因本检查点完成；LOCAL06审计/现库恢复/Windows W2及LOCAL07 whole batch仍未完成，税局暂停、真实接入0。详见 LOCAL03a / LOCAL01B 当前任务与交接。

### 2026-10-23 独审 P2 修复后的验证边界

新增明细科目的严格归一化现调用 `addAccount` 同源 `accountProfileSemantics`，按新建选定或目标持久 profile 拒绝 `account_semantics_conflict`；已有标准科目兼容与旧成功批次指纹规则保持。修后实际命令（cwd `06-workbench`）：`node --check server/accounting.mjs` exit 0；`node test/accounting-standards.test.mjs` 38/38、`node test/import-incremental.test.mjs` 57/57、`node test/import-strict.test.mjs` 54/54、`node test/accounting-standards-http.test.mjs` 2/2、`node ../05-reconstruction/codex/mcp/finance-mcp/accounting-standards-test.mjs` 2/2，全部 exit 0，自有直接 child 均已 close。双 profile 的 legacy / incremental create / append 错类别和方向均静态拒绝、业务及批次 / 来源全表零写；合法同根明细独立金额及 completed 批次 ID / 指纹只读重放通过。

此前管理者在修前候选执行完整入口 `node scripts/test-all.mjs`，73/73 套各 exit 0，入口实际 exit 0、child close，候选 76 文件 hash 前后相同。这是修前真实历史；本 P2 修后完整 73 套与最终 fresh 审查仍待管理者执行，不能以旧完整结果替代。更早实施者 71/73、两税务定点 61 项也仍是历史证据。

UI JSON / CSV 文件导入两次 filechooser 工具超时；用户已授权 CDP 合成输入，但工具明确不支持 raw CDP，实操仍未知，不能记为通过。所有本轮自有 UI 服务均已结束，不再启动浏览器重试；领域 / HTTP / MCP 通过不替代 UI 实操。内部简化报表子集、来源完整性 `unverified`、真实税局接入 0、辅助维度与 LOCAL06 / 07 未完边界保持。


下方为各原日期的历史阶段记录；本候选不改写已合 PR 事实，也不把旧测试数当本轮结果。

> **2026-10-23 出版窗口当前事实（优先于下方历史快照）**：负责人 `huxiaoyang-code`。整包完成 **LOCAL02与LOCAL08，共2/8**。LOCAL08 [PR #66](https://github.com/huxiaoyang-code/youshu-fork/pull/66) 于 2026-10-23T04:33:39Z 已合并：已审 head `9f7817f889ff6d2fa985dc343611ef965a4dcd8b`，main merge `2b3639e5ec80468f9e5acb0b886546f22dc5ada6`，tree `0c5bad9ccbdc8e46275252da0f8a2a464ae4d51e` 一致。root 该 head 完整 **61/61 套 exit0**，含 Office21/21 与11 PDF geometry / Poppler；fresh独审全部定向suite及17 probe接受，Issue44已 CLOSED（completed）。后续03新profile输出适配属03后续窗口。
>
> LOCAL07 B1 [PR65](https://github.com/huxiaoyang-code/youshu-fork/pull/65) 已合（已审head `37bcb286041f76d85c01ff5f6078727497570425`，merge `97384868ca1cb7a3f07bf561fedac666c7674eb3`），W3现库安装 / 共享互斥与W4恢复分叉未完。银行源修复候选冻结为 `a38b2815d353c1f5749c5c3081ec6bdbd180ace0`，员工定向150/150 exit0（import16 / reconciliation43 / CLI14 / integration5 / backup22 / 07 persistence39 / CLI11），root源修复定向43/43+14/14 exit0。本窗口以实际main原61逐字原序保留，仅末尾追加银行4套，静态登记65；**最终全65、fresh独审与PR63合并仍待root，PR63仍Draft**。只是LOCAL04银行CLI组件候选，profile / 辅助实际入口与UI整合未完。
>
> 未完成项：LOCAL01 Issue61一企一套全入口；LOCAL03 R3窄修已接受，但 `accountRows` 漏 `contra` 的P2 / B2 / v5严格备份 / 全入口未完，辅助Issue64已登记未实施；LOCAL05a Office接线PR62已合、05b双准则 / 复杂现金流及独立金额核验未完；LOCAL06审计B2业务接线 / 现库安装、真实restore和Windows最终交付未完。税局专项暂停、真实接入0，总任务20/13/14等继续开放。

> **2026-10-23 最小恢复入口（优先于下方历史快照）**：先读 [章程新增授权](../PROJECT-CHARTER.md)、[STATE 当前八包状态](STATE.md)、[任务看板](../tasks/README.md) 和本人精确任务单。成员 `huxiaoyang-code`；只有02整包完成，其余子包与剩余工作详见STATE。07 B1 [PR65](https://github.com/huxiaoyang-code/youshu-fork/pull/65) 已合（已审head `37bcb286041f76d85c01ff5f6078727497570425`，merge `97384868ca1cb7a3f07bf561fedac666c7674eb3`），W3/W4仍未完。08 [当前31文件整合窗口](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6357299894) 入口静态61，最终全61、fresh独审及PR合并待root；原24候选8套131/131仅为先前证据。银行PR63仍Draft、调用方P1未修，Issue64新辅助已登记未实施。
>
> 本项目用户已授权火山路由 `ark.cn-beijing.volces.com` 接收必要源码 / 任务 / 合成错误，仍限核实GLM5.3或DeepSeek V4.1 Flash、主回退锁定。pi / Claude优先；额度不足时root统一**一个**兜底实施subagent，root仍只管理 / 验证 / Git。最终必须由未参与实现且不继承实施上下文的fresh审查者接受后按授权自动合并；不改全局Skill、不外推其他成员 / 项目。真实账套 / 凭据禁止外发；不复制配置 / 会话。税局专项暂停，真实接入0；总任务20/13/14等不随子包关闭。

> **2026-10-22 合并后兼容整合：LOCAL-06 备份 / 验证 / 恢复适配精确 v3 + v4 · [契约](../LOCAL-BACKUP.md) · [任务](../tasks/LOCAL-06-BACKUP.md) · [交接](LOCAL-06-BACKUP.md)**。备份子包已随 [PR #55](https://github.com/huxiaoyang-code/youshu-fork/pull/55) 合入（merge `98977e0`，已审源码 head `b2dcba3`），但当时严格只认 v3；LOCAL-02 已把产品推到 v4。本轮（root 派工，在 LOCAL-02 worktree）只改备份自有 3 个文件 + 仅追加的 `scripts/test-all.mjs` 登记：`SUPPORTED_SCHEMA_VERSIONS = [3, 4]` 两份独立结构契约（差异仅 `asset_cards`，v4 5 列按真实 `ALTER TABLE` 的默认值 / NOT NULL / 类型逐字校验）；v3 旧备份只读 `verify` + `restore-new` 到全新目录成功且**不迁移备份 / 源库**，只有产品入口显式打开才升 v4（实际差异：5 列按默认值落库、旧卡片报 `asset_acquired_period_missing` / `asset_accumulated_mismatch`）；v4 用真实产品合成库（资产补项 + 期初累计 + 连续两期计提与总账 + 真实封账 + 导入批次来源）实际 `backup → verify → restore-new` 并用真实入口读取与继续记账 / 计提；只抬版本号、缺列、错默认值 / NOT NULL / 类型、迁移记录不连续、未知组件表、未来 v5+、重算清单摘要的伪兼容全部拒绝。测试：备份套件 **20 / 20 exit 0**；`npm test` **53 / 53 套 exit 0**（备份套件 + 已合入 `finance-output-policy` 28 / 28 + `report-office-export` 21 / 21 仅追加登记，原 50 套顺序不变；Office 真实 PDF 几何校验已生效）。状态：**实现与自测完成，未提交 / 未建 PR / 未合并**，最终独审待做。**备份仍未支持**：v0 / v1 / v2 旧库、未来 v5+、bank / batch / audit 等未合入组件；原位恢复 / 审计 / Windows 交付仍未实现。**税局专项仍暂停、真实接入 0**。

> **2026-10-22 当前（本机产品路线）：LOCAL-02 会计金额、期末完整性与连续期间 · [任务](../tasks/LOCAL-02.md) · [契约](../ACCOUNTING-PERIOD-INTEGRITY.md) · [交接](LOCAL-02.md) · [八包总览](../tasks/INDEPENDENT-PRODUCT-WORK.md)**。用户 2026-10-22 指示允许本机产品方向工作，覆盖旧「暂停本地扩建」；**税局现场仍暂停、真实接入仍 0**，本条不改写税局状态。负责人 `huxiaoyang-code`（已核实），Refs #20 / #13 / #14，Issue #47，基线（源码）`1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（工作区已由管理者快进到 `94a79ef` = LOCAL-01 交接文档，源码无变化），分支 `codex/huxiaoyang-code/local-02`；head / merge 待管理者后补。交付：`money.mjs`（分精度 + 唯一 ROUND_HALF_UP；上限按完整原值判定；极小负数 / 正数不静默归 0；存续金额不受单笔上限约束；不可保分合计显式拒绝）、`period-end-controls.mjs`（七步期末检查 / 封账前置 / 前期可改性守卫 / 卡片期间状态 + 卡片与总账核对）；`accounting.mjs` 全金额路径改整数分、折旧分期表在寿命内恰好提足、期间口径累计不被后期污染、结转失效检测；schema **v4**（`asset_cards` 加 `acquired_period` / `opening_accumulated` / `ledger_status` / `ledger_note` / `origin`，先备份后建结构）；HTTP `GET …/period-end-check`、`PATCH …/assets/:assetId` 与 Agent / MCP `period_end_check` / `asset_update` 实际可查可操作；更晚期间已封账、或已过账派生凭证（年末结转 / 普通损益结转 / 计提）时，所有写入口（含增量导入）与资产卡片事实维护一致拒绝并给撤销顺序；未入账登记不豁免原值核对也不得计提。测试口径：**最终代码**实跑 `npm test` **50 / 50 套 exit 0**（本包新增领域 **45 / 45**、HTTP+Agent **18 / 18**、MCP **5 / 5**；全部合成临时库 + 随机回环端口）。**旧候选的 50 / 50 与 38 / 13 / 4 不代表最终通过**：最终独审（`fork_turns=none`，即 review2）实测四个阻塞（旧折旧草稿重过账仍按原金额过账、凭证亚分金额静默存 0、未入账登记未按取得期间过滤、巨大寿命先落库后 DTO 抛错）已逐项修复并补先红后绿回归（`depreciation_run_stale` / 亚分拒绝 / `exists` 过滤 / 寿命 1~1200 + O(1) 分期 + 写入回滚）；review3 又补一项同影响面 P2（取得期间晚于计提期时，生成分支与校验分支两套口径矛盾，造成「删了又生成 → 立即 stale」循环），已统一复用 `expectedDepreciationCents`：取得期间之前的期间状态 `not_existed`、不写凭证、不阻塞，旧已过账计提仍如实报 `depreciation_run_stale` 并可撤销重算。状态：**实现与自测完成（含 review1 F1–F4、review2 P1–P4 与 review3 取得期间一致性 P2 定向返工），未提交 / 未建 PR / 未合并，待管理者验收与 root 最终审查**。恢复只需读本交接 + 契约 + `06-workbench/server/{money,period-end-controls,accounting}.mjs`。LOCAL-03 / 04 / 05b / 06 / 07 待开工；**税局专项仍暂停、真实接入 0**。下方旧入口按历史阅读。

> **2026-10-22 前包已验收合并：[LOCAL-01 增量导入与批次幂等](../LOCAL-IMPORT.md)** · [任务](../tasks/LOCAL-01.md) · [交接](LOCAL-01.md) · [八包总览](../tasks/INDEPENDENT-PRODUCT-WORK.md)。用户 2026-10-22 指示允许本机产品方向工作，覆盖旧「暂停本地扩建」；**税局现场仍暂停、真实接入仍 0**，本条不改写税局状态。负责人 `huxiaoyang-code`（已核实），Refs #20 / #13，Issue #43，基线 `0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`，实际分支 `codex/huxiaoyang-code/local-01`（此前误写为 `local-01-import-incremental`，已更正；已审 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7`，[PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 已实际 MERGED，merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`，北京时间 2026-10-22 17:13:24，管理者 fetch 核实 merge 树 = 已审 head）。产品口径：**一家企业只需要一个账套**，多企业批量 = 多个账套；身份来自规范 `source.enterpriseKey`，同企业跨来源必须引导到已有账套（`enterprise_already_bound` + `mode=append`，不新建第二本），同账套不得绑另一企业，来源证据需 `confirmNewBinding=true` 且身份一致。三类用法：旧 `importAccountSet` 兼容不变（无身份认定）、`mode=create` 有企业 / 批次首次建账、`mode=append` 指定同一企业账套追加。同批重试幂等（含重启）、跨批同来源凭证去重；内容修订 / 本批自身重复 / 业务字号冲突 / 身份不匹配 / 科目不兼容 / 封账 / 期初覆盖全部结构化冲突且不写入；**凭证被本机反过账 / 修改 / 删除后**去重与回放给 `source_voucher_voucher_unposted` / `_modified` / `_missing` 冲突，不伪报完成，删除后登记保留；已完成批次不被失败审计覆写。第二轮独审修复：填空账套期初同批只读回放（库内期初不一致 / 换批改期初仍拒绝）、自动取号计划阶段统一预分配（预检所见 = 落库，同字号不重号）、跨批去重逐张批次追踪（`import_batch_vouchers`，查询 / 回放 / 首调一致，重启可恢复）。最后定向返工：`create` 同批回放也按批次记录账套核验当前真实期初（合法 API 改期初后给结构化冲突；首次正式执行仍合法、无期初批次不凭空要求快照），正式执行 / 批次查询 / 回放统一 `sourceTrace` 逐张 DTO 字段。单事务覆盖企业绑定 / 来源证据 / 批次 / 凭证 / 期间 / 科目，中途故障整体回滚。存储 schema **v3**：**先备份、后建新结构**（备份保持迁移前结构）；迁移事务失败原库 schema / 业务不变；每次升级重新备份（失败重试也重新备份），不复用过期 / 损坏快照；v1 / v2 候选库可逐级升级并回填落库指纹与批次关联，自相矛盾则迁移失败交人工核对；回退已文档化（**恢复会回到快照时点，备份时点后新增业务会丢失；需先保护现库 / 停写 / 恢复后核对，最小工具不冒充 LOCAL-06**）。测试口径分层：上一冻结候选（最终两处定向修复之前）全套 47 / 47 套 exit 0；最终代码（精确 head `e12e71e`）只实跑领域 49 / 49、HTTP+Agent 22 / 22、MCP 7 / 7，均 exit 0（管理者与独立审查者分别实跑；全合成临时库 + 随机回环端口），**最终代码未再重跑全套 47 套**。状态：**已验收合并**（PR #46 已 MERGED，merge `1a15bcce…`；独审未参与实现、`fork_turns=none`、未读员工日志，无剩余阻塞；仓库无 CI，不冒充第二账号批准）；八包按用户原任务单：LOCAL-05a 导出模块（#45）常规 16 项 / 7 个 PDF 共 31 页初验通过、超长字段边界返工中；LOCAL-08 输出边界（#44）独立模块 28 项已过独审但**尚未实际接线**（两者不冒称整体完成），LOCAL-03 / 04 / 05b / 06 / 07 待开工；**下一核心为 LOCAL-02 金额 / 期末完整性**；旧「暂停本地扩建」安排已由用户 2026-10-22 指示覆盖（仅限本机产品路线），**税局专项仍暂停、真实接入 0**。下方旧入口按历史阅读。

> **2026-10-21 新增：[TAX-EDGE-DOWNLOAD-FIX](../TAX-EDGE-DOWNLOAD-FIX.md)** · [任务](../tasks/TAX-EDGE-DOWNLOAD-FIX.md) · [交接](TAX-EDGE-DOWNLOAD-FIX.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #17，基线 `2bc05d3680b456ccecb7bf1a16b64107017114b1`，分支 `codex/huxiaoyang-code/tax-edge-download-fix`。用户确认同企业同条件下常用 Edge 能下载发票、旧后端专用 Edge 查询 / 下载失败；本机两者版本相同 `155.0.4283.62`，旧专用 `inprivate=true`、常用 `false`。按官方 `blockthirdpartycookies`（InPrivate 默认阻止第三方 Cookie）形成**可信兼容性假说，非实测税局根因**。仅改 4 文件：传输层移除 `--inprivate`，保留 ACL 独立临时 profile / loopback CDP / 清理；诊断层由强制 InPrivate 改为兼容旧 owned InPrivate / 新 owned normal，拒绝重复畸形 `inprivate` 与 guest / headless / unsafe，其余 owner / profile / 端口 / ACL 不放宽；两测试。员工 `browser-session` 46 + `diagnostic` 5 通过；管理者在当前冻结代码上**实际完整运行 `test-all` 44 / 44 套 exit 0**。真实验证：root 另开隔离后端（空白运行目录 / 随机 loopback 端口），新专用 Edge 已实际启动并核对 `normal=true` / 独立 profile / loopback / 同版本，旧四进程与用户原常用 Edge 保留未改；新窗口待用户人工登录后同条件复验，**当前不声明查询 / 下载成功**，不读凭据 / 业务原值入模型，端口 / PID / ref / 路径只入 ignored checkpoint 不入 Git。只读审查发现 observer 仅同 target / session + 主 frame / loader，新标签 / OOPIF 可能不可见；未实现 `downloadWillBegin` / `progress` 或文件接收、`downloadPerformed` 固定 false——列为后续技术待办，非企业补材料、非已证实失败原因，本 PR 不把模式修复冒充数据链打通。旧探索暂停已由用户「直接排查修复」授权恢复。状态：**代码 + 管理者回归完成，独立内容审查进行中，真实同条件下载待用户人工反馈，PR 尚未创建**（[PR #41](https://github.com/huxiaoyang-code/youshu-fork/pull/41) 已合并 `2bc05d3` 可作前置交接，不改其历史文档）。

# 新会话入口 · NEXT SESSION

> **2026-10-21 新增：[税局接口目录](../TAX-API-CATALOG.md)** · [任务](../tasks/TAX-API-CATALOG.md) · [交接](TAX-API-CATALOG.md)。现成报告明确列举的接口已整理成 29 模块 / 131 条结构化目录，可检索 / 分页 / 详情 / 参数校验 / 调用准备，并附统一结果分类器。只读合同：未连接税局、无真实适配器，本包 `liveCallVerified` 0；完整可调用契约 0 条（缺响应 / 企业 / 权限前置条件）。登录与写接口一律 `blocked_by_policy`。初审问题已逐项修复（已载明参数键 20 / 推断 1 / 声明 21，推断不计入已载明）。测试时序：管理者较早一次全量 `node scripts/test-all.mjs` 为 **exit 0、44 / 44 套**（基线，当时目录单测 31 项）；随后独审发现分类器把空结果族业务码与 HTTP 401/403/500 误判为 `business_empty`，员工定向修为 `structure_unrecognized`（不重试、全局仍 `unknown`，`empty` + 2xx 保留正常），目录单测 31 → 32；主审已再次实际运行受影响三套：**目录 32 / HTTP 10 / MCP 5 全部 exit 0**。小修后只改分类器与该三套测试，**未再重跑全 44 套**，不得声称最终代码上 44/44 重通过。状态：**实现 / 管理者回归完成，待最终 head 审查与 PR 合并；合并结果以对应 PR 与 Git 为准**（当前未提交 / 未建 PR / 未合并，不预报成功）；代码审查证据与合并证据分开登记，最终 head 审查仍在进行，合并证据待 PR 后登记。本次交接更新只用 pi / tokenhub DeepSeek V4.1 Flash 改文档，旧采集暂停、旧现场保留。恢复只需读交接 + 契约 + `06-workbench/server/tax-api-catalog*.mjs`。下方旧入口按历史阅读。

> **2026-10-21 先读：[下载探索](../TAX-DOWNLOAD-EXPLORATION.md)** · [任务](../tasks/TAX-DOWNLOAD-EXPLORATION.md) · [交接 / 命令](TAX-DOWNLOAD-EXPLORATION.md)。本轮仅完成查询 / 下载探索支撑候审。财报按用户要求暂停；新门户 fresh 3 / 企业匹配已实测，发票已正常跳转，但只有脚本 / 认证 metadata，未识别列表 query。最新私有 snapshot 7 / 9 份、4,034,109B；observer 已独审 + root 37 项，120s / 180s 两个真实窗均 armed / scopeStable / 全 scope 布尔 true，事件 / metadata / bodies 0、cleanup true / 无锁，窗口现全停。用户已手动查询无结果，空或报错未区分，不推点击在记录窗内，不确认官网无数据 / 接口坏 / 登录失效。今天停止探索、仅收尾交接 PR，不请求 / 重开窗；下次须用户明确继续，再核 scope / snapshot + armed 后人工查询。41 组首跑 40 过、旧 MCP lost-response 模拟子 Node 异常，无改定向 4 / 4 过；root 随后全 41 组重试 exit 0、41 / 41 全过；本轮支撑交付冻结候审，[PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40) 已创建、开放候审；代码已独审，用户今日停止事实的文档仍待最终 head 审查。 当前无监听，不让用户直接点；可交支撑 PR，总目标继续，内部待办 query → 下载 → backend MCP fresh 复采，不转企业补资料，不自动点击 / 重启。下方历史保留原日期。

> **2026-10-20 先读：[历史查询子包](../TAX-HISTORY-COLLECTION.md)** · [任务](../tasks/TAX-HISTORY-COLLECTION.md) · [交接 / 下一任务提示词](TAX-HISTORY-COLLECTION.md)。用户已登录完成，新链已建，固定查询两轮现有 MCP 实际复采与比较通过（各 3 fresh / 3 complete，6 行 / 2 期间，unknown 0，无保留锁）；只证明捕获固定查询范围。代码 `d0fdbce47b48164d67584c8cfa34abcdcd6c17d3` 已验，本包已独立审查并随 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 合并。完整 M1 的项目 / 稳定身份版本 / 表字段依赖及 M2–M5 仍待办，无详情 / 下载 / preparation 接线。root 独占真实会话，旧链永久禁用，PR #35 仍独立 Draft；恢复事实与边界以新交接为准，下方“未登录完成 / 新链未建”等按历史阅读。

> **2026-10-20 最新入口：[月度链路](../TAX-MONTHLY-DATA-CHAIN.md)** · [M1–M5任务](../tasks/TAX-MONTHLY-DATA-CHAIN.md) · [交接 / 新任务提示词](TAX-MONTHLY-DATA-CHAIN.md)。用户本期已报，先以一个已确认项目打通已报期及必要历史取数 / 官网确有文件；未报待办、完整规则平台不是当然前置。PR #35 仍独立 Draft；新增查询 / 下载与准备桥接未完成。本轮纯文档，未操作真实会话；用户正重登但未告知完成。技术缺口与企业确需补充分别处理。先读新交接再恢复，下方“当前”均为历史快照。

> **2026-10-20 当前包：[TAX-BUSINESS-COLLECTION](../tasks/TAX-BUSINESS-COLLECTION.md)** · [交接](TAX-BUSINESS-COLLECTION.md) · [契约](../TAX-COLLECTION-CONTRACT.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #14 / #17；分支 `codex/huxiaoyang-code/tax-business-collection`，基线 PR #33 merge `f05c7a1a6a9412ab873f4b282a76ee773baff2f7`（已审查验证合并）。用户关闭旧浏览器后要求再次启动后端浏览器并已登录，root 已绑定全新专用窗口。新 v2 source 4 passive + 1 identity、现有 MCP 两轮各 3 fresh / 3 complete / 6 行，独立投影相等、无保留锁，仍仅既有白名单覆盖。新增期间 / 企业字段及严格零时间格式已验收：root 完整 26 / 26 套、独立原 54 + 增量 45 项通过；现有 MCP → 新纯采集后端最终两轮各 3 fresh / 3 complete / 6 行，无保留锁，企业 6 字段均 present / nonempty 6、投影相等，期间 validPair 6、缺失 / 非法 / 倒序 / 不支持均 0，起止 Midnight 各 6、distinctPeriodCount 3、alreadyFiledWithValidPeriod 6，filingPeriodsVerified true，source / run 与 run / run 可比且 PairEqual / MultisetEqual true。仅核实这 6 行已申报记录，已进入纳税人信息查询页，业务数据捕获不足，总任务未完成。
>
> 本机已见 skssqq / skssqz / skssqzqz 在 6 行均为 string，旧白名单漏保留；此前 period missing 是未采入 / 未核实，不能说接口未返回。6 行均已申报，更正 / 作废 / 财报报送入口封锁，待办请求失败不当空。已扩私有期间 3 / 企业 6 字段，保持旧文件和版本兼容，旧缺日期不可比；已申报 filingPeriodsVerified 与当前待办 periodVerified / currentPendingPeriodVerified 分开，后两项及 businessScopeVerified / projectionComplete 仍 false，完整 profile / full business 仍缺。已发现唯一纳税人信息查询 / 申报信息查询菜单及固定同源路由，正常导航原型独审 30 项通过，新 JS private 隔离、safeAssetRefs[]；已沿有效菜单一次正常 Page.navigate 进入纳税人信息查询，前2+后1共3 identity complete、documentScopeVerified / identityProjectionMatched true，无保留锁；首轮业务捕获不足，正调整 ignored 采样优先业务 XHR / Fetch、暖缓存再观察，未预填第二次结果，申报查询页仍未进入。root 已用新纯采集后端完成字段实采，仅重启不拥有浏览器的 collector 加载格式补丁，登录 owner 后端 / 浏览器保留。恢复只查本 worktree ignored checkpoint；原值 / 凭据只本机，安全 refs 不入 Git，正常导航授权有效，自动点击及业务写禁止。

以下旧入口按各包历史阅读，不能覆盖上方当前锁与完整 URL 语义。

核心“门户契约 + 真实复采”已随 [PR #29](https://github.com/huxiaoyang-code/youshu-fork/pull/29) 于北京时间 **2026-10-20 13:44:12**（UTC `2026-10-20T05:44:12Z`）合并。最终 head `c1d663a7b107f8538e01100a37c0b1102b9c02aa`，merge `bdc6e9a1c26835889d873ea0af1c57ac35d292ce`；管理者已 fetch 核对，最终独立审查与 head 一致性核对通过。

> **2026-10-20 优先恢复：[TAX-COLLECTION-REBASE](../tasks/TAX-COLLECTION-REBASE.md)**、[采集契约](../TAX-COLLECTION-CONTRACT.md)、[本包交接](TAX-COLLECTION-REBASE.md)。负责人 `huxiaoyang-code`；分叉基线 `0345046ce40b644f26d4ea52adb362d040533bc2`，独立分支 `codex/huxiaoyang-code/tax-collection-rebase`。只查本包 worktree 的 `.agent-runs/TAX-COLLECTION-CHECKPOINT.json` 恢复实际引用 / 进程 / 窗口，不复用已废弃 provisional，不盲重启原后端。旧 19 项未提交文件哈希未变，旧 owner / browser / quarantine 保留。
>
> 本包新 source 已成功：4 passive + 1 active identity verify，新 context / loader、`scopeRevision = 0`、身份投影匹配、新锁释放；`Csbz` 实际 wire 匹配。真实原 MCP stdio → 隔离 HTTP → Agent → 后端两次各 3 fresh 请求均 performed / complete，合计 6 个，不同 run，source / run 及 run / run 三项投影比较全 true，`independentRequests = true`，各 6 行。行字段异构，曾最大 32，`zspmDm` 仅 4 / 6 行存在。`documentScopeVerified = true`，但 `businessScopeVerified`、`enterpriseVerified`、`periodVerified`、`projectionComplete` 均 false，仍缺 `business_period`、`full_enterprise_profile`、`full_business_fields`。
>
> 管理者最终 `npm test` 23 / 23 套及采集合成 54 项均 exit 0；无实施上下文的独立 reviewer 已审当前代码无剩余阻塞，最终独审与 head 一致性核对已通过，核心 PR #29 已合并。核心“门户契约 + 真实复采”已随 PR #29 验收合并；整个专项未完成，后续已授权沿实际同源业务页补期间与资料，不是等待用户输入。历史 `scope_cleanup` / 废弃锁已非阻塞。正常导航允许，自动点击、隐藏接口猜测及正式申报 / 缴款等禁止；原始本机标识 / 调试信息 / 原值 / 凭据不进模型或 Git，安全引用不写 Git / PR。下方其他入口按历史阅读。
> **当前后续阶段（核心合并后）**：新 source 刷新已成功 4 passive + 1 active identity verify。`candidate_only` 忽略目录原型经独立审查、49 项合成通过后，管理者实际 prepare 在 `identity_before` 失败；performed 计数 0 不代表没有尝试。未导航、未形成 candidates，新 `business_page_prepare` scope 锁保留，正在审查安全诊断 / 受控 reload 恢复。这是后续原型新状态，不是核心历史锁复发，不影响核心两次 MCP 已验结果；整个专项继续未完成，不等待用户补授权。
> **2026-10-20 优先恢复：[TAX-SESSION-DISCOVERY 任务](../tasks/TAX-SESSION-DISCOVERY.md)与[交接](TAX-SESSION-DISCOVERY.md)**。负责人 `huxiaoyang-code`；[PR #27](https://github.com/huxiaoyang-code/youshu-fork/pull/27) 已于北京时间 **2026-10-20 01:00:33** 合并，merge `73ee241648fb70711af21f8bdae49ed2f6680ab7`，完整候选 `a07c93a3657a9aaade5d44562a85f615327a82dd` 的 17 文件独立最终复核通过、无剩余阻塞，fetch 后树一致。3 个专用 Edge 工具与 DTO 去重修复已交付，17 套全量及独立 59 / 46 / 4 项通过；纯文档收尾分支 `codex/huxiaoyang-code/tax-session-handoff` 基于该 merge，恢复仍先核对最新 main / PR，原分叉基线及实施分支见交接。
>
> 实机 MCP → 后端 → 专用 Edge 已验证 open / 未登录 probe / close；**业务请求与成功均为 0，企业 / 期间未取得，后端第二遍业务采集未运行，专项未完成**。专用 Edge、临时 profile 和临时后端已清理，原官方页保留；不要沿用旧 connection / tab 标识。用户反馈登录遇到问题、稍后说明，当前等具体问题，不要求点击探索；解决后优先后端专用官方窗口人工登录一次，继续真实 schema / 企业 / 业务采集，不复制原窗口凭据。
>
> 本包用户明确采用 Codex subagent 并行实施与无实施上下文的独立最终复核，覆盖下方旧员工范式；root 独占真实会话，其余仅安全契约 / 合成数据。自动点击仍禁用，真实资料不进模型，正式申报 / 缴款等不执行；Issue #20 / #13 / #14 / #17 保留。旧入口与测试按历史阅读，不用旧 530 项或本包通道成功冒充真实接入。

> **2026-10-19 全量开发接管（用户最新指示，优先）**：全部后续开发已交给同事在**另一台电脑**的 Codex 接手，继续向同一私有仓库提交，**沿用 `huxiaoyang-code` 账号**（不 fork / 不换用户名 / 不新建仓库），**不复制**原机器 token / config / session / 账套 DB。本次**仅交接文档**。
>
> - 先读 [全量接管交接](FULL-DEVELOPMENT-TAKEOVER.md)（自足：代码地图、状态矩阵、在途资源、缺陷与顺序、命令、首日清单、可复制启动提示）与 [全量接管任务单](../tasks/FULL-DEVELOPMENT-TAKEOVER.md)；税局登录后 checkpoint 见 [TAX-POSTLOGIN-CHECKPOINT](TAX-POSTLOGIN-CHECKPOINT.md)。
> - 交付目标为**最新业务 PRD 全部范围**：[PR #18](https://github.com/huxiaoyang-code/youshu-fork/pull/18) head `346e1c307379e9a6bf96ef34244dee154558777f`（Draft，未合并进 main，需 `git fetch` 后只读查看，并先核对 head）。
> - 远端载体：**总接管 [Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)**（OPEN，assignee `huxiaoyang-code`）；业务 Issue #13 / #14 / #17 仍 OPEN（旧 assignee 未变、未关闭）；子 PR 用 `Refs #20` 并按业务 `Refs #13` / `Refs #14` / `Refs #17`。
> - **下文 A / B 分工与旧现场描述属历史快照**，不再限制接手者；Issue #13 / #14 / #17 保留、不自动关闭；开工前在 GitHub 核对在途 PR 并登记同名文件；**接管授权已由用户确认，不需要再次确认切换审批**，只在发现实际冲突或未停的同文件实施时协调。
> - 自动点击浏览器 / 点击脚本路线已被用户**永久否决**；`huxiaoyang-code` 的自审自动合并授权继续有效，但须独立审查 + 影响验证 + 串行整合，**不伪造 GitHub review**。

> **先识别自己是谁**：本仓库已支持**多成员跨电脑协作**。开工前先按 [任务看板](../tasks/README.md) 与 [团队协作协议](../TEAM-COLLABORATION.md) 确认自己的**人类成员身份与已分配任务**，**不要默认所有机器都接 RC-0**。当前分工：负责人 `huxiaoyang-code` → [RC-A-LOGIN-DATA](../tasks/RC-A-LOGIN-DATA.md)（总任务 [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)）；同事 `xiaoyihaishiaini` → [RC-B-REPORTS](../tasks/RC-B-REPORTS.md)（总任务 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)）。
>
> 本文件是新 Codex 对话的最小入口。先读本文件，再读 [项目章程](../PROJECT-CHARTER.md)、[阶段状态](STATE.md) 和 [本地优先技能](../../team-skills/local-agent-first/SKILL.md) 即可继续；历史日志（`.agent-runs/`）默认不作为新会话上下文，只在排查具体故障时按需查阅相关日志。

## 当前基线（可核验事实）

- **当前（2026-10-21）**：Edge 查询 / 下载模式修复 `TAX-EDGE-DOWNLOAD-FIX`，详见[入口](../TAX-EDGE-DOWNLOAD-FIX.md)。
- 最新已知 main 提交：`c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0`（PR #15 合并，mergedAt `2026-10-15T15:40:41Z`，即北京时间 2026-10-15 23:40；2026-10-16 是本次文档复验 / 核实日期）。**恢复时先核对当前 main / 远端**，后续 PR 合入后以实际最新提交为准。
- **PR #1–#12 与 #15 已合并；Issue #13 / #14 仍 OPEN（不是 PR）**。业务实现合并提交为 `03eba00`（PR #7）；#10 IMPORT-STRICT（业务代码，`67f5e45`）；#11 IMPORT-STRICT 交接归档（`cc6e789`）；#12 报表闭环方案重排（`8ebc739`）；**#15 内部五类 CSV 导出与税表参考校验**（同事 PR，`c2d5619`，head `843cad08c0e42e0614459bbbfc77160eadf498ad`，代码验证提交 `b913409d420cdd1d8264ad0d64a474880604c90f`）。
- **测试事实**：208 项（6 套，业务提交 `03eba00`）、262 项（7 套，`67f5e45`）是既有验收事实；**当前 main `c2d5619` 为 10 套 336 项**（管理者 2026-10-16 独立复验 `npm test`、exit 0，合成临时数据库，未读真实数据）。**团队文档变更不重复业务回归。**
- 工具入口共 45 个：31 available（其中 7 个是税务预留接口）、1 limited、13 unavailable。**真实税局接入数 0**；入口数量不等于真实连接数。

## 未完成现场（先核对，勿重复派工）

- worktree `D:/有数云fork/.worktrees/tax-browser`，分支 `codex/tax-browser-import`，基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`（**负责人本机现场；同事不需寻找或重做**）。
- 状态：**未提交、未 PR、未合并**；为福建漳州浏览器登录后读取企业 / 批量新建或绑定账套的本地草稿，**不能代表全国接入**，**企业列表不等于财务凭证**。
- 员工交接 `D:/有数云fork/.worktrees/tax-browser/docs/handoffs/TAX-BROWSER.md`；员工**自报** 272 项通过，管理者**未独立复跑**，**真实税局登录未验收**。
- 日志 `D:/有数云fork/.agent-runs/pi-tax-browser.jsonl` 退出码**尚未核实**，不能声称 exit 0；该历史退出码与本轮文档部分、与 IMPORT-STRICT 的 exit 0 均**不能混同**。
- 保留原目录，不重置 / 删除 / 覆盖 / 重做；**RC-0** 在新隔离工作区复审 / 整合，保留原件，检查与最新 main 的冲突（**PR #15 改了 `server.mjs` / `public/*` / `scripts/test-all.mjs` / `test/*`，整合须逐项检查冲突**）。14 个未提交文件内容哈希与 `.agent-runs/import-strict-tax-preservation.json` 清单一致。

## 方向（不可漂移）

本机**单用户**财税工作台；**一家企业一个账套**，多企业批量处理对应多个账套；**不做多租户 / SaaS / 租户权限平台 / 对外服务**（开发多人不改变产品形态），也不做一企多账簿 / `bookKey`。只保留账套隔离、操作日志、备份恢复、凭据安全等本机需要。全国电子税务局是产品目标，当前只有预留接口、真实接入 0。详见 [章程](../PROJECT-CHARTER.md) 与 [ROADMAP](../ROADMAP.md)。

## 已完成

- 记账、三大报表、试算、明细账、折旧/摊销、结转损益、封账/反结账、期间登记、旧账导入（JSON / 4 CSV，预检 + 事务，**严格校验**）。
- MCP 45 入口与真实能力目录；全国税务适配层与异步会话契约（本地假适配器测试，未联网）。
- **RC-B B0 / B1（PR #15）**：五类内部 CSV 导出（资产负债表、利润表、现金流量表、各科目余额表、明细账）、HTTP 下载与同口径页面 / JSON 预览；详见 [REPORT-EXPORT](../REPORT-EXPORT.md) 与 [RC-B 交接](RC-B-REPORTS.md)。
- 当前 main `c2d5619` 上 10 套 336 项（管理者复验，合成临时库）。

## 明确限制（未实现，不承诺）

- 旧账导入**非幂等**（每次新建账套，**不修改既有账套**）→ 归入 **RC-2**。
- 无本机批量任务队列与管理 → 报表闭环完成后再定归属（本计划不先行搭建泛用批量平台与展示大屏）。
- 真实电子税务局 0 接入；辅助核算、银行对账、发票、申报均未实现。
- **RC-B 已交付内部五类 CSV 下载**；但 **B2 税局可上传申报文件未完成**：缺适用地区 / 准则 / 模板版本 / 上传格式，当前税表导出返回 422 `tax_template_unverified`。**内部 CSV ≠ 税局申报可用文件**；已有税表法定结构参考 / 勾稽校验与就绪性阻断，见 [TAX-REPORT-FORMAT](../TAX-REPORT-FORMAT.md)。
- **XLSX / PDF 未实现**；浏览器下载落盘在同事会话未确认（HTTP 附件已由接口套件验证）。
- RC-3 财务流水线完整性、RC-6 端到端交付未完成；税局是否提供科目 / 期初 / 凭证 / 银行 / 发票**不可先行承诺**；若仅有企业列表 / 申报汇总，**不能完成自动财务闭环**。
- 文档-only 变更不要求重跑 336 项；代码变更按受影响测试，关键合并基线跑全套。

## 下一任务（按自己成员身份选择）

- **A（负责人 `huxiaoyang-code`）**：先做 **RC-0 第一步**（`TAX-BROWSER-REVIEW`）：在新隔离 worktree 复审 `tax-browser` 草稿，复跑其套件并记录实际结果，检查与最新 main 冲突，审计安全边界；整合 PR #15 的共享文件改动时逐项检查冲突。**不得假定企业列表等于财务凭证。** 真实验证（账号 → 验证码 → 授权企业 → 实际财务数据来源）需用户本机参与，为第二步。
- **B（同事 `xiaoyihaishiaini`）**：**不退回 B0 待开工**；当前阶段是 **B2 模板研究与正式导出成功路径**（取得适用地区 / 准则 / 模板版本 / 上传格式证据），并向负责人汇总 **RC-3 核心缺口**；RC-2 / RC-6 整合由负责人协调。
- 完整工作包 RC-0 ~ RC-6、数据可得性门槛、分类结论与验收场景见 [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md)；成员分工与依赖任务表见 [阶段状态 §后续可执行任务表](STATE.md)。
- 已替代：旧序「IMPORT-IDEMPOTENCY 第一优先」已失效；IMPORT-IDEMPOTENCY **并入 RC-2**，不再是首包。
- **本次交接本身不主动继续开发**：本文件只描述入口，各任务由管理者按任务单派工，本地员工不得抢跑。

## 必要命令

```powershell
# 每段命令都从仓库根独立运行；需要切换目录时用 Push-Location / Pop-Location 成对使用。
# 文档变更自查：范围 / 链接（按需）
git diff --stat
git diff --check
# Skill 格式（先在当前机器核实 quick_validate.py 的绝对路径）
python -X utf8 <ABS_QUICK_VALIDATE>/scripts/quick_validate.py team-skills/local-agent-first
# 代码变更 / 复审时从仓库根运行：
Push-Location 06-workbench
npm test          # 全套（当前 main c2d5619 为 10 套 336 项；历史基线 262 / 208 项）
npm run test:smoke
Pop-Location
```

## 授权与边界

- 用户已授权：将本项目必要源码 / 任务说明 / 测试错误发送到已配置 tokenhub；验收通过后自动合并 PR。范围见章程与 [STATE](STATE.md)。
- 新仓库需重新核对当时授权范围；通用 Skill 不复制这些授权，也不推导外传授权。
- 禁止用真实账套 / 凭据做自动测试；真实账套数据与税务凭据不发到模型服务，开发所需源码 / 任务说明 / 测试错误仅按本项目已授权范围发送到 tokenhub；不绕过沙箱。
- **执行员工只允许 GLM 5.3 或 DeepSeek V4.1 Flash（主 / 回退显式锁定）**；该约束不限制各成员本机 Codex 自身的模型。团队默认范式仍为本地 pi / Claude Code 执行、Codex 管理。
- **同事 RC-B 会话的例外记录（不泛化）**：同事交接 [RC-B-REPORTS](RC-B-REPORTS.md) 记载其该会话用户允许 **Codex Subagent 实施**，属**该任务内的例外**；保留来源与限定，**不冒充本会话新授权**，也不泛化给后续任务。

## 会话状态

- **本轮 TEAM-HANDOFF（多人协作）为纯文档 / 模板变更**，共 18 个文件：**10 修改**（`AGENTS.md`、`docs/PROJECT-CHARTER.md`、`docs/TEAM-PLAN.md`、`docs/REPORT-CLOSURE-PLAN.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`、`docs/handoffs/STATE.md`、`docs/handoffs/NEXT-SESSION.md`、`docs/handoffs/TEMPLATE.md`、`docs/tasks/RC-B-REPORTS.md`——其中 **`RC-B-REPORTS` 任务单为 PR #15 已有，本轮是修改不是新增**）+ **8 新增**（`docs/TEAM-COLLABORATION.md`、`docs/handoffs/MEMBER-ONBOARDING.md`、`docs/handoffs/TEAM-HANDOFF.md`、`docs/tasks/README.md`、`docs/tasks/TEMPLATE.md`、`docs/tasks/RC-A-LOGIN-DATA.md`、`.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/requirement.md`）；**未改业务代码 / 测试 / Skill、未加 CI / CODEOWNERS / 规则集；员工未重跑业务回归，管理者已独立复验 PR #15 基线（`c2d5619`，10 套 336 项、exit 0，合成临时库）**。员工会话日志 `.agent-runs/pi-team-handoff-current.jsonl`、退出码文件 `pi-team-handoff-current.exit`（**本机可查，不作为同事先决**）；管理者已核实统一执行 session80422 结果 `pi-team-handoff-current.exit=0`。
- **PR #15（同事 RC-B）为业务代码变更**：管理者在 `c2d5619` 复验 `npm test` 10 套 336 项、exit 0（合成临时库）。同事 PR **没有 CI / 正式 GitHub review 记录**，**不称 CI 通过**。
- **IMPORT-STRICT 本部分是代码变更**：员工返工自测 262/262 + smoke 28/28；管理者 2026-10-15 独立复跑通过并合并 PR #10，退出码 0。
- **本轮 REPORT-CLOSURE-PLAN 为文档变更**：进程与退出事实见 [REPORT-CLOSURE 交接](REPORT-CLOSURE.md)。
- tax-browser 会话的**历史**退出码尚未核实，见「未完成现场」，不得据此声称 exit 0，也不得与本任务的 exit 0 混同。
- 仓库权威技能 `team-skills/local-agent-first/SKILL.md` 已由管理者审查并安装到**负责人本机** Codex 技能目录 `C:/Users/35007/.codex/skills/local-agent-first/`（两处文件 SHA256 与仓库副本一致，`quick_validate.py` 通过）。**这是负责人本机信息，不是通用硬编码路径**（官方通用用户技能目录为 `~/.agents/skills`）；同事在自己的 Codex 审查后自行安装，先检查同名避免覆盖。安装前备份在 Git 忽略目录 `.agent-runs/local-agent-first-before-20261014-150009.md`，只在本机存在。

---

## 可直接复制给新 Codex 的开场提示（A：负责人）

```text
我是项目负责人 huxiaoyang-code（成员 A）。请先读 docs/handoffs/NEXT-SESSION.md、docs/PROJECT-CHARTER.md、
docs/handoffs/STATE.md、docs/tasks/RC-A-LOGIN-DATA.md 和 team-skills/local-agent-first/SKILL.md；
历史日志默认不读，只在排查具体故障时按需查 .agent-runs/。
恢复时先核对当前 main / 远端：本文件记录的最新已核实基线是 c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0
（PR #15 合并），它不是新对话必须停留的 HEAD，以实际最新提交为准。
PR #1–#12 与 #15 已合并；Issue #13 / #14 仍 OPEN（不是 PR），子 PR 用 Refs。
当前 main 10 套 336 项为管理者复验事实（合成临时库）；员工未重跑业务回归，管理者已独立复验该基线。

我的任务是 A0 = RC-0 第一步（TAX-BROWSER-REVIEW）：在新隔离 worktree 复审 tax-browser 草稿，
保留原目录只读，复跑其套件并记录实际结果与退出码（员工自报 272 不作为结论），
检查与最新 main 的冲突（PR #15 已改 server.mjs / public/* / scripts/test-all.mjs / test/*，逐项检查），
审计安全边界；不得假定企业列表等于财务凭证。
真实验证（账号 → 验证码 → 授权企业 → 实际财务数据来源）是第二步，需我在本机参与；
验证码只从实际接收渠道取得并在本机输入，不进模型 / 日志 / Git。

方向仍为本机单用户；一家企业一个账套，多企业批量 = 多账套；不做多租户 / SaaS / 对外服务，不做一企多账簿 / `bookKey`。全国电子税务局真实接入 0。
执行员工只允许 GLM 5.3 / DeepSeek V4.1 Flash（主 / 回退显式锁定），该约束不限制你自己的模型。
你（本机 Codex）负责审查验收、Git/PR 与合并，不直接写业务代码 / 测试 / 交付文档；
只有缺必要范围或授权时才问我。
```

## 可直接复制给新 Codex 的开场提示（B：同事）

```text
我是成员 xiaoyihaishiaini（同事 B）。请先读 docs/handoffs/MEMBER-ONBOARDING.md、
docs/TEAM-COLLABORATION.md、docs/tasks/RC-B-REPORTS.md、docs/handoffs/RC-B-REPORTS.md、
docs/REPORT-EXPORT.md、docs/TAX-REPORT-FORMAT.md、docs/PROJECT-CHARTER.md、docs/handoffs/STATE.md
和 team-skills/local-agent-first/SKILL.md。
我的总任务是 Issue #14（RC-B-REPORTS）；子 PR 用 Refs #14，不因 B0/B1 完成就 Closes #14。

现状：B0 口径/契约与 B1 五类内部 CSV 已随 PR #15 合并（main c2d5619）；
不退回 B0 待开工。当前阶段是 B2 模板研究与正式导出成功路径：
必须取得适用地区 / 准则 / 模板版本 / 上传格式证据后才能生成声称可申报的文件；
当前导出返回 422 tax_template_unverified，拒绝输出本身不算 B2 交付。
同时向负责人汇总 RC-3 核心缺口（如间接法末行、两套准则共用同一 COA、复杂混合现金流）。

边界：产品本机单用户；一家企业一个账套，多企业批量 = 多账套；不做多租户 / SaaS / 对外服务；全国电子税务局真实接入 0；
税局是否提供科目 / 期初 / 凭证 / 银行 / 发票不可先行承诺。
我用自己的 GitHub / Codex / 模型服务凭据，不复制负责人 token / config / session / 账套 DB。
我的本地执行员工只允许 GLM 5.3 或 DeepSeek V4.1 Flash（主 / 回退显式锁定）；不用其他模型或子 agent；
该约束不限制你（Codex）自身的模型。本地员工只做实现与自测，不执行 Git 提交 / 推送 / 合并。
我的新模块 report-export 与 tax-report-format.mjs 归我；tax* / import* 采集与导入归负责人；
共享接线走独立集成 PR 或先申请短期所有权。
我可以按团队协议自动合并我自己的 PR（用户已授权），前提是通过验收与整合约束，
合并前拉最新 origin/main、重验受影响范围、锁定已验证 head。
不要新建 GitHub Actions / CODEOWNERS / 规则集，不声称已有 CI 或分支保护，不擅自改远端设置。
不用 npm install（零第三方依赖）；用临时合成数据目录跑测试，绝不覆盖生产库。
请先核实我的环境与任务范围没有冲突，然后直接开始 B2 前置（现行模板证据 / 格式 / 映射 / 成功出口）并派本地员工；
只有确实缺必要输入或需要扩大授权时才来问我。
```
