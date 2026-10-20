# 新会话入口 · NEXT SESSION

> **2026-10-20 当前包：[TAX-BUSINESS-COLLECTION](../tasks/TAX-BUSINESS-COLLECTION.md)** · [交接](TAX-BUSINESS-COLLECTION.md) · [契约](../TAX-COLLECTION-CONTRACT.md)。负责人 `huxiaoyang-code`，Refs #20 / #13 / #14 / #17。分支 `codex/huxiaoyang-code/tax-query-data`，基线 PR #34 merge `1c12f98bafc38d257482f35f268e7f14d2dbd156`；当前 HEAD `c820b7778c903b3a9dac57f31a93545efa3c7564` / tree `39e78e5115b529da17741ff9dc343b27db23f12e`。恢复 / guard 七文件与末两文件 surface 已独审，root 最终受影响 121 项（query 72 + retire 44 + MCP 5）及最终完整 npm test 29 / 29 套 exit 0；最终独立 delta 44 项及先前 query 72 / MCP 5 通过。准备当前代码和真实失败状态的草稿 PR，不 ready、不 merge、不宣告本轮交付或专项完成。
>
> 当前 query_context_refresh 退役已有 prepare + commit：实际 diagnose 确认 ownerDead / exactScope / cleanup true；execute scope 校验失败，retirementCommitted true、lockRetired / realmDestructionProven / cleanupConfirmed false、resumeRequired true。旧链永久不可消费，没有 realm / finish 通过证据。一次固定 loginb 正常导航有多次 mainframe / clear / detach / within_document，未判成功，不追认失败事件为证明。原标签随后只读分类仅确认已跳统一认证域，具体页面 / 是否需重新登录待用户确认；已异步请用户在现有窗口进入目标企业首页并告知 root。tpass_login 是整个认证域分类，routeCode unknown，不能断言已证明登录失效或确定登录页，不推测 session 清除原因；随后无新增 fetch / 导航。
>
> 等待用户确认后，root 先只读确认精确已知 portal / 稳定 scope，再按同一 prepare + commit 显式 resume，以新一次正常导航证明旧执行 realm 销毁、清理及 finish；不重开事务、不放宽 redirect / hash / scope 守卫。unknown_abandoned / late session effects possible 始终保留，不消费旧链迟到结果。新 source / context / run 均未建，三企业业务 / MCP 成功仍 0，currentPendingPeriodVerified / periodVerified / businessScopeVerified / projectionComplete 仍 false。纯采集 backend 不因磁盘 commit 自动重载，当前未重启；新版退役运行是独立本机 admin。恢复无锁后，MCP 实采前仅更新纯采集 backend 到经审版本，绝不重启 browser owner。
>
> 历史业务证据仍分开：PR #34 门户 MCP 两轮各 3 fresh / 3 complete / 6 行，六行已申报、3 期间、投影相等；企业资料三个 API 仅页面捕获 / 本机诊断，准确 enum literal_parameter / current_session 已实现，保留两 POST 原空 djxh，以捕获 helper / profile 自身企业字段核验，不填 query。真正申报查询 document `/szzh/zhcx/sbxx/sbxxcx` 单 ruuid、无 hash，当时 3 identity 同企业且无锁；POST `/szc/szzh/sjswszzh/zhcx/v1/DescribeSbmxcx2` 无 query / body 9 键，PageNumber 1 / PageSize 10 / Total 6 / List 6，13 字段齐、strict validPair 6 / 不同期间 2，与门户六行的期间对及多重集不等。仅 observed_request + schema，业务语义 / 当前待办 / 后端接入未验，不按相同行数混记录。新 JS quarantine，safeAssetRefs []；不无界扩 profile / full business，人员、操作人、银行账号默认不采。root 独占真实会话 / Git，恢复只查本机 ignored checkpoint；原值 / 凭据 / 实际 refs / nonce / 运行时参数不入模型或 Git。正常导航授权有效，owner / browser 不盲重启，自动点击永久禁止、业务写禁止。

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

本机**单用户**财税工作台，可对多个企业 / 账套批量处理；**不做多租户 / SaaS / 租户权限平台 / 对外服务**（开发多人不改变产品形态）。只保留账套隔离、操作日志、备份恢复、凭据安全等本机需要。全国电子税务局是产品目标，当前只有预留接口、真实接入 0。详见 [章程](../PROJECT-CHARTER.md) 与 [ROADMAP](../ROADMAP.md)。

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

方向仍为本机单用户、可多账套批量；不做多租户 / SaaS / 对外服务。全国电子税务局真实接入 0。
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

边界：产品本机单用户、可多账套批量；不做多租户 / SaaS / 对外服务；全国电子税务局真实接入 0；
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
