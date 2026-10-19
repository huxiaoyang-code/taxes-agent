# 阶段状态

> **2026-10-19 接管首包审查中**：[VOUCHER-AMOUNT-GUARDS 交接](VOUCHER-AMOUNT-GUARDS.md) · [任务单](../tasks/VOUCHER-AMOUNT-GUARDS.md) · [全范围接管计划](../DEVELOPMENT-TAKEOVER-PLAN.md)。当前基线 `654a403b78f9fe91166d5c8de62d8f15103065b7`，基线验证 10 套 336 项、exit 0；唯一负责人 `huxiaoyang-code`。本轮用户已授权并发 Codex subagent 替代本地 agent；首包实现、管理者内容审查及独立验证完成（11 套 439 项、exit 0），跨成员复核条件待满足，PR 待创建、未合并；真实税局 checkpoint 继续暂停。下文“仅交接文档”及旧机器现场均为历史记录，不代表本轮停止开发。

> **2026-10-19 全量开发接管入口（用户最新指示，优先于下文全部历史内容）**：用户已把**全部后续开发**交给同事在另一台电脑的 Codex 接手，继续向同一私有仓库 `https://github.com/huxiaoyang-code/youshu-fork` 提交；**沿用 `huxiaoyang-code` 账号**，不 fork、不换用户名、不新建仓库；**不复制**原机器 token / config / session / 账套 DB。本次**只交接文档，原机器不新开业务实现**。
>
> - 接管交接（自足）：[FULL-DEVELOPMENT-TAKEOVER](FULL-DEVELOPMENT-TAKEOVER.md)；任务单：[tasks/FULL-DEVELOPMENT-TAKEOVER](../tasks/FULL-DEVELOPMENT-TAKEOVER.md)；税局登录后 checkpoint：[TAX-POSTLOGIN-CHECKPOINT](TAX-POSTLOGIN-CHECKPOINT.md)。
> - 交付目标为**最新业务 PRD 全部范围**（[PR #18](https://github.com/huxiaoyang-code/youshu-fork/pull/18) head `346e1c307379e9a6bf96ef34244dee154558777f`，Draft，未合并进 main；只读查看命令见接管交接）；漳州先验收 ≠ 全国完成。
> - `huxiaoyang-code` 既有「自审验收后自动合并」授权继续有效，但须独立内容审查 + 影响验证 + 共享变更整合约束，**不是** GitHub 第二账号 review；真实外部提交仍按 PRD 在操作前批次确认。**自动点击浏览器 / 点击脚本路线已被用户永久否决。**
> - 远端载体：**总接管 [Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)**（OPEN，assignee `huxiaoyang-code`）；业务 Issue #13 / #14 / #17 仍 OPEN（旧 assignee 未变、未关闭）；子 PR 用 `Refs #20` 并按业务 `Refs #13` / `Refs #14` / `Refs #17`。
> - **下文的 A / B 分工与旧现场状态属历史快照**：不得当作最新事实；Issue #13 / #14 / #17 保留、**不自动关闭**，也**不假定**旧机器工作已停止；开工前须在 GitHub 核对在途 PR / 成果并登记同名文件；**接管授权已由用户确认，不需要再次确认切换审批**，只在发现实际冲突或未停的同文件实施时协调。
> - 可核验现状（管理者已核对）：main `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`，2026-10-19 在 `06-workbench` 跑 `npm test` 为 10 套 336 项、exit 0（合成临时库，无真实 DB；**不是 CI**）；本次仅文档，不重复跑业务套件。PR #18（Draft，head `346e1c3…`）与 PR #19（OPEN，head `a47a53c…`）均在途，不合并进本交接任务。

> 2026-10-16 团队交接与 PR #15 当前补充：同事 PR #15 已合并（main `c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0`，mergedAt `2026-10-15T15:40:41Z` 即北京时间 10-15 23:40），B0 / B1 五类内部 CSV、HTTP 下载与页面预览已交付；B2 税局可上传申报文件、RC-3 / RC-6 仍未完成。**以下历史阶段结论不因此改写；旧交接中「报表无法导出」的旧表述一律按历史记录看待。** 实际测试与 PR 状态见 [RC-B-REPORTS](RC-B-REPORTS.md)。

更新时间：2026-10-16（第四轮：多人跨电脑协作交接 + 同事 PR #15 合并）。恢复时先核对 Git、PR 和进程；本文件是交接索引，不是实时进程监控。新对话最小入口见 [NEXT-SESSION](NEXT-SESSION.md)。

> **先识别自己是谁**：本仓库已支持**多成员跨电脑协作**。开工前先确认自己的**人类成员身份与已分配任务**（见 [任务看板](../tasks/README.md) 与本人任务单），**不要默认所有机器都接 RC-0**，避免重复派工。负责人 `huxiaoyang-code` 接 [RC-A-LOGIN-DATA](../tasks/RC-A-LOGIN-DATA.md)（总任务 [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)）；同事 `xiaoyihaishiaini` 接 [RC-B-REPORTS](../tasks/RC-B-REPORTS.md)（总任务 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)，RC-B B0 / B1 已交）。角色 / 权限 / 文件所有权见 [团队协作协议](../TEAM-COLLABORATION.md)。

