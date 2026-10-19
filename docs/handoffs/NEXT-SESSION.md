# 新会话入口 · NEXT SESSION

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

## RC-A0 状态（2026-10-17，负责人 A）

- 隔离 worktree `<repo>/.worktrees/rc-a0-review`，分支 `codex/huxiaoyang-code/rc-a0-review`，基线 `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`（含 PR #15 报表 + PR #16 团队文档）；**第一步本机独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）；代码已提交（初轮 `866fc308cd77bbce85d23de0b641a2e05682b3a9` + 收尾安全修复 `0293ed21968864d7bbabb071a7a0234fb9dbfbd6`）并开 PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19)，未合并，待跨成员 Codex 复核**。
- 活文档：[REVIEW-TAX-BROWSER](../REVIEW-TAX-BROWSER.md) · [DATA-AVAILABILITY](../DATA-AVAILABILITY.md) · [RC0-SNAPSHOT](RC0-SNAPSHOT.md) · [TAX-BROWSER](../TAX-BROWSER.md)（当前接口概述）；[handoffs/TAX-BROWSER](TAX-BROWSER.md) 只是**历史交接**，不是接口全文迁移，草稿接口全文仍在只读原件 / 副本。
- 已验证：原件 14/14 哈希一致；旧草稿复跑（**2026-10-16**）**7 套 272 项 exit 0**（沙箱首跑 5 套失败为 EACCES 回环限制，两轮分别保留）；main `c2d5619` 基线 10 套 336 项 exit 0（2026-10-16 既有管理者复验）。
- 未完成：**跨成员 Codex 复核未获得**（PR #19 未合并，创建时为 draft、实时 draft/ready 以 GitHub 为准）；文档后续提交不改已提交代码，最终 PR head 以 PR 当前提交为准；真实登录未验收，真实接入 0。**A0 未完成，不得因 A0 而关闭总 Issue #13**（保持 OPEN）。

## 当前基线（可核验事实）

- 最新已知 main 提交：`d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`（PR #16 团队交接；前一基线为 `c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0` PR #15 合并，mergedAt `2026-10-15T15:40:41Z`，即北京时间 2026-10-15 23:40；2026-10-16 / 10-17 是文档复验 / 核实日期）。**恢复时先核对当前 main / 远端**，后续 PR 合入后以实际最新提交为准，本文件不预报合并。
- **PR #1–#12 / #15 / #16 已合并；Issue #13 / #14 仍 OPEN（不是 PR）**。业务实现合并提交为 `03eba00`（PR #7）；#10 IMPORT-STRICT（业务代码，`67f5e45`）；#11 IMPORT-STRICT 交接归档（`cc6e789`）；#12 报表闭环方案重排（`8ebc739`）；**#15 内部五类 CSV 导出与税表参考校验**（同事 PR，`c2d5619`，head `843cad08c0e42e0614459bbbfc77160eadf498ad`，代码验证提交 `b913409d420cdd1d8264ad0d64a474880604c90f`）；**#16 团队交接文档（`d0221df`）**。
- **测试事实**：208 项（6 套，业务提交 `03eba00`）、262 项（7 套，`67f5e45`）、336 项（10 套，`c2d5619`）是既有验收事实；**本轮工作区（RC-A0）统一入口为 15 套 496 项（代码验证 head `0293ed2`），管理者 2026-10-17 独立复跑 `npm test` 与 `npm run test:smoke`（28/28）均 exit 0**（合成临时数据库，未读真实数据）；**初轮 `866fc30` 为 15 套 481 项（历史）**。**团队文档变更不重复业务回归。**
- 工具入口共 45 个：31 available（其中 7 个是税务预留接口）、1 limited、13 unavailable。**真实税局接入数 0**；入口数量不等于真实连接数。

## 未完成现场（先核对，勿重复派工）

