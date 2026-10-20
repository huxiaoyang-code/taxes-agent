# 任务看板 · TASK BOARD

> **2026-10-20 当前子包：[TAX-HISTORY-COLLECTION](TAX-HISTORY-COLLECTION.md)** · [契约 / 安全资料对照表](../TAX-HISTORY-COLLECTION.md) · [交接](../handoffs/TAX-HISTORY-COLLECTION.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #14 / #17。固定历史查询代码与两轮真实 MCP 验证通过（各 3 fresh / 3 complete，6 行 / 2 期间，unknown 0，无保留锁，比较一致），文档 / 最终 PR 审查与合并待完成。仅受限 M1 查询子包，完整 M1 的项目 / 稳定身份版本 / 字段依赖与 M2–M5 未完成。用户已登录完成，新链已建；PR #35 仍独立 Draft 未合并，不宣称企业三 API 已复采。下方月度文档及旧包状态保留历史。

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
| TAX-HISTORY-COLLECTION | `huxiaoyang-code` | 固定历史查询、私有账册、两轮实际 MCP 与比较 | 受限 M1 子包代码 / 真实验证通过；本包 PR 尚未创建 / 合并，完整 M1 未完成 | 项目 / 稳定身份版本 / 字段依赖待核；M2–M5 待办 | [TAX-HISTORY-COLLECTION](TAX-HISTORY-COLLECTION.md) |
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

## 8. 相关文档

- [团队协作协议](../TEAM-COLLABORATION.md) · [项目章程](../PROJECT-CHARTER.md)
- [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) · [阶段状态](../handoffs/STATE.md)
- [成员入场包](../handoffs/MEMBER-ONBOARDING.md) · [交接模板](../handoffs/TEMPLATE.md)
