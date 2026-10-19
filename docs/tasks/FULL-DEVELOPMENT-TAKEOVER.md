# FULL-DEVELOPMENT-TAKEOVER · 全量开发接管任务单

- 状态：**已分配 / 待开工**（初始状态，不是「开发完成」）
- 生效日期：2026-10-19（用户最新指示，优先于旧 A / B 分工）
- 负责人（人类成员 / GitHub）：由用户在目标机登录授权的 `huxiaoyang-code` GitHub 账号，继续使用同一私有仓库 `https://github.com/huxiaoyang-code/youshu-fork`，不另找新用户名、不 fork、不另建仓库
- 执行员工：pi / Claude Code（只允许 GLM 5.3 或 DeepSeek V4.1 Flash，主 / 回退显式锁定，不得使用其他模型或子 agent）
- 本机管理者：接手者自己电脑上的 Codex
- 分支：`codex/<member>/<task>`（每包独立 worktree 与分支，禁止直接改 main、禁止强推）
- 基线：分叉时最新 `origin/main` 完整 SHA；本任务书写时的最新已知 main 为 `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`（**不是**新会话必须停留的 HEAD，以实际最新提交为准）
- 关联（远端实际状态，勿改写）：**总接管 Issue [#20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)**（OPEN，assignee `huxiaoyang-code`，标题「全量开发接管：沿用 huxiaoyang-code 完成后续开发」）；业务总任务 [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13) / [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) / [#17](https://github.com/huxiaoyang-code/youshu-fork/issues/17) 仍 OPEN；在途 PR [#18](https://github.com/huxiaoyang-code/youshu-fork/pull/18) / [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)。子 PR 用 `Refs #20`，并按业务关联 `Refs #13` / `Refs #14` / `Refs #17`；不因单包完成就 Closes 这些总任务。**旧 Issue 的 assignee 未被改动、未被关闭；本交接文档 PR 的编号与合并 SHA 由管理者后补，不假称已合并。**

> 交接包见 [全量开发接管交接](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md)（自足、含代码地图、状态矩阵、在途资源、缺陷与顺序、必要命令、首日清单、启动提示）；税局登录后只读 checkpoint 见 [TAX-POSTLOGIN-CHECKPOINT](../handoffs/TAX-POSTLOGIN-CHECKPOINT.md)。

## 1. 用户最新指示（2026-10-19，优先）

- 用户要把**全部后续开发**交给同事在**另一台电脑**的 Codex 继续，向**同一个私有仓库** `https://github.com/huxiaoyang-code/youshu-fork` 提交；用户明确说「就用我的 GitHub 账户，他全面接手开发任务」。接手方按 `huxiaoyang-code` 仓库身份接续，**不另找新用户名、不要求 fork、不另建仓库**。
- **不要复制原机器**的 token / config / session / 账套 DB。由用户在目标机自行登录账号；其他服务也按已有授权在**目标机独立配置**，不复制原配置。
- `huxiaoyang-code` 既有「自审验收后自动合并」授权**继续有效**，仍须遵守**独立内容审查、影响验证、共享变更整合约束**；这不是 GitHub 第二账号 review，**不伪造 review**。
- **无须重复申请全量开发授权**；真实外部提交仍按已确认 PRD 在操作前**批次确认**。
- **接管授权已由用户确认，不再设再次审批**：用户已明确授权「用我的 GitHub 账户，他全面接手开发任务」，接手方**按本次用户指示直接接续，不需要再取得「确认切换」批准**。开工前只需**核对并登记**在途 PR / 同文件编辑，**只在发现实际冲突或未停的同文件实施时协调**，不能覆盖他人未提交成果；**对方是否实际收件 / 已开工未知**，核对结论不等于旧机器已停止。
- 旧 A / B 职责分工不再限制接手者；Issue #13 / #14 / #17 保留历史与验收价值，**不自动关闭**，也**不假定**旧机器工作已经停止。
- 接手前通过 GitHub **核对仍在途 PR / 成果** 并**登记**自己将改的同名文件，只在发现**实际冲突**或**未停的同文件实施**时才协调；不能因使用同一个 GitHub 账户就当技术互斥。**本次仅交接文档，原电脑不新开业务实现。**

## 2. 目标

- 以最新业务 PRD 的**全部范围**为交付目标（本机单用户、多企业多账套；全国 / 两套准则；内部与税局财报 / Excel / PDF；辅助核算与银行对账；发票采集、开票、红冲；企业适用各税种；个税工资薪金 / 劳务 / 经营 / 年度汇算；正式申报、缴款、社保、非税；审计、备份、恢复；20 家两个账号模式实际同时办理；可比实际工作月一名操作者配合产品正确完成 > 300 家）。
- PRD 权威来源（**不要使用旧工作区 v0.1**）：
  - 远端固定证据：<https://github.com/huxiaoyang-code/youshu-fork/blob/346e1c307379e9a6bf96ef34244dee154558777f/docs/PRODUCT-PRD.md>
  - 该文件位于 **PR #18 head** `346e1c307379e9a6bf96ef34244dee154558777f`，**尚未合并进 main**。新手 clone main 后**没有**该文件，必须按 [交接 §必要命令](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md) 先 `git fetch origin`，再 `gh pr view 18` / `git show origin/codex/huxiaoyang-code/project-prd-review:docs/PRODUCT-PRD.md` **只读**查看，并**先核对 head** 避免未来漂移。
- 阶段先后**不删减首版范围**：漳州先验收 ≠ 全国完成。

## 3. 所有权接管

- 接手者继承 `huxiaoyang-code` 在 `docs/TEAM-COLLABORATION.md` §6 的**文件所有权矩阵**责任（`accounting.mjs` / `coa.mjs` / `db.mjs` / `server.mjs` / `agent-tools.mjs` / MCP 注册 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享状态索引）。
- **旧 A / B 分工是历史快照**：`docs/TEAM-COLLABORATION.md` §1、`docs/REPORT-CLOSURE-PLAN.md`「成员分工」、`docs/tasks/RC-A-LOGIN-DATA.md`、`docs/tasks/RC-B-REPORTS.md` 中的 A / B 归属**不能当作最新事实**，只保留历史与验收追溯。接手者可重新登记**每包唯一文件负责人**（同一共享文件任一时刻仍只能有一个编辑责任人）。
- Issue #13 / #14 / #17 的**旧 assignee 不代表继续原分工**，也**不自动转移**（本次未改动旧 assignee）；总接管 Issue #20 由管理者创建并指派 `huxiaoyang-code`，实际状态以 GitHub 为准。
- 接手者与旧机器可同时持有同一仓库权限；**不以 GitHub 账户相同推断技术互斥**，共享关键变更**串行合并**并重验。

## 4. 输入 / 输出

- 输入：
  - 代码基线 `origin/main` + 在途 PR #18（PRD 业务范围，Draft）/ PR #19（漳州企业采集草稿安全整合，OPEN）；
  - 交接包 [FULL-DEVELOPMENT-TAKEOVER](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md) 与 [TAX-POSTLOGIN-CHECKPOINT](../handoffs/TAX-POSTLOGIN-CHECKPOINT.md)；
  - 由用户在目标机登录授权的 `huxiaoyang-code` GitHub 账号与在目标机独立配置的 Codex / 模型服务（按现有授权，**不复制**原机器配置）；合成测试数据。
- 输出（每包可独立说明结果、验证与回退，通常一个任务 + 一个 PR）：
  - 代码 / 测试 / 文档变更；
  - 该包交接（基线与已审核 head、验证命令与结果、依赖契约、未完项）；
  - 完整业务覆盖清单、分期实施与排期依据、20 家并发与月产出两阶段验证计划、未达标应对方案、必要边界细化清单（交项目经理逐项验收）。

## 5. 首个工作包（建议）

**首包 = 接管盘点 + 安全金额与会计核心缺陷分包（无外部依赖，可立即推进）。**

1. **接管盘点**：核实自己身份与授权、目标机环境（Git / Node ≥ 22.5 与 `node:sqlite` 实测 / gh 登录 / 执行员工与允许模型）、基线、worktree、远端在途 PR / Issue；读 PRD 与交接包；输出缺口清单与任务拆分（每包登记文件负责人）。
2. **首个修复包（无依赖，可先行）**：从 [交接 §缺陷清单](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md) 中挑选**无外部依赖**的会计核心 / 金额安全缺陷（如直接凭证路径非法金额被静默归零、金额精度与舍入口径、封账前置条件不足）作为首个可合并修复包，先补合成回归再改实现，失败回滚、防重复。
3. **真实输入缺口做独立工作**，不空等、不自缩范围：真实登录 / 数据可得性、官方模板等缺失项先做独立前置并明确记为待验。

> 不得只写计划不开发。接手方完成环境 / 基线核对与任务拆分后，在**已授权范围**推进**无依赖的首个修复包**。

## 6. 建议总接续顺序（允许独立任务并行，但先登记文件负责人）

1. 接管盘点 / 评审；
2. 安全金额与会计核心缺陷分包；
3. 真实登录 / 数据可得性与来源清单；
4. 连续两个月定向导入、对账与期末完整性；
5. 报表与计税底稿 / 规则版本 / 账表税勾稽；
6. 申报回执、缴款与防重恢复；
7. 发票、个税、社保、非税等全域逐项覆盖；
8. 20 家真实同时办理与真实工作月产出**分别验收**。

税务处理原则：按**真实资料**形成可追溯底稿；税负用于**检查差异 / 遗漏 / 政策适用**，**不按目标税负倒算账务**；每字段可追原始证据 / 凭证 / 调整 / 规则版本，区分预缴与汇算、财报报送与纳税申报、申报与缴款。本任务**不是税率政策建议，不编现行税率**。

## 7. 验收标准

- 每个包：范围内实现与文档齐备；管理者阅读实际 diff；验收覆盖业务结果与关键失败路径；基于待合并版本测试通过；PR 已合并；交接含可核验提交与结果。
- 真实外部动作（开票、红冲、正式申报、缴款）**操作前由操作者批次确认**；**申报成功 ≠ 缴款成功**，二者分别核对。
- 前期可用合成 / 演示样本验收「功能正确、20 家同时推进、失败可恢复、容量有依据」，但**不得提前声称真实月产出达标**；20 家并发与月产出**分别**以真实记录验收。
- **不得**用自动点击浏览器 / 点击脚本路线（用户已**永久否决**）。
- 不通过：退回返工或记录阻塞，**不伪造成功**、不删改旧断言。

## 8. 权限与边界

- Git / PR 操作由**用户在目标机登录授权的 `huxiaoyang-code` GitHub 账号**执行；Codex 与模型服务按现有授权在目标机独立配置，**绝不复制**原机器 token / config / session / 账套 DB。
- 真实账套数据与税务凭据**不发到模型服务**；真实登录、验证码、凭据只在**本机可信界面**处理，不回传原文，不进日志 / Git / PR / 模型。
- 自动测试**只用合成临时库**，不覆盖生产库，不绕过沙箱。
- 已授权：本项目必要源码 / 任务说明 / 测试错误发送到已配置 tokenhub；审查验收通过后自动合并自己的 PR（范围见 [章程](../PROJECT-CHARTER.md) 与 [STATE](../handoffs/STATE.md)）。同项目新机器**不重复索取已有授权**，但须**核实服务与允许模型**，**不得扩大到别的服务 / 新仓库**。
- 不新增 GitHub Actions / CODEOWNERS / 规则集，不声称已有 CI 或分支保护，不擅自改远端设置。

## 9. 文件所有权与共享改动

- 每包在任务单 / Issue 登记**当前唯一编辑责任人**；共享接线改动可走**独立集成 PR** 或申请**短期文件所有权**。
- 合并前核对最新 `origin/main`，基线变动**重验受影响范围**，锁定已验证 head 再合并；**GitHub 不能原子锁 base**，共享关键变更**串行合并**。

## 10. 回退与交接

- 回退用**新的 revert PR**，禁止重写 main 历史。
- 每包「验收 + PR 合并 + 交接」后，关闭该包执行员工会话，下一包用**新进程、新会话**（`--no-session` / `--no-session-persistence`，不使用 resume）。
- 交接模板见 [handoffs/TEMPLATE.md](../handoffs/TEMPLATE.md)。

---

协作规则见 [团队协作协议](../TEAM-COLLABORATION.md)；看板见 [任务看板](README.md)；完整工作包见 [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md)；接手交接包见 [FULL-DEVELOPMENT-TAKEOVER](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md)。