- worktree `<repo>/.worktrees/tax-browser`，分支 `codex/tax-browser-import`，基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`（**负责人本机历史现场路径；同事不需寻找或重做**）。
- 状态：**未提交、未 PR、未合并**；为福建漳州浏览器登录后读取企业 / 批量新建或绑定账套的本地草稿，**不能代表全国接入**，**企业列表不等于财务凭证**。
- 员工交接 `<repo>/.worktrees/tax-browser/docs/handoffs/TAX-BROWSER.md`（负责人本机历史路径；现降为历史交接记录，**不是接口全文迁移**）；员工**自报** 272 项；**2026-10-16 复跑为 7 套 272 项 exit 0**（沙箱首跑 5 套失败为 EACCES 回环限制，两轮分别保留），**真实税局登录仍未验收**。
- 日志 `<repo>/.agent-runs/pi-tax-browser.jsonl` 退出码**尚未核实**，不能声称 exit 0；该历史退出码与本轮文档部分、与 IMPORT-STRICT 的 exit 0 均**不能混同**。
- 保留原目录，不重置 / 删除 / 覆盖 / 重做；**RC-0** 已在新的隔离工作区完成复审 / 整合（保留原件），并检查了与完整 `9783420..d0221df` 基线的冲突（**PR #10 改了 `accounting.mjs`；PR #15 改了 `server.mjs` / `public/*` / `scripts/test-all.mjs` / `test/*`**，已逐项检查冲突）。14 个未提交文件内容哈希与 `.agent-runs/import-strict-tax-preservation.json` 清单一致。
- **RC-A0 隔离工作区（新）**：`<repo>/.worktrees/rc-a0-review`，分支 `codex/huxiaoyang-code/rc-a0-review`，基线 `d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4`，**第一步本机独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）；已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR #19（未合并），待跨成员复核**；旧副本 `rc-a0-reproduce`（基线 `9783420`）只读。本轮产物与未完成项见 [RC0-SNAPSHOT](RC0-SNAPSHOT.md)。

## 方向（不可漂移）

本机**单用户**财税工作台，可对多个企业 / 账套批量处理；**不做多租户 / SaaS / 租户权限平台 / 对外服务**（开发多人不改变产品形态）。只保留账套隔离、操作日志、备份恢复、凭据安全等本机需要。全国电子税务局是产品目标，当前只有预留接口、真实接入 0。详见 [章程](../PROJECT-CHARTER.md) 与 [ROADMAP](../ROADMAP.md)。

## 已完成

- 记账、三大报表、试算、明细账、折旧/摊销、结转损益、封账/反结账、期间登记、旧账导入（JSON / 4 CSV，预检 + 事务，**严格校验**）。
- MCP 45 入口与真实能力目录；全国税务适配层与异步会话契约（本地假适配器测试，未联网）。
- **RC-B B0 / B1（PR #15）**：五类内部 CSV 导出（资产负债表、利润表、现金流量表、各科目余额表、明细账）、HTTP 下载与同口径页面 / JSON 预览；详见 [REPORT-EXPORT](../REPORT-EXPORT.md) 与 [RC-B 交接](RC-B-REPORTS.md)。
- 当前 main `c2d5619` 上 10 套 336 项（管理者复验，合成临时库）；**本轮 RC-A0 已提交（初轮 `866fc30` + 收尾修复 `0293ed2`），工作区为 15 套 496 项 + smoke 28/28（本机独立验收，PR #19 未合并）**。

## 明确限制（未实现，不承诺）

- 旧账导入**非幂等**（每次新建账套，**不修改既有账套**）→ 归入 **RC-2**。
- 无本机批量任务队列与管理 → 报表闭环完成后再定归属（本计划不先行搭建泛用批量平台与展示大屏）。
- 真实电子税务局 0 接入；辅助核算、银行对账、发票、申报均未实现。
- **RC-B 已交付内部五类 CSV 下载**；但 **B2 税局可上传申报文件未完成**：缺适用地区 / 准则 / 模板版本 / 上传格式，当前税表导出返回 422 `tax_template_unverified`。**内部 CSV ≠ 税局申报可用文件**；已有税表法定结构参考 / 勾稽校验与就绪性阻断，见 [TAX-REPORT-FORMAT](../TAX-REPORT-FORMAT.md)。
- **XLSX / PDF 未实现**；浏览器下载落盘在同事会话未确认（HTTP 附件已由接口套件验证）。
- RC-3 财务流水线完整性、RC-6 端到端交付未完成；税局是否提供科目 / 期初 / 凭证 / 银行 / 发票**不可先行承诺**；若仅有企业列表 / 申报汇总，**不能完成自动财务闭环**。
- 文档-only 变更不要求重跑 336 项；代码变更按受影响测试，关键合并基线跑全套（本轮 RC-A0 代码变更为 15 套 496 项）。

## 下一任务（按自己成员身份选择）

- **A（负责人 `huxiaoyang-code`）**：**RC-0 第一步（`TAX-BROWSER-REVIEW`）本机独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`）**（隔离 worktree `rc-a0-review`，已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR #19）：已复审 `tax-browser` 草稿、复跑其套件（2026-10-16 获批复跑 7 套 272 项 exit 0）、检查与完整基线（`9783420..d0221df`）冲突、审计安全边界并选择性整合；收尾时管理者探针复现旧 REST CORS 绕过，已由员工修复（仅追加 `server.mjs` / `server-local-boundary` 测试）并由管理者审 diff + 全套独立重验。**待完成：按团队 §8 取得跨成员 Codex（成员 `xiaoyihaishiaini` 本机）复核，再从合并门槛继续；不重启已完成 A0 实施**。**不得假定企业列表等于财务凭证。** 真实验证（账号 → 验证码 → 授权企业 → 实际财务数据来源）需用户本机参与，为第二步，见 [DATA-AVAILABILITY](../DATA-AVAILABILITY.md)。
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
npm test          # 全套（当前工作区 15 套 496 项；初轮 866fc30 为 15 套 481 项；main 基线 c2d5619 为 10 套 336 项；历史基线 262 / 208 项）
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
恢复时先核对当前 main / 远端：本文件记录的最新已核实基线是 d0221df1d18e2bfcbd7db2cc9aa0875ab32a7fd4
（PR #16 团队文档；前一基线 c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0 = PR #15 合并），它不是新对话必须停留的 HEAD，以实际最新提交为准。
PR #1–#12 / #15 / #16 已合并；Issue #13 / #14 仍 OPEN（不是 PR），子 PR 用 Refs，不得因 A0 而关闭总 Issue #13。
A0 代码已提交（初轮 866fc30 + 收尾修复 0293ed2）并开 PR #19（未合并，创建时为 draft、实时 draft/ready 以 GitHub 为准）；当前 main 10 套 336 项为管理者复验事实（合成临时库）。
恢复点是 PR #19（已验收 496 项，代码验证 head 0293ed2），从跨成员复核与合并门槛继续；不重启已完成的 A0 实施。

我的任务是 A0 = RC-0 第一步（TAX-BROWSER-REVIEW）：在新隔离 worktree 复审 tax-browser 草稿，
保留原目录只读，复跑其套件并记录实际结果与退出码（员工自报 272 不作为结论），
检查与完整 9783420..d0221df 基线的冲突（PR #10 已改 accounting.mjs；PR #15 已改 server.mjs / public/* /
scripts/test-all.mjs / test/*，逐项检查），审计安全边界；不得假定企业列表等于财务凭证。
现状：第一步已本机独立验收通过（15 套 496 项 + smoke 28/28、exit 0，代码验证 head `0293ed2`），代码已提交（初轮 `866fc30` + 收尾修复 `0293ed2`）并开 PR #19（未合并）；
从跨成员复核与合并门槛继续，**不重启已完成的 A0 实施**；真实验证（账号 → 验证码 → 授权企业 → 实际财务数据来源）是第二步，需我在本机参与；
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