## 方向（不可漂移）

- 本机**单用户**财税工作台，可对多个企业 / 账套做批量处理；**不做多租户 / SaaS / 租户权限平台 / 对外服务**。
- 保留账套数据隔离、操作日志 / 审计留痕、备份恢复、凭据安全等本机实际需要。
- 全国电子税务局仍是产品目标；当前真实接入数 0，预留接口不等于已接入。

## 已完成

| 部分 | 结果 | PR | main 合并提交（短 SHA） | 管理者验证 |
|---|---|---|---|---|
| BASE | 旧账导入、逆向证据和能力盘点形成共同基线 | [#1](https://github.com/huxiaoyang-code/youshu-fork/pull/1) | 1fd8cc6 | 原有 28 项测试、语法和差异检查 |
| MCP | 38 个工具入口，补齐账务接口与真实可用状态 | [#2](https://github.com/huxiaoyang-code/youshu-fork/pull/2) | e168b4a | 原有 28 + MCP 44 项 |
| CORE-A | 封账、期初保护与期间登记 | [#3](https://github.com/huxiaoyang-code/youshu-fork/pull/3) | 3873bf1 | 保护回归 23 + 原有 28 + MCP 44 项 |
| GOVERNANCE | 章程、协作入口和阶段重置交接机制 | [#4](https://github.com/huxiaoyang-code/youshu-fork/pull/4) | bb71a2c | 文档差异、链接与授权核对 |
| CORE-B | 明细报表、零利润/年末结转与折旧一致性 | [#5](https://github.com/huxiaoyang-code/youshu-fork/pull/5) | 91b623a | 派生 31 + 保护 23 + 原有 28 + MCP 44 项；见 [交接](CORE-B.md) |
| TAX | 全国税务接口、异步会话和地区目录，真实接入数 0 | [#6](https://github.com/huxiaoyang-code/youshu-fork/pull/6) | f4d9f82 | 税务 59 + MCP 44 + 原有 28；见 [交接](TAX.md) |
| FLOW | 记账/导入规则、MCP 闭环与统一测试入口 | [#7](https://github.com/huxiaoyang-code/youshu-fork/pull/7) | 03eba00 | 6 套 208 项全部通过；见 [交接](FLOW.md) |
| ACCEPT | 管理者 main 验收与交付文档 | [#8](https://github.com/huxiaoyang-code/youshu-fork/pull/8) | 9783420（PR #8 合并提交；业务验收提交 03eba00） | 在业务提交 `03eba00` 运行 npm test：208/208；技能格式验证通过 |
| LOCAL-BATCH-HANDOFF | 本地执行工作范式与单机批量交接（文档 / Skill） | [#9](https://github.com/huxiaoyang-code/youshu-fork/pull/9) | 8279477 | 文档 / Skill 差异、链接与授权核对；未重跑业务测试 |
| IMPORT-STRICT | 导入严格校验：拒绝非法金额文本，预检与正式写入同一套约束，失败不落库 | [#10](https://github.com/huxiaoyang-code/youshu-fork/pull/10) | 67f5e45 | 2026-10-15 管理者独立复验：`npm test` 7 套 262/262、`npm run test:smoke` 28/28，均 exit 0；见 [交接](IMPORT-STRICT.md) |
| IMPORT-STRICT 交接归档 | IMPORT-STRICT 验收合并与下一任务交接文档 | [#11](https://github.com/huxiaoyang-code/youshu-fork/pull/11) | cc6e789 | 文档变更；管理员已合并（PR #11，2026-10-15），未重跑业务测试 |
| REPORT-CLOSURE-PLAN 重排 | 报表闭环补全方案与交接（RC-0 ~ RC-6） | [#12](https://github.com/huxiaoyang-code/youshu-fork/pull/12) | 8ebc739 | 文档变更；管理员已合并（PR #12，2026-10-15），未重跑业务测试；见 [交接](REPORT-CLOSURE.md) |
| RC-B 报表导出（B0 / B1） | 五类内部 CSV 导出、HTTP 下载与页面预览；税表法定结构参考与就绪性阻断（B2 未完成） | [#15](https://github.com/huxiaoyang-code/youshu-fork/pull/15) | c2d5619 | 同事 PR，mergedAt `2026-10-15T15:40:41Z`（北京时间 10-15 23:40；2026-10-16 为复验 / 核实日期）；管理者复验 `npm test` 10 套 336 项、exit 0（合成临时库无真实数据）；见 [RC-B 交接](RC-B-REPORTS.md) |

**PR #1–#12 与 #15 已合并；Issue #13 / #14 仍 OPEN（不是 PR）**。上表 PR #1–#10 各部分的员工会话在各自验收与合并后已结束（此为**历史阶段**事实，不代表全仓已无未提交的本地工作，也不推断同事电脑进程是否退出；对方 PR 合并 ≠ 该机无运行进程，见下文「未完成现场」）。后续部分采用全新会话，读取当前代码和任务包。

## 本期收尾与恢复

- 就第一阶段（PR #1–#8）而言，实现均已通过审查并合并，相关员工会话已结束；pi FLOW 与 Claude TAX 最后进程退出码均为 0。该结论**只限定该历史阶段**，不覆盖下文「未完成现场」中未提交、未经管理者审查的本地实现。PR #9（文档 / Skill）与 PR #10（IMPORT-STRICT）也已合并（见「已完成」与「本轮 IMPORT-STRICT」）。保留各 worktree 供追溯，不复用旧聊天。
- 第一阶段（PR #1–#8）管理者最终验证的 main 完整 SHA：`03eba00c4fefd065d30f021d19f17f02d48d5d65`。工作目录 `D:/有数云fork/06-workbench`，命令 `npm test`，6 套共 208 项通过、exit 0。PR #8 只同步文档和期间工具说明，不改业务算法。（IMPORT-STRICT 合并后为 7 套 262 项，见「本轮 IMPORT-STRICT」。）
- 本地复核日志 `.agent-runs/main-final-acceptance.log`；任务日志 `pi-flow-review.jsonl` / `claude-tax-review2.jsonl`。原始日志不作为新会话默认上下文。
- 实际工具目录 45 个入口：31 标 available（其中 7 个是税务预留接口）、1 个 limited、13 个 unavailable。入口数量不等于真实税务连接数。

上述临时任务包和日志被 Git 忽略，只在本机存在；跨机器恢复以 PR、源码和本文件中的阻塞说明为准。

## 未完成现场（未提交，待独立审查）

管理者现场发现一处既有未提交实现，**保留原地**、不重置 / 不删除 / 不覆盖 / 不重做，本轮也不把它纳入文档 PR：

- worktree：`D:/有数云fork/.worktrees/tax-browser`
- 分支 / 基线：`codex/tax-browser-import`，基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`
- 状态：**未提交、未 PR、未合并**；内容为福建漳州浏览器登录后读取企业、批量新建或绑定账套的本地草稿，只覆盖该地区，**不能代表全国接入**
- 员工交接：`D:/有数云fork/.worktrees/tax-browser/docs/handoffs/TAX-BROWSER.md`
- 证据边界：员工交接**自报** 7 套 272 项通过、真实税局未验收；管理者**未独立复跑**该套件，**真实登录未验收**
- 进程日志：`D:/有数云fork/.agent-runs/pi-tax-browser.jsonl`；**尚未核实退出码，不能声称 exit 0**，也不要整读该日志
- 本轮核实：该 worktree 原 **14 个未提交文件的内容哈希与本轮开工时一致**（逐文件 SHA256 与 `.agent-runs/import-strict-tax-preservation.json` 清单全部命中），分支 / worktree 保持原样；本轮文档收尾**未触碰**该目录。

新会话派工前先核对上述现场，避免重复派工或误报已完成。`IMPORT-STRICT` 已验收合并（PR #10），不再是待审队列；`TAX-BROWSER` 草稿的复审已列为现行首包 **RC-0**（见下文「后续可执行任务表」），但**草稿本身仍未验收、未合并**，不得当已交付。

## 本轮 LOCAL-BATCH-HANDOFF（文档 / Skill，已核验）

本轮为纯文档 / Skill 变更：本机单用户批量方向、工作范式、权威技能 `team-skills/local-agent-first/` 以及 NEXT-SESSION / STATE 交接。**未改业务代码或算法，未重跑 208 项业务测试。**

- 已验证事实（管理者本机核对）：仓库权威技能已安装到本机 Codex 技能目录 `C:/Users/35007/.codex/skills/local-agent-first/`；本机两处文件 SHA256 与仓库副本一致；`quick_validate.py` 对仓库副本与全局版本均通过；新增 27 个本地 Markdown 链接检查通过；`git diff --check` 通过。安装前的原技能备份在 Git 忽略目录 `.agent-runs/local-agent-first-before-20261014-150009.md`。
- 本轮 pi 初稿 / 返工 / 最后修订 / 未完成现场补充、Claude 独立情境审查均已实际退出、退出码 0；本轮新进程退出码由管理者在该进程结束后核对。tax-browser 历史会话退出码仍**未核实**，不归于本轮。
- **PR 状态（已核实）**：LOCAL-BATCH-HANDOFF 已由管理者创建并合并为 PR [#9](https://github.com/huxiaoyang-code/youshu-fork/pull/9)，main 合并提交 `8279477ad3e49ef1e37cd965db3bb12d719674c9`（`docs: 固化本地执行工作范式与单机批量交接 (#9)`）。恢复时仍以分支、`git log`、远端与 PR 平台**实际状态**为准。
- 安装路径与全局技能校验均为**本机信息**，不承诺其他电脑已安装；换机器需按章程与交接重新核对授权与安装。

## 本轮 IMPORT-STRICT（导入严格校验，已验收合并）

- worktree：`D:/有数云fork/.worktrees/import-strict`，分支 `codex/import-strict`，基线 main `8279477ad3e49ef1e37cd965db3bb12d719674c9`。
- 状态：**已由管理者独立复验并合并**。PR [#10](https://github.com/huxiaoyang-code/youshu-fork/pull/10) 于 2026-10-15 合并，merge SHA `67f5e4541fd05878e3d681638dcb95a9c33b799b`；管理者 `git diff` 已证明 merge tree 等于已验证 head，主工作区 main 已 ff 更新。员工交接见 [IMPORT-STRICT](IMPORT-STRICT.md)。
- 过程历史（保留但不阻塞）：员工初稿→管理者首审不通过（7 项阻塞）→员工返工 1→二轮复审发现 CSV 辅助字段 `dates`/`numberRaw` 绕过→员工返工 2；三轮实施会话均已实际结束，管理者核对退出码为 0。
- 内容：旧账导入严格校验——拒绝非法金额文本（垃圾/部分可解析/`NaN`/`Infinity`/超界/极小负值），负数与超界在舍入前判定；预检与正式写入共用 `normalizeImportPayload` 同一套约束，失败不落库；覆盖金额类型、日期逐行与不一致、凭证号、形状/meta 类型、重复期初、科目/期初/凭证会计约束；保留原始文本后再归一化，不再把非法输入按 0 吞掉。
- 返工要点：完整内容快照断言不污染既有账套；HTTP/Agent 真实入口非法 CSV/JSON 集成回归；共享 `sumMoney` 统一合计；重复期初预检拒绝；金额数组/对象/布尔拒绝；meta 对象不被 String 成垃圾写入；CSV 辅助字段 `dates`/`numberRaw` 不得绕过 `date`/`number`（各自严格类型与语法、两者一致），补 CSV parse→JSON 往返正例；测试用 `PORT=0` 从子进程 stdout 读取实际端口并等子进程退出后清理。
- 管理者复验（事实）：工作目录 `D:/有数云fork/.worktrees/import-strict/06-workbench`；`npm test` 7 套 262/262（guards 23 + derived 31 + import-strict 54 + smoke 28 + contract 44 + workflow 23 + tax 59），exit 0；`npm run test:smoke` 28/28，exit 0；验证后文件 SHA256 锁定（提交前后内容相同），最终验证提交 `aa9f08d33baace25fccf8f4e704de2dbc09d4731`。
- 过程说明（不隐去）：管理者原沙箱内测试最初因本机 HTTP fetch 失败未通过，另一次审批因额度耗尽未执行（非安全拒绝）；用户要求继续后审批获准的全套复验通过。属本机沙箱 / 审批环境问题，不是业务代码错误。
- 不改：幂等 / 批次去重（已归入报表闭环 **RC-2**）、批量队列、UI、税局适配、多租户。

## 本轮 TEAM-HANDOFF（多人协作，文档 / 模板）

用户本轮明确确认：先接入一位同事（GitHub `xiaoyihaishiaini`）；负责人 `huxiaoyang-code` 负责税局登录与数据接入（RC-0 / RC-1 / RC-2a / RC-2b 及数据处理集成，协调 RC-3），同事负责两类报表口径核对与导出（RC-4 / RC-5）。**目前登记并经项目负责人授权的成员为这两人**；各人自己的 Codex 可派本地员工、独立审查验收、提交 / 推送 PR 并**自动合并自己的 PR**（该授权不从通用文档推给新贡献者）。**开发多人不等于产品多租户**。

- 新增（8）：`docs/TEAM-COLLABORATION.md`（团队协议）、`docs/handoffs/MEMBER-ONBOARDING.md`（同事入场包）、`docs/tasks/{README.md,TEMPLATE.md,RC-A-LOGIN-DATA.md}`、`docs/handoffs/TEAM-HANDOFF.md`、`.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/requirement.md`。
- 修改（10）：`AGENTS.md`、`docs/PROJECT-CHARTER.md`、`docs/TEAM-PLAN.md`、`docs/REPORT-CLOSURE-PLAN.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`、本文件、`docs/handoffs/NEXT-SESSION.md`、`docs/handoffs/TEMPLATE.md`、`docs/tasks/RC-B-REPORTS.md`。
- **文件分类说明**：`docs/tasks/RC-B-REPORTS.md` 是 **PR #15 已有任务单的本轮修改**，**不是本轮新增**；本次共 **10 修改 + 8 新增 = 18**，**不新增任何 B 任务单**。
- **本地员工未重跑业务回归作为本变更的证据**；**管理者已在本轮独立复验 PR #15 基线**（`c2d5619`，`npm test` 10 套 336 项、exit 0，合成临时库无真实数据）。
- 任务初始状态为「已分配 / 待开工」，但**不使已交付部分退回**（B0 / B1 已完成，下一阶段 B2）；**本轮本地员工未代发 Issue**；总任务 [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)（负责人）/ [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)（同事，已绑定 assignee）已由管理者建立并分配。
- 远端事实（2026-10-16 实测，未改设置）：private、`owner.type = User`、owner `admin = true`、`main` protected=false、rulesets API 403（需 GitHub Pro 或公开仓库）；本机无 `.github` 工作流，**不称 CI 已存在**；GitHub 写权限技术上也能直接推 main，约定不能技术阻止。同事 `xiaoyihaishiaini` 的 write 权限经管理者 GitHub API 实测。
- 保留：`tax-browser` 14 个未提交文件哈希未变、RC-0 真实接入 0 与 `tax-browser` 原件不变。

本部分员工 pi 会话日志 `D:/有数云fork/.agent-runs/pi-team-handoff-current.jsonl`、退出码文件 `pi-team-handoff-current.exit`（**本机可查，不作为同事先决**）；管理者已核实统一执行 session80422 结果 `exit=0`，即 `pi-team-handoff-current.exit=0`（进程已自然结束，未主动终止任何进程）。tax-browser 历史退出码仍**未核实**，不归于本轮。

## 本轮 REPORT-CLOSURE-PLAN（文档，已由 PR #12 合并）

用户在 IMPORT-STRICT 合并后明确新目标：最终交付为**报表闭环**（导入办税员账号 → 接收并输入验证码 → 登录 → 获取名下企业 / 账套 → 完成所需财务操作 → 生成报表），且**两类报表都需要**：内部 3 表 + 余额表 / 明细账，以及税局财务报表申报格式；前端展示次要。本轮只重新制定代码补全方案并交接，**不实现下一阶段功能**。

- 起点基线 `cc6e789b6b398e78034d17b1e143bcf1bd58053b`（PR #11，IMPORT-STRICT 交接文档）；**该 SHA 是方案起点，不是新会话必须停留的 HEAD**。
- 本轮为**纯文档变更**：新增 `docs/REPORT-CLOSURE-PLAN.md` 与 `docs/handoffs/REPORT-CLOSURE.md`；更新 `docs/PROJECT-CHARTER.md`、`docs/ROADMAP.md`、`docs/TEAM-PLAN.md`、本文件、`docs/handoffs/NEXT-SESSION.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`。**未改业务代码、测试、Skill；未重跑业务测试。**

> 说明：以下“首审 / 返工”叙述是**员工交付阶段的历史快照**；正式恢复以 **Git、PR 与远端实际状态**为准，不要仅据此判断是否已交付或已合并。

- 初稿后经**管理者首审返工**（本分支第二次交付）：RC-0 拆为「代码审查 / 合成验证」与「用户本机人工可行性」两步；RC-1 补实际账号 / 凭据入口、适配器与最少 UI；RC-2 补目标账套定向导入与最小恢复能力；报表验收补独立预期金额 / 会计口径；范围弹性与未知源数据边界明确；`INDEX` / `CHANGELOG` 本轮同步。
- 方案给出按依赖顺序、可独立 PR 验收的工作包 **RC-0 ~ RC-6**：首包 RC-0 为 `TAX-BROWSER-REVIEW` + `LOGIN-DATA-PROOF`（复审 tax-browser 草稿 + 真实验证账号 / 验证码 / 授权企业 / 实际财务数据来源，可合理统一为一个 ID）；其后依次为登录与账套关联、数据落地与重试（幂等）、财务流水线、内部报表导出、税局申报格式导出、端到端交付。
- 现场核对（只读，未触碰）：`D:/有数云fork/.worktrees/tax-browser` 的 14 个未提交文件 SHA256 与 `.agent-runs/import-strict-tax-preservation.json` **仍全部一致**；该草稿仍为**未提交 / 未 PR / 未合并**，员工自报 272 项未经管理者复验（**272 为自报数，新 main 整合测试以实际为准**），**真实登录未验收，历史退出码未核实**。
- 数据边界：税局是否提供科目 / 期初 / 凭证 / 银行 / 发票**不可先行承诺**；若仅有企业列表 / 申报汇总，**不能完成自动财务闭环**，必须由用户提供本地资料并标识来源；不把未知 / 缺失当 0 或凭空生成凭证。
- 待办（超出本文件所有权，保留历史原文）：`docs/PHASE1-ACCEPTANCE.md`、`docs/CAPABILITY-AUDIT-2026-10-13.md`、`docs/handoffs/IMPORT-STRICT.md` 未改（历史验收 / 盘点文档保留历史）；其中最后一件的「下一部分 IMPORT-IDEMPOTENCY」为**历史记录**，已由本文件与 NEXT-SESSION 的现行排序替代。**`docs/INDEX.md` 与 `docs/CHANGELOG.md` 本轮已同步**（本工作区本轮允许修改）。
- 会话事实（已核实，不预报本次 final 实时状态）：本方案**初稿**、**首审返工（review）**、**二审返工（review2）** 三次实施会话均已实际结束，退出码均为 **0**（`pi-report-closure-plan.exit` / `pi-report-closure-plan-review.exit` / `pi-report-closure-plan-review2.exit`，**管理者已核实**）；IMPORT-STRICT 的**两个交接会话**亦均退出 **0**（均为管理者已核实）。**本次 final** 的会话日志 `D:/有数云fork/.agent-runs/pi-report-closure-plan-final.jsonl`、退出码文件 `pi-report-closure-plan-final.exit`（**由管理者后来实际核对**，不预报）。
- 合成数据验收服务：原启动记录 `http://127.0.0.1:50969/` PID 53200；**本次管理者 `Get-Process` 未找到该进程，URL 不可视为可用**；未重启，也无需用户验收该服务。

## 后续可执行任务表（依赖顺序）

任务状态以代码、可重复测试和联调证据为准，**不承诺未实现的批量能力**。下表是 2026-10-15 / 2026-10-16 现行顺序（报表闭环 + 多人分工），**已替代**此前「IMPORT-IDEMPOTENCY 第一优先」的排序；详细完成标准、必要测试、数据可得性门槛与验收场景见 [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md)。具体契约由管理者派工时写进任务单。

**成员分工（2026-10-16）**：RC-0 / RC-1 / RC-2a / RC-2b 与数据处理集成 → 负责人 `huxiaoyang-code`（[RC-A-LOGIN-DATA](../tasks/RC-A-LOGIN-DATA.md)）；RC-4 / RC-5 与报表口径盘点 → 同事 `xiaoyihaishiaini`（[RC-B-REPORTS](../tasks/RC-B-REPORTS.md)）；RC-3 由负责人统一协调（根据 B 的发现另开聚焦任务）；RC-6 由负责人统一协调。

| 顺序 | 任务 ID | 负责 | 目标 | 依赖 | 备注 |
|---|---|---|---|---|---|
| 1 | **RC-0** `TAX-BROWSER-REVIEW` + `LOGIN-DATA-PROOF` | 负责人 A | 新隔离工作区形成可核验快照（只复制源码 14 文件 / 补丁与基线，不复制 DB / 凭据 / 临时 profile / 日志），复现旧草稿测试并在最新 main 复用必要改动；再由用户本机真实登录验证账号 / 验证码 / 授权企业 / 实际财务数据来源，填写数据可得性矩阵 | 无（首包） | **A 当前第一个可派任务**；分两步，无真实配合时先完成第一步并记录第二步待验；**不得假定企业列表等于财务凭证**；整合时检查 PR #15 对 `server.mjs` / `public/*` / `scripts/test-all.mjs` 的冲突 |
| 2 | RC-1 登录会话与账套关联 | 负责人 A | 办税员身份 → 授权企业 → 本地账套关联；**含实际账号 / 凭据入口、适配器与最少 UI**；覆盖过期、验证码错误 / 超时、二次人机验证、授权撤销、企业切换与串账 | RC-0 | 区分身份 / 授权企业 / 税局登记申报数据 / 本地账套会计明细四层；凭据与验证码只由用户本机输入，**模型侧 MCP / Agent 仅收安全引用与状态摘要，本机 UI 专用回环通道方可处理瞬时凭据 / OTP，不送模型** |
| 3 | RC-2 目标账套定向导入、数据落地与重试 | 负责人 A | 标准 DTO 转换、完整性与科目映射预检、稳定业务键 / 内容版本、单账套原子事务与跨企业逐项结果、审计与最小恢复；**分 RC-2a 首次建账 / 填空账套与 RC-2b 已绑定账套后续开放期间追加**（同一绑定范围不得重复建账，不新增「一企一账套」产品限制） | RC-1 | 旧 IMPORT-IDEMPOTENCY 在此归位；现有 `importAccountSet` 总是新建账套，需补 RC-1 绑定账套 → 定向导入缺口 |
| 4 | RC-3 财务流水线完整性 | 负责人 A 统一协调 | 科目映射 / 期初 / 凭证 / 计提摊销 / 校验 / 结转结账，并核实报表算法与口径缺口；**影响目标准则 / 数据 / 报表的缺口必须补齐或显式阻止产出** | RC-2 | 不因函数已存在就宣称报表合规；`cashFlowStatement` 间接法末行为直接法净额、两套准则共用同一 COA 等缺口须逐项结论；**根据 B 的发现另开聚焦任务** |
| 5 | RC-4 内部报表导出 | 同事 B | 资产负债表 / 利润表 / 现金流量表 / 余额表（含各科目）/ 明细账可下载导出；**独立预期金额 / 会计口径验收** | RC-3 | **B1 五类内部 CSV 已随 PR #15 交付**（[REPORT-EXPORT](../REPORT-EXPORT.md)）；完整 RC-4 验收仍依赖 RC-3 接线；Excel/PDF 未实现 |
| 6 | RC-5 税局申报格式导出 | 同事 B | 按官方模板与字段映射导出可申报文件，并做勾稽校验；**官方模板核实自 RC-0 并行** | RC-4 + 官方模板核实 | **B2 未完成**：缺适用地区 / 准则 / 模板版本 / 上传格式，当前导出返回 422 `tax_template_unverified`；**生成可申报文件 ≠ 向税局正式提交**；内部 CSV ≠ 申报可用 |
| 7 | RC-6 端到端联调与交付 | 负责人 A 统一协调 | 用功能验收场景串起 RC-0~RC-5 并由用户实际验收；**含连续两个月验收**（RC-2a 首次 + RC-2b 后续追加） | RC-4、RC-5 | 不以 UI 页面数作为完成指标；真实联调只用用户本机数据 |

历史任务表（已替代，仅留追溯）：IMPORT-STRICT ✅（PR #10，merge `67f5e45`）；IMPORT-IDEMPOTENCY → 并入 **RC-2**；BATCH-QUEUE / BATCH-MANAGEMENT → 报表闭环完成后再定归属，本计划不先行搭建泛用批量平台与展示大屏；TAX 真实适配 → 并入 **RC-1 / RC-5**（全国为长期目标，当前 0 接入）。

## 恢复与会话

下一部分重新启动本地员工会话，仅传章程、STATE / NEXT-SESSION、相关交接、基线 SHA、文件范围和验收条件；不续用旧会话。每部分「验收 + PR 合并 + 交接」后关闭员工会话，下一部分用新进程、新会话（`--no-session` / `--no-session-persistence`，不使用 resume）。Codex 管理者当前对话不能由仓库强制清空，也无法声称已清空。

全国真实电子税务局适配尚未实现；当前无真实省份连接或登录承诺。现有运行后端和 Codex MCP 进程不会因 Git 合并自动重载，新代码验收使用临时进程。
