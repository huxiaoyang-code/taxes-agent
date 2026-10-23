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

> **2026-10-23 当前看板**：只有 LOCAL-02 整包完成；八包最新事实、PR65完整head/merge与未完范围见 [STATE当前八包状态](../handoffs/STATE.md)。下方表格已更新；更早段落保留历史时点。用户要求全部剩余任务验收后自动合并；本项目火山路由、单一兜底及fresh独审例外见 [章程](../PROJECT-CHARTER.md)，不外推到其他成员 / 项目。税局专项暂停、真实接入0，总任务20/13/14等继续开放。

> **2026-10-22 合并后兼容整合（已随 PR #60 合并）：LOCAL-06 备份适配精确 v3 + v4** · [契约](../LOCAL-BACKUP.md) · [任务](LOCAL-06-BACKUP.md) · [交接](../handoffs/LOCAL-06-BACKUP.md)。备份子包已随 [PR #55](https://github.com/huxiaoyang-code/youshu-fork/pull/55) 合入（merge `98977e0`，已审源码 head `b2dcba3`），但当时只认 v3；本轮只改备份自有 3 个文件 + **仅追加**的 `scripts/test-all.mjs` 登记：v3 / v4 两份独立精确契约（列 / 类型 / NOT NULL / 默认值 / 主键 / UNIQUE / 外键完整集合与动作 / 迁移记录连续性，差异仅 `asset_cards`）；v3 旧备份只读验证 / 恢复且不迁移备份与源库，只由产品入口显式打开才升 v4；v4 用真实产品合成库实际 `backup → verify → restore-new` 并用真实入口读取与继续操作；伪兼容（只抬版本 / 缺列 / 错默认值·null·类型 / 迁移不连续 / 未知组件 / 未来版本 / 重算摘要）全部拒绝；后续又补唯一性键语义加强（`COLLATE` / 列方向 / `origin=c` 额外唯一索引 / `rowid` 别名）。测试：备份 **20 / 20**（初轮）、唯一性键加强后 **22 / 22**（后续独立审查自跑仍 22 / 22 exit 0）；中间一轮全量 `npm test` **53 / 53 套 exit 0**。状态（当时）：未提交 / 未建 PR；**该 v3 / v4 扩展已随 LOCAL-02 的 [PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 实际合并（merge `dfefae0`，2026-10-22T13:34:48Z），独立 `review_backup06_final` 在精确 98a 接受**。LOCAL-06 整体仍未完成（审计业务接线 / 原位恢复 / Windows 交付）
>
> **2026-10-22 当前：LOCAL-02 会计金额、期末完整性与连续期间（已验收合并）** · [任务](LOCAL-02.md) · [契约](../ACCOUNTING-PERIOD-INTEGRITY.md) · [交接](../handoffs/LOCAL-02.md) · [八包总览](INDEPENDENT-PRODUCT-WORK.md)。负责人 `huxiaoyang-code`（已核实），**[Issue #47](https://github.com/huxiaoyang-code/youshu-fork/issues/47)**（Refs #20 / #13 / #14），基线（源码）`1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`（工作区已由管理者快进到 `94a79ef` = LOCAL-01 交接文档，源码无变化），分支 `codex/huxiaoyang-code/local-02`。交付：新增 `money.mjs`（人民币分精度 + 唯一 ROUND_HALF_UP；上限按完整原值判定；极小负数 / 极小正数不静默归 0；存续金额不受单笔上限约束；不可保分合计显式拒绝）与 `period-end-controls.mjs`（七步期末检查 + 封账前置 + 前期可改性守卫 + 卡片期间状态与总账核对）；`accounting.mjs` 全金额路径改整数分、折旧按分期表在寿命内恰好提足、期间口径累计不被后期污染、结转失效检测；schema **v4**（`asset_cards` 补 `acquired_period` / `opening_accumulated` / `ledger_status` / `ledger_note` / `origin`，先备份后建结构）；经 HTTP `GET …/period-end-check`、`PATCH …/assets/:assetId` 与 Agent / MCP `period_end_check` / `asset_update` 实际可查可操作；更晚期间封账、已过账派生凭证（年末 / 普通结转 / 计提）与已封账期间卡片维护均拒绝并给撤销顺序；未入账登记不豁免原值核对且不得计提。测试口径（该阶段）：**该阶段最终代码**实跑 `npm test` **50 / 50 套 exit 0**（本包新增领域 **45 / 45**、HTTP+Agent **18 / 18**、MCP **5 / 5**，全部合成临时库 + 随机回环端口）。**旧候选 50 / 50（38 / 13 / 4）不能代表最终通过**：最终独审 review2 实测四个阻塞（旧折旧草稿重过账、亚分金额静默归 0、未入账登记未按取得期间过滤、巨大寿命先落库后 DTO 抛错）已逐项修复并补先红后绿回归；review3 再补一项同影响面 P2（取得期间晚于计提期时生成 / 校验两套口径矛盾导致“删了又生成 → 立即 stale”循环），已统一复用 `expectedDepreciationCents` 并补定向回归（域 43→**45**、HTTP 17→**18**）。状态：**已验收合并**：[PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 于 2026-10-22T13:34:48Z 实际 MERGED，merge `dfefae0553052474b8a9308105443714bc5d9cfb`，最终文档 head `18aa6fb8b5d36181092397504bf1b8b338d71fb9`（tree `1d2a4b8b84e763ebac5bf52801d4989b7f5b8e33` 与 merge tree 一致），Issue #47 已 CLOSED；证据在各自候选上独立接受（核心 `review_core02_final` 在 `bd05415`、输出协议 `review_output08_final` 在 `3a8ae7a`、备份 `review_backup06_final` 在精确 98a），root 在精确 98a 实跑 **55 / 55** 套 exit 0、Office **21 / 21**、**11 PDF** 几何、备份 **22 / 22**，最终文档 head `18aa6fb` 未重跑这些套件；3a 的 37 policy / 21 adapter / 18 transport 属**员工测试**且共享模型入口仍未接线；历史一次 HTTP 退出 3221226505 **原因未定位**（Windows 59 继续跟踪）。**税局现场仍暂停、真实接入 0**。下方条目按其时点阅读。

> **2026-10-22 已验收合并（前包）：[LOCAL-01 增量导入与批次幂等](LOCAL-01.md)** · [契约](../LOCAL-IMPORT.md) · [交接](../handoffs/LOCAL-01.md) · [八包总览](INDEPENDENT-PRODUCT-WORK.md)。用户 2026-10-22 指示允许本机产品方向工作，覆盖旧「暂停本地扩建」；**税局现场仍暂停、真实接入仍 0**，本路线不启动浏览器、不访问税局后端。负责人 `huxiaoyang-code`（已核实），Refs #20 / #13，**[Issue #43](https://github.com/huxiaoyang-code/youshu-fork/issues/43)**，基线 `0c4e0dd622fc35bcb5d6e6af3620c6f971b2a805`，实际分支 `codex/huxiaoyang-code/local-01`（此前误写为 `local-01-import-incremental`，已更正；已审 head `e12e71eb29dd5fc480aeebe5f0baace94bc3a4d7`，[PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 已实际 MERGED，merge `1a15bcce3bf3b1f0d390746d85be7cfd1ace7ea3`，北京时间 2026-10-22 17:13:24，管理者 fetch 核实 merge 树 = 已审 head）。本包区分旧首次创建 / 有企业身份首次建账 / 指定已有账套追加，按**一企一账套**（规范 `enterpriseKey`，跨来源同企业引导到已有账套）补齐批次 ID + 来源凭证指纹、同批幂等、跨批去重、修订与凭证状态（反过账 / 修改 / 删除）结构化冲突、单事务、迁移前一致备份与迁移事务时序。第二轮独审修复：填空账套期初同批回放、自动取号统一预分配（同字号不重号）、跨批去重逐张批次追踪（schema v3 `import_batch_vouchers`）。最后定向返工：`create` 同批回放也按批次账套核验真实期初（合法 API 改期初后不再伪报 replay；首次正式执行仍合法、无期初批次不凭空要求快照），`sourceTrace` 正式执行 / 查询 / 回放统一逐张 DTO 字段。测试口径分层：上一冻结候选全套 47 / 47 套 exit 0（最终两处定向修复之前）；最终代码（精确 head `e12e71e`）只实跑领域 49 / 49、HTTP+Agent 22 / 22、MCP 7 / 7，均 exit 0（管理者与独立审查者分别实跑），**最终代码未再重跑全套 47 套**。状态：**已验收合并**（PR #46 已 MERGED；独审未参与实现、`fork_turns=none`、未读员工日志，无剩余阻塞；仓库无 CI，不冒充第二账号批准）。八包映射按用户原任务单：LOCAL-05a（#45）导出模块常规 16 项 / 7 个 PDF 共 31 页初验通过、超长字段边界返工中；LOCAL-08（#44）独立模块 28 项已过独审但尚未实际接线（均不冒称整体完成），其余待开工；**下一核心 LOCAL-02**，见总览。下方 TAX-* 入口按其时点阅读。

> **2026-10-21 新增：[TAX-EDGE-DOWNLOAD-FIX](TAX-EDGE-DOWNLOAD-FIX.md)** · [交付](../TAX-EDGE-DOWNLOAD-FIX.md) · [交接](../handoffs/TAX-EDGE-DOWNLOAD-FIX.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #17，基线 `2bc05d3680b456ccecb7bf1a16b64107017114b1`，分支 `codex/huxiaoyang-code/tax-edge-download-fix`。用户确认同企业同条件下常用 Edge 能下载发票、旧后端专用 Edge 查询 / 下载失败；本机两者同版本 `155.0.4283.62`，旧专用 `inprivate=true`、常用 `false`。按官方 `blockthirdpartycookies`（InPrivate 默认阻止第三方 Cookie）为**可信兼容性假说，非实测税局根因**。仅改 4 文件：移除 `--inprivate`、保留 ACL 独立临时 profile / loopback CDP / 清理；诊断由强制 InPrivate 改为兼容旧 owned InPrivate / 新 owned normal，拒重复畸形 `inprivate` 与 guest / headless / unsafe，其余 owner / profile / 端口 / ACL 不放宽；两测试。员工 `browser-session` 46 + `diagnostic` 5 通过；管理者在冻结代码上**实跑 `test-all` 44 / 44 套 exit 0**。真实验证：隔离后端 + 空白运行目录 / 随机 loopback 端口，新专用 Edge 已启动核对 normal / 独立 profile / loopback / 同版本；旧四进程与用户常用 Edge 未改；新窗口待用户人工登录后同条件复验，**当前不声明查询 / 下载成功**。只读审查另发现 observer 子 frame / OOPIF 可见性待办与未实现下载事件（`downloadPerformed` 固定 false），列为后续技术待办，不冒充数据链打通。状态：**代码 + 管理者回归完成，独立审查进行中，真实下载待用户反馈，PR 未创建**；[PR #41](https://github.com/huxiaoyang-code/youshu-fork/pull/41) 已合并 `2bc05d3` 可作前置交接。

# 任务看板 · TASK BOARD

> **2026-10-21 新增：[TAX-API-CATALOG](TAX-API-CATALOG.md)** · [契约](../TAX-API-CATALOG.md) · [交接](../handoffs/TAX-API-CATALOG.md)。把现成报告明确列举的税局接口整理为 29 模块 / 131 条结构化目录，交付后端 7 个 `tax_api_catalog_*` Agent 工具与对应 MCP schema、参数校验、调用准备与纯结果分类器。只读合同，无法真实调用：本包线上已验证 0、适配器 missing、完整可调用契约 0、登录与写接口一律 `blocked_by_policy`。目录范围 = 材料范围，不等于全国 / 全站完整，也不等于报告自称的 200+ 端点。测试时序：管理者较早一次全量 `node scripts/test-all.mjs` 为 **exit 0、44 / 44 套**（基线，当时目录单测 31 项）；随后独审发现分类器把空结果族业务码与 HTTP 401/403/500 误判为 `business_empty`，员工已定向修为 `structure_unrecognized`（不重试、全局仍 `unknown`，`empty` + 2xx 保留正常），目录单测 31 → 32；主审已再次实际运行受影响三套：**目录 32 / HTTP 10 / MCP 5 全部 exit 0**。小修后只改分类器与该三套测试，**未再重跑全 44 套**。初审问题已逐项修复。状态：**实现 / 管理者回归完成，待最终 head 审查与 PR 合并；合并结果以对应 PR 与 Git 为准**（当前未提交 / 未建 PR / 未合并，不预报成功）；代码审查证据与合并证据分开登记，最终 head 审查仍在进行。本次交接更新只用 pi / tokenhub DeepSeek V4.1 Flash 改文档。

> **2026-10-21 当前：[TAX-DOWNLOAD-EXPLORATION](TAX-DOWNLOAD-EXPLORATION.md)** · [接口目录](../TAX-DOWNLOAD-EXPLORATION.md) · [交接](../handoffs/TAX-DOWNLOAD-EXPLORATION.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #14 / #17。本轮仅完成查询 / 下载探索支撑候审。财报按用户要求暂停；新门户 fresh 3 / 企业匹配已实测，发票已正常跳转，但只有脚本 / 认证 metadata，未识别列表 query。最新私有 snapshot 7 / 9 份、4,034,109B；observer 已独审 + root 37 项，120s / 180s 两个真实窗均 armed / scopeStable / 全 scope 布尔 true，事件 / metadata / bodies 0、cleanup true / 无锁，窗口现全停。用户已手动查询无结果，空或报错未区分，不推点击在记录窗内，不确认官网无数据 / 接口坏 / 登录失效。今天停止探索、仅收尾交接 PR，不请求 / 重开窗；下次须用户明确继续，再核 scope / snapshot + armed 后人工查询。41 组首跑 40 过、旧 MCP lost-response 模拟子 Node 异常，无改定向 4 / 4 过；root 随后全 41 组重试 exit 0、41 / 41 全过；本轮支撑交付冻结候审，[PR #40](https://github.com/huxiaoyang-code/youshu-fork/pull/40) 已创建、开放候审；代码已独审，用户今日停止事实的文档仍待最终 head 审查。 下载 / 新 repeat 0，当前只收尾支撑 PR 交接审核，总专项目标不结束，不建账问月份。下方旧状态保留原日期。

> **2026-10-20 当前子包：[TAX-HISTORY-COLLECTION](TAX-HISTORY-COLLECTION.md)** · [契约 / 安全资料对照表](../TAX-HISTORY-COLLECTION.md) · [交接](../handoffs/TAX-HISTORY-COLLECTION.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #14 / #17。固定历史查询代码与两轮真实 MCP 验证通过（各 3 fresh / 3 complete，6 行 / 2 期间，unknown 0，无保留锁，比较一致），已独立审查并随 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 合并。仅受限 M1 查询子包，完整 M1 的项目 / 稳定身份版本 / 字段依赖与 M2–M5 未完成。用户已登录完成，新链已建；PR #35 仍独立 Draft 未合并，不宣称企业三 API 已复采。下方月度文档及旧包状态保留历史。

> **2026-10-20 最新任务：[TAX-MONTHLY-DATA-CHAIN](TAX-MONTHLY-DATA-CHAIN.md)** · [业务链路 / 能力矩阵](../TAX-MONTHLY-DATA-CHAIN.md) · [交接](../handoffs/TAX-MONTHLY-DATA-CHAIN.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #14 / #17。本期已报，优先单项目已报期真实取数 → 详情 / 官网确有文件 → 资料依赖与企业补充，后端缺项明确列待办；技术失败不转企业补交。本文档包未实现新取数 / 下载，PR #35 独立 Draft 未合并。用户正重登但未告知完成，本轮不操作浏览器。下方旧包保留历史，不再以未报待办作为唯一前置。

> **2026-10-20 当前包：[TAX-BUSINESS-COLLECTION](TAX-BUSINESS-COLLECTION.md)** · [交接](../handoffs/TAX-BUSINESS-COLLECTION.md) · [契约](../TAX-COLLECTION-CONTRACT.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #14 / #17；分支 `codex/huxiaoyang-code/tax-business-collection`，基线 PR #33 merge `f05c7a1a6a9412ab873f4b282a76ee773baff2f7`（已审查验证合并）。用户关闭旧浏览器后要求再次启动后端浏览器并已登录，root 已绑定全新专用窗口。新 v2 source 4 passive + 1 identity、现有 MCP 两轮各 3 fresh / 3 complete / 6 行，独立投影相等、无保留锁，仍仅既有白名单覆盖。新增期间 / 企业字段及严格零时间格式已验收：root 完整 26 / 26 套、独立原 54 + 增量 45 项通过；现有 MCP → 新纯采集后端最终两轮各 3 fresh / 3 complete / 6 行，无保留锁，企业 6 字段均 present / nonempty 6、投影相等，期间 validPair 6、缺失 / 非法 / 倒序 / 不支持均 0，起止 Midnight 各 6、distinctPeriodCount 3、alreadyFiledWithValidPeriod 6，filingPeriodsVerified true，source / run 与 run / run 可比且 PairEqual / MultisetEqual true。仅核实这 6 行已申报记录，已进入纳税人信息查询页，业务数据捕获不足，总任务未完成。
>
> 本机已见 skssqq / skssqz / skssqzqz 在 6 行均为 string，旧白名单漏保留；此前 period missing 是未采入 / 未核实，不能说接口未返回。6 行均已申报，更正 / 作废 / 财报报送入口封锁，待办请求失败不当空。已扩私有期间 3 / 企业 6 字段，保持旧文件和版本兼容，旧缺日期不可比；已申报 filingPeriodsVerified 与当前待办 periodVerified / currentPendingPeriodVerified 分开，后两项及 businessScopeVerified / projectionComplete 仍 false，完整 profile / full business 仍缺。已发现唯一纳税人信息查询 / 申报信息查询菜单及固定同源路由，正常导航原型独审 30 项通过，新 JS private 隔离、safeAssetRefs[]；已沿有效菜单一次正常 Page.navigate 进入纳税人信息查询，前2+后1共3 identity complete、documentScopeVerified / identityProjectionMatched true，无保留锁；首轮业务捕获不足，正调整 ignored 采样优先业务 XHR / Fetch、暖缓存再观察，未预填第二次结果，申报查询页仍未进入。root 已用新纯采集后端完成字段实采，仅重启不拥有浏览器的 collector 加载格式补丁，登录 owner 后端 / 浏览器保留。恢复只查本 worktree ignored checkpoint；原值 / 凭据只本机，安全 refs 不入 Git，正常导航授权有效，自动点击及业务写禁止。

核心“门户契约 + 真实复采”已随 [PR #29](https://github.com/huxiaoyang-code/youshu-fork/pull/29) 于北京时间 **2026-10-20 13:44:12**（UTC `2026-10-20T05:44:12Z`）合并。最终 head `c1d663a7b107f8538e01100a37c0b1102b9c02aa`，merge `bdc6e9a1c26835889d873ea0af1c57ac35d292ce`；管理者已 fetch 核对，最终独立审查与 head 一致性核对通过。

> **2026-10-20 当前包：[TAX-COLLECTION-REBASE](TAX-COLLECTION-REBASE.md)**（[契约](../TAX-COLLECTION-CONTRACT.md)、[交接](../handoffs/TAX-COLLECTION-REBASE.md)），负责人 `huxiaoyang-code`；分叉基线 `0345046ce40b644f26d4ea52adb362d040533bc2`，独立分支 `codex/huxiaoyang-code/tax-collection-rebase`。新 source 已成功 4 passive + 1 active identity verify，新 context / loader、scopeRevision 0、身份投影匹配、新锁释放，实际 wire `Csbz` 匹配。原 MCP stdio → 隔离 HTTP → Agent → 后端两次各 3 fresh 请求均 performed / complete，合计 6 个、不同 run；source / run 与 run / run 三项投影比较全 true，`independentRequests = true`，各 6 行，字段异构（曾最大 32，`zspmDm` 4 / 6 行）。documentScopeVerified true，businessScopeVerified / enterpriseVerified / periodVerified / projectionComplete 均 false，缺 business_period / full_enterprise_profile / full_business_fields。管理者最终 npm test 23 / 23 套及新增合成 54 项均 exit 0；独立 reviewer 未参与实现且不继承实施上下文，代码无剩余阻塞，最终独审与 head 一致性核对已通过，核心 PR #29 已合并。整个专项未完成，后续已授权沿真实同源业务页补期间 / 资料；非等待用户输入，旧 provisional 已废弃，历史废弃锁非当前阻塞。旧 19 项未提交文件哈希未变、旧 owner / browser / quarantine 保留。恢复仅查本包 worktree 的 `.agent-runs/TAX-COLLECTION-CHECKPOINT.json`；安全引用不入 Git / PR，原始本机标识、调试信息、业务原值与凭据不入模型 / Git，禁止自动点击。下方其他任务按历史阅读。
> **当前后续阶段（核心合并后）**：新 source 刷新已成功 4 passive + 1 active identity verify。`candidate_only` 忽略目录原型经独立审查、49 项合成通过后，管理者实际 prepare 在 `identity_before` 失败；performed 计数 0 不代表没有尝试。未导航、未形成 candidates，新 `business_page_prepare` scope 锁保留，正在审查安全诊断 / 受控 reload 恢复。这是后续原型新状态，不是核心历史锁复发，不影响核心两次 MCP 已验结果；整个专项继续未完成，不等待用户补授权。
> **2026-10-20 当前包：[TAX-SESSION-DISCOVERY](TAX-SESSION-DISCOVERY.md)**（[交接](../handoffs/TAX-SESSION-DISCOVERY.md)），负责人 `huxiaoyang-code`；原实施分支 `codex/huxiaoyang-code/tax-session-discovery`、基线 `17a053bfb66b482064ed92aa343ab42c41d47825`。连接前置与 DTO 去重修复已随 **[PR #27](https://github.com/huxiaoyang-code/youshu-fork/pull/27) 于北京时间 2026-10-20 01:00:33 合并**，merge `73ee241648fb70711af21f8bdae49ed2f6680ab7`；完整 head `a07c93a3657a9aaade5d44562a85f615327a82dd` 的 17 文件独立最终复核通过、无剩余阻塞，17 套全量通过，不冒充第二账号批准。实际 MCP → 后端 → 专用 Edge open / 未登录 probe / close 已通过，但业务请求 / 成功 0、第二遍业务采集未运行，真实专项未完成。用户登录遇到问题待说明，专用 Edge / 临时后端已关闭，原官方页保留；不要求点击探索。范围见[原登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6272100523)与[扩展登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6272266944)，下方旧入口保留追溯。

> **2026-10-19 当前实施包：[TAX-READONLY-TOOLS](TAX-READONLY-TOOLS.md)**（[交接](../handoffs/TAX-READONLY-TOOLS.md)），负责人 `huxiaoyang-code`，原实施分支 `codex/huxiaoyang-code/tax-readonly-tools`，分叉基线 `158e266b3cb931b91d03a6e548a2d49dc8188481`。状态：**工具前置包已合并交付；真实身份读取失败，专项未完成**。[PR #25](https://github.com/huxiaoyang-code/youshu-fork/pull/25) 于北京时间 2026-10-19 23:52:57 合并，merge `6df9404bab79e001526d30c21cccbc5679a88a80`；15 套 530 项通过，独立复核候选 `64f66f94024104e3f1a57f0396360b49baabb708` 的18 文件无剩余阻塞，不冒充第二账号批准。文档收尾分支 `codex/huxiaoyang-code/tax-readonly-handoff` 基于该 merge；原[范围登记](https://github.com/huxiaoyang-code/youshu-fork/issues/20#issuecomment-6270683815)保留。
>
> 用户不希望点击探索，当前已依据加载代码 / performance 证实身份读取路径，3 次限量浏览器请求均 HTTP 200 / code `9997`，但缺身份字段；不猜码意、首次业务成功 0、后端第二遍未运行，企业 / 期间未知。Network.disable 成功，观察结束，官方页保持打开，无导航 / 点击；不再等待人工点击。5 工具仅进程内元信息 / 缺项，真实适配器、持久业务证据与可提交包均未交付，接入数仍 0。本包不执行正式申报、财报报送、缴款、更正、作废或备案变更，PR #18 / #19 与总任务均保留。下方旧响应 0 / 等待点击 / 纯文档等按历史阅读。

> **2026-10-19 当前优先任务：[TAX-DATA-FIRST](TAX-DATA-FIRST.md)**，负责人 `huxiaoyang-code`，关联 Issue #20 / #13 / #14 / #17。状态：**方案已形成、待真实取数验证**；用户已提供本机登录页，Edge 菜单已观察，网络 CDP 连续超时，**新业务响应 0、真实采集未完成**。按新账号 / 新公司申报准备目标获取数据、准备材料、预填校验，冻结版本经用户确认后正式提交；缺账务先用现有本地账套，其余列补项。详见[完整方案](../TAX-DATA-ACQUISITION-PLAN.md)。
>
> 会计核心、持续导入、文件报表等本地扩建暂停，旧 16 包保留为后备；A1、PR #22 / #23 已合并，439 项只作历史验证。本次纯文档不重跑业务测试，PR #18 Draft / #19 OPEN、Issue #20 / #13 / #14 / #17 OPEN 保留。下文“当前任务”与暂停说明均为旧时点记录，不能覆盖本入口；有限只读盘点已有授权，无需再次请求同一恢复授权，自动点击仍禁用。

> **2026-10-19 接管首包已合并、业务修复已交付**：[VOUCHER-AMOUNT-GUARDS](VOUCHER-AMOUNT-GUARDS.md)（[Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)，唯一负责人 `huxiaoyang-code`）；[本包交接](../handoffs/VOUCHER-AMOUNT-GUARDS.md)；[16 包接管计划](../DEVELOPMENT-TAKEOVER-PLAN.md)。[PR #22](https://github.com/huxiaoyang-code/youshu-fork/pull/22) 于北京时间 2026-10-19 22:12:36 合并，merge `0dee7655ab348e20293fed006fc6075c02a42ad4`。管理者独立全套 11 套 439 项、exit 0；按用户本轮明确授权，由未参与实现、无历史上下文的另一个独立 subagent 复核最终 head 后合并，证据详见交接，不宣称跨人类成员或 GitHub 第二账号批准。其余包未完成，本轮不启动新包；Issue #13 / #14 / #17 / #20 仍 OPEN，真实税局 checkpoint 继续暂停。本条为当前首包索引，下文旧分工和“仅交接文档”状态保留作历史记录。

> 本文件是**任务分配与认领的权威规则**；具体任务单在 `docs/tasks/`，远端载体是 GitHub **Issue**（模板 `.github/ISSUE_TEMPLATE/requirement.md`）与 **PR**。
> 任务状态以 **GitHub Issue / PR + 本看板 + 版本化交接** 为准，**不以聊天、本机磁盘或 `.agent-runs/` 为准**。

## 0. 全量开发接管入口（2026-10-19 用户最新指示，优先于下文历史分工）

用户已把**全部后续开发**交给同事在**另一台电脑**的 Codex 接手，继续向同一私有仓库 `https://github.com/huxiaoyang-code/youshu-fork` 提交；**沿用 `huxiaoyang-code` 账号**，不另找用户名、不 fork、不另建仓库。**不复制**原机器 token / config / session / 账套 DB；目标机由用户自行登录、按已有授权独立配置。

- 接管任务单：[FULL-DEVELOPMENT-TAKEOVER](FULL-DEVELOPMENT-TAKEOVER.md)；自足交接：[../handoffs/FULL-DEVELOPMENT-TAKEOVER.md](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md)；税局登录后 checkpoint：[../handoffs/TAX-POSTLOGIN-CHECKPOINT.md](../handoffs/TAX-POSTLOGIN-CHECKPOINT.md)。
- 交付目标为**最新业务 PRD 全部范围**（[PR #18](https://github.com/huxiaoyang-code/youshu-fork/pull/18) head `346e1c307379e9a6bf96ef34244dee154558777f`，Draft，未合并进 main）；漳州先验收 ≠ 全国完成。
- 远端载体：**总接管 [Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)**（OPEN，assignee `huxiaoyang-code`）；业务 Issue #13 / #14 / #17 仍 OPEN（旧 assignee 未变、未关闭）；子 PR 用 `Refs #20` 并按业务 `Refs #13` / `Refs #14` / `Refs #17`。
- **旧 A / B 分工与本看板下文现有分工属历史快照**，不再限制接手者；Issue #13 / #14 / #17 保留、**不自动关闭**，也**不假定**旧机器已停止；开工前在 GitHub 核对在途 PR 并登记同名文件，**接管授权已由用户确认，不需要再次确认切换审批**，只在发现实际冲突或未停的同文件实施时协调，**不因同一 GitHub 账户推断技术互斥**。
- `huxiaoyang-code` 既有自动合并授权继续有效，仍须独立内容审查 / 影响验证 / 共享变更串行整合；**不是** GitHub 第二账号 review；真实外部提交仍按 PRD 操作前批次确认。自动点击浏览器 / 点击脚本路线已被用户**永久否决**。

## 1. 权威认领规则

1. **远端可见**：每个任务对应一个 GitHub Issue；开工前查看其 **assignee / 标签 / 状态 / 关联 PR**。
2. **唯一持有人**：同一共享文件（见 [团队协作协议 §6](../TEAM-COLLABORATION.md)）在任一时刻**只能有一个任务**声称编辑；由项目负责人在 Issue 上确认。
3. **禁止本地锁**：仅存在本机的编辑表格、worktree 目录或聊天约定**不能**当作全局锁。
4. **先拉基线**：`git fetch origin` 后基于最新 `origin/main` 建 `codex/<member>/<task>` 分支。
5. **初始状态**：新建任务一律从**「已分配 / 待开工」**开始，**不是「开发完成」**；`Refs #13` / `Refs #14` 关联子 PR，**不因 A0 / B0 完成就 Closes 总任务**。
6. **认领需登记**：在本看板「当前任务」表中登记 assignee、状态、分支与关联 Issue / PR（由管理者或任务持有人更新）。

## 2. 状态定义

| 状态 | 含义 | 允许的下一步 |
|---|---|---|
| 已分配 / 待开工 | 需求与验收已确认，尚未写代码 | 建分支、开工 |
| 开发中 | 本机执行员工正在实现并自测 | 提交审查 |
| 审查中 | 本机 Codex 在读 diff / 跑验证 / 核对边界 | 合并或退回返工 |
| 已合并 | PR 已合并，交接已更新 | 归档，开下游任务 |
| 阻塞 | 依赖未满足 / 需真实账号 / 需授权 | 记录阻塞路径，做可并行前置 |

## 3. 总任务 Issue（2026-10-16 管理者实测）

| 总任务 Issue | 工作包 | 业务承接人 / assignee | 状态 |
|---|---|---|---|
| [#13](https://github.com/huxiaoyang-code/youshu-fork/issues/13) | RC-A-LOGIN-DATA（RC-0 / RC-1 / RC-2a / RC-2b 与数据处理集成） | 负责人 `huxiaoyang-code`（assignee 已实际绑定） | OPEN |
| [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) | RC-B-REPORTS（RC-4 / RC-5 与报表口径盘点） | 同事 `xiaoyihaishiaini`（assignee 已实际绑定） | OPEN |

> 子 PR 用 `Refs #13` / `Refs #14`；**只有总任务所有验收完成才关闭总 Issue**，避免总 Issue 被误当作所有子步骤都已完成。新子需求可另开 Issue 并链接总任务。本轮**本地员工未代发 Issue**；上述总任务 Issue 由管理者建立。

## 4. 当前任务

| 任务 ID | 负责人 | 范围 | 状态 | 依赖 | 任务单 |
|---|---|---|---|---|---|
| LOCAL-01 增量导入与批次幂等 | `huxiaoyang-code` | 规范企业身份（一企一账套）+ 批次 ID + 来源凭证指纹；首次建账与指定已有账套追加；同批幂等 / 跨批去重 / 修订与凭证状态结构化冲突 / 逐张批次追踪；单事务与迁移前备份（Issue #43，基线 `0c4e0dd`，分支 `codex/huxiaoyang-code/local-01`） | 初始增量 [PR #46](https://github.com/huxiaoyang-code/youshu-fork/pull/46) 已合；[Issue #61](https://github.com/huxiaoyang-code/youshu-fork/issues/61) 全入口一企一套 / 成功回放优先未完，整包未完成 | 无（首个可开工包） | [LOCAL-01](LOCAL-01.md) · [八包总览](INDEPENDENT-PRODUCT-WORK.md) |
| LOCAL-02 金额 / 期末完整性 | `huxiaoyang-code` | 金额精度与舍入（分精度 + ROUND_HALF_UP）、资产卡片与总账核对与补项、期末检查与封账前置、反操作 / 前期变动与卡片维护守卫、schema v4（Issue #47，基线 `1a15bcce`，分支 `codex/huxiaoyang-code/local-02`） | **已验收合并**：[PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60) 于 2026-10-22T13:34:48Z MERGED，merge `dfefae0`，最终文档 head `18aa6fb`（tree `1d2a4b8` = merge tree），Issue #47 CLOSED；核心 `bd05415`、输出 `3a8ae7a`、备份精确 98a 各自独审接受；root 在精确 98a 实跑 55 / 55 套 exit 0、Office 21 / 21、11 PDF、备份 22 / 22（最终 head 18aa6fb 未重跑这些套件） | LOCAL-01 | [LOCAL-02](LOCAL-02.md) · [契约](../ACCOUNTING-PERIOD-INTEGRITY.md) · [交接](../handoffs/LOCAL-02.md) |
| LOCAL-03 双准则与辅助核算 | `huxiaoyang-code` | 两套准则科目 / 报表映射与兼容迁移；项目 / 部门 / 往来维度贯通 | R3窄修 `c3c2b2ba` 获fresh独审接受，未合main；旧accountRows漏contra P2、v5备份 / 入口及辅助未完；[Issue #64](https://github.com/huxiaoyang-code/youshu-fork/issues/64) 辅助已登记未实施 | LOCAL-01 / LOCAL-02 | [INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md) |
| LOCAL-04 银行流水与对账 | `huxiaoyang-code` | 本地流水导入 / 去重 / 匹配 / 人工确认 / 差异与未达项；不接银行网站 | [PR #63](https://github.com/huxiaoyang-code/youshu-fork/pull/63) 仍Draft；fresh调用方P1未修，仅复用已审guard；4套入口待08合main后登记 | LOCAL-01 批次语义、LOCAL-03 契约 | [INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md) |
| LOCAL-05a 内部 Excel/PDF 导出 | `huxiaoyang-code` | 独立 Excel/PDF 导出模块及接线，复用稳定报表 DTO（Issue #45） | Office接线已合 [PR #62](https://github.com/huxiaoyang-code/youshu-fork/pull/62)；05b仍未完成，不能记整05完成 | 可并行 | [INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md) |
| LOCAL-05b 报表准确性 | `huxiaoyang-code` | 双准则映射、复杂现金流、独立金额核验 | 随03补双准则、复杂现金流及独立金额核验，未完成 | LOCAL-02 / LOCAL-03 | [INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md) |
| LOCAL-06 审计、备份恢复与本机交付 | `huxiaoyang-code` | 账务关键动作审计、SQLite 一致性备份 / 恢复（**v3 / v4 扩展已随 PR #60 合并**）、版本化迁移回退、Windows 安装升级验证 | 备份PR55、v3/v4扩展PR60、审计A PR58已合；Issue54 B2业务接线 / 现库安装、真实restore及Issue59 Windows最终交付未完 | 随持久化设计同步 | [INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md) · [备份契约](../LOCAL-BACKUP.md) |
| LOCAL-07 持久批量任务与 CLI | `huxiaoyang-code` | 多账套持久批量任务、阶段检查点、逐账套结果、重启恢复、去重与 CLI | B1 [PR #65](https://github.com/huxiaoyang-code/youshu-fork/pull/65) 已合，已审head `37bcb286` / merge `97384868`；W3现库安装 / 共享互斥与W4真实恢复分叉未完 | LOCAL-01 / LOCAL-02 / LOCAL-06 | [INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md) |
| LOCAL-08 普通财务工具数据输出边界 | `huxiaoyang-code` | 本机查看与模型工具输出区分、最小化摘要 / 受控引用 / 明确错误（Issue #44） | 基础PR50/57/60已合；当前31文件整合候选纳入PR65，原59追加07两套静态61；最终全61 / fresh独审 / PR合并待root，Issue44 OPEN | 独立模块，可与 LOCAL-01 并行 | [INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md) |
| TAX-EDGE-DOWNLOAD-FIX | `huxiaoyang-code` | 移除旧后端专用 Edge 的 `--inprivate`，诊断改兼容 owned InPrivate / normal | 代码 + 管理者回归完成（test-all 44 / 44），独立审查中，真实下载待用户反馈，PR 未创建 | 用户人工登录后同条件复验 | [TAX-EDGE-DOWNLOAD-FIX](TAX-EDGE-DOWNLOAD-FIX.md) |
| TAX-HISTORY-COLLECTION | `huxiaoyang-code` | 固定历史查询、私有账册、两轮实际 MCP 与比较 | 受限 M1 子包已独立审查并随 [PR #38](https://github.com/huxiaoyang-code/youshu-fork/pull/38) 合并；完整 M1 未完成 | 项目 / 稳定身份版本 / 字段依赖待核；M2–M5 待办 | [TAX-HISTORY-COLLECTION](TAX-HISTORY-COLLECTION.md) |
| TAX-COLLECTION-REBASE | `huxiaoyang-code` | 门户契约、新 source、两次真实 MCP 复采 / 比较 | 核心已合并 PR #29；23 套 / 54 项通过，真实两次六请求 / 各六行，投影相等；整个专项仍 partial | 合并后交接；后续 candidate_only 原型 identity_before 失败、新 prepare 锁待安全诊断 / 受控恢复 | [TAX-COLLECTION-REBASE](TAX-COLLECTION-REBASE.md) |
| TAX-SESSION-DISCOVERY | `huxiaoyang-code` | 本机专用 Edge 后端通道、真实会话探索、DTO 去重修复 | 连接前置已合并 PR #27；17 套通过，真实业务未取得 | 用户登录问题、有效企业 / 期间与实际业务契约 | [TAX-SESSION-DISCOVERY](TAX-SESSION-DISCOVERY.md) |
| TAX-READONLY-TOOLS | `huxiaoyang-code` | 真实只读探索、agent / MCP 准备工具、合成验收 | 工具前置已合并 PR #25；530 项通过，真实专项未完成 | 当前身份 / 期间及真实契约 | [TAX-READONLY-TOOLS](TAX-READONLY-TOOLS.md) |
| RC-A · RC-0 第一步 | 项目负责人 `huxiaoyang-code` | `TAX-BROWSER-REVIEW` 隔离快照与合成复验 | 已分配 / 待开工 | 无 | [RC-A-LOGIN-DATA](RC-A-LOGIN-DATA.md) |
| RC-A · RC-1 | 项目负责人 | 登录会话、办税员身份 → 授权企业 → 账套关联 | 已分配 / 待开工 | RC-0 第一步 + 第二步 | 同上 |
| RC-A · RC-2a / RC-2b | 项目负责人 | 目标账套定向导入、数据落地与重试、最小恢复 | 已分配 / 待开工 | RC-1 | 同上 |
| RC-B · B0 | 同事 `xiaoyihaishiaini` | 报表现状 / 独立金额样例 / 官方模板来源盘点；导出 DTO / 错误契约 | **已交付**（随 PR #15 合并，见 [RC-B 交接](../handoffs/RC-B-REPORTS.md)） | 无 | [RC-B-REPORTS](RC-B-REPORTS.md) |
| RC-B · B1 | 同事 | `report-export` 五类内部 CSV 导出与 HTTP / 页面集成（RC-4 前置） | **已交付**（PR #15 合并 `c2d5619`；完整 RC-4 验收仍依赖 RC-3 接线，[REPORT-EXPORT](../REPORT-EXPORT.md)） | B0 | 同上 |
| RC-B · B2 | 同事 | `tax-report-format.mjs` 税局申报可上传文件（RC-5 前置） | **未完成**；已有法定结构参考 / 勾稽与就绪性阻断，缺适用地区 / 准则 / 模板版本 / 上传格式，导出返回 422 `tax_template_unverified` | B0 + 官方模板核实 | 同上 |
| RC-3 | 项目负责人统一协调 | 会计核心 / 口径缺口；按 B 的发现另开聚焦任务 | 已分配 / 待开工 | RC-2a / RC-2b | [RC-A-LOGIN-DATA](RC-A-LOGIN-DATA.md) |
| RC-6 | 项目负责人统一协调 | 端到端联调与交付 | 已分配 / 待开工 | RC-4 + RC-5 | [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) |

**并行说明**：B0 已完成；B1 / B2 的**纯模块与合成 DTO 测试**可基于已协商 DTO 在 RC-3 完成前先行开发，**完整集成验收**才依赖 RC-3 与接线。RC-4 / RC-5 的**完整验收**依赖 RC-3 与真实官方模板，「**可以并行做前置**」不等于「**已经通过完整闭环**」。官方目标地区 / 准则未核实时一律记为**未知**，不得自称申报可用；内部 CSV 导出不等于税局申报可用文件。

## 5. 任务单必填字段

见 [任务模板](TEMPLATE.md)。每份任务单至少包含：需求与验收结果、文件所有权与共享改动协商、依赖 / 基线、成员与执行员工模型、Codex 独立验证、真实数据边界、验证 head、自动合并权限 / 协调记录、回退与交接。

## 6. 文件所有权速查

- **共享受控**：`accounting.mjs` / `coa.mjs` / `db.mjs` / `server.mjs` / `agent-tools.mjs` / MCP 注册 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享状态索引；同一时刻唯一编辑责任人。
- **B 专属**：`report-export`（RC-4）、**`tax-report-format.mjs`**（RC-5，`tax*` 规则的模块名专属例外）。
- **A 负责**：`tax*` 税务采集 / 登录 / 会话（`tax-gateway.mjs`、`tax-browser*.mjs`、`tax-import.mjs`）与 `import*` 定向导入。
- 完整规则见 [团队协作协议 §6](../TEAM-COLLABORATION.md)；共享接线走独立集成 PR 或申请短期文件所有权。

## 7. 合并协调

- 合并前核对最新 `origin/main`；基线变动**重验受影响范围**；锁定已验证 head 再合并。
- **GitHub 不能原子锁 base**：两个 PR 基于不同基线时，共享关键变更**串行合并**；可用远端 Issue 标注当前整合人，但**不声称评论等于技术互斥**。
- 成员可在满足验收与整合约束后**自动合并自己的 PR**；该授权**只适用已确认 / 登记且经项目负责人授权的成员及其任务**，新贡献者不能自授权。跨成员评审按任务风险与共享文件需求安排（见 [团队协作协议 §8](../TEAM-COLLABORATION.md)）。
- **2026-10-23 当前 root 持 main 整合锁**：Office PR62与批量B1 PR65已合；[Issue44精确共享窗口](https://github.com/huxiaoyang-code/youshu-fork/issues/44#issuecomment-6357299894) 当前只做入口 / 交接，静态61套待最终验收。银行PR63四套须基于08实际main另开窗口；历史先银行后08计划已被后发授权覆盖，不表示其他共享文件自动释放。

## 8. 相关文档

- [团队协作协议](../TEAM-COLLABORATION.md) · [项目章程](../PROJECT-CHARTER.md)
- [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) · [阶段状态](../handoffs/STATE.md)
- [成员入场包](../handoffs/MEMBER-ONBOARDING.md) · [交接模板](../handoffs/TEMPLATE.md)
