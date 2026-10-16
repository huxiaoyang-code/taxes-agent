# TEAM-HANDOFF · 多人协作交接（本轮）

- 状态：**本轮团队交接（文档 / 模板）在 `codex/team-handoff-current` 分支完成，已经管理者独立终审返工（本次 10 修改 + 8 新增 = 18 文件），当前尚未提交 / 未创建 PR**。是否已交付 / 已合并以 **Git、PR 与远端实际状态**为准（`git status` / `git log` / PR 平台），不据本文件措辞判断。**旧 worktree `D:/有数云fork/.worktrees/team-handoff`（分支 `codex/team-handoff`）为只读草稿原件，未提交、未合并**；本文件所在为新工作区，不能误称旧草稿已合并。
- 目标：按用户本轮明确确认，建立**多人跨电脑、按需求分工**的完整协作交接：成员入场、双层角色与权限、文件所有权、任务看板、任务总 Issue、交接与 PR / Issue 模板，以及成员分工（A 负责人税局登录与数据接入；B 同事两类报表口径核对与导出）。
- 明确不做：不实现任何 RC 业务功能；不做多租户 / SaaS / 对外服务；不添加 GitHub Actions / CODEOWNERS / 规则集；不修改 `team-skills/` 内容、不安装技能到他人全局目录；不新增脚本 / 业务代码；不改远端设置；不触碰其他 worktree 与真实数据 / 凭据 / 全局配置。
- 基线：`c2d561994377d9123a1cd5b8b67dfa8a16a5d2b0`（PR #15，同事 RC-B B0/B1 交付）。
- 分支 / worktree：`codex/team-handoff-current`，`D:/有数云fork/.worktrees/team-handoff-current`。
- 执行者 / 模型：pi / tokenhub `deepseek-v4.1-flash`（主 / 回退均该已核实映射）；无其他模型、无子 agent。

## 交付内容

新增（8 个）：

| 文件 | 说明 |
|---|---|
| `docs/TEAM-COLLABORATION.md` | 团队协议：双层角色、权限、共享同步、交接契约、文件所有权矩阵、任务生命周期 / 认领、跨成员评审、凭据与数据边界、官方参考摘要 |
| `docs/handoffs/MEMBER-ONBOARDING.md` | 可直接转发同事的自足入场包（含安全测试示例）+ 可直接复制的开场提示 |
| `docs/tasks/README.md` | 任务分配看板、总任务 Issue #13 / #14 状态、权威认领规则与文件所有权速查 |
| `docs/tasks/TEMPLATE.md` | 任务单模板（12 节；断言项为待填写，不预填通过） |
| `docs/tasks/RC-A-LOGIN-DATA.md` | 负责人任务单：RC-0 / RC-1 / RC-2a / RC-2b + RC-3 协调（关联 Issue #13） |
| `docs/handoffs/TEAM-HANDOFF.md` | 本交接 |
| `.github/pull_request_template.md` | PR 模板（断言待填） |
| `.github/ISSUE_TEMPLATE/requirement.md` | 需求 Issue 模板（Markdown frontmatter；立项不预填已验收） |

修改（10 个；注意其中的文件分类）：

- `docs/tasks/RC-B-REPORTS.md`：**该任务单是 PR #15 已有文件，本轮修改（补充跨机器边界与 B2 接续），不是本轮新增**；不得当作新任务单或新工作包。
- `AGENTS.md`：增加团队协作入口与「先识别自己成员 / 已分配任务」；
- `docs/PROJECT-CHARTER.md`：团队与权限段落补充多层角色、成员自审自合并、文件所有权；
- `docs/TEAM-PLAN.md`：指向团队协作协议与任务看板；
- `docs/REPORT-CLOSURE-PLAN.md`：RC-4 / RC-5 / RC-0 与成员分工对应；**纠正「报表无法导出」「无任何模板 / 勾稽」的旧当前状态**（改为 B1 已交付内部 CSV、B2 未完成）；
- `docs/INDEX.md`：新增协作 / 任务文档入口与状态看板行；
- `docs/CHANGELOG.md`：新增本轮多人协作条目，并保留 PR #15 条目、补 PR #12 与团队新状态；
- `docs/handoffs/STATE.md`：新增「先识别自己成员与已分配任务」、PR #15 已完成行、RC-B 补充与现行任务表；
- `docs/handoffs/NEXT-SESSION.md`：分 A / B 两段开场提示，B 读 B 任务而非默认 RC-0；不擅自下发真实登录操作；
- `docs/handoffs/TEMPLATE.md`：升级为 10 节版本化交接模板，断言项待填写。

**本轮文件分类（本次终审后）**：**10 修改 + 8 新增 = 18 个文件**；其中 `docs/tasks/RC-B-REPORTS.md` 为 PR #15 既有任务单的修改，**不属新增，也不新增任何 B 任务单**。

## 关键设计决定

1. **双层角色**：每个**人类成员 + 其本机 Codex** 构成该成员的本机管理层，成员派出的 pi / Claude Code 是执行员工。授权对称：**目前登记并经项目负责人授权的成员只有 `huxiaoyang-code` 与 `xiaoyihaishiaini`**，这二人及其已分配任务可自审自己本地员工、独立验收并**自动合并自己的 PR**。该授权**不从通用文档推给新贡献者**；新成员需先经项目负责人登记并授权。**GitHub 不能批准自己账号开的 PR 的正式 review**：本机 Codex 审查是**独立于员工的内容审查**，**不冒充 GitHub 第二账号批准**。**人类成员不被禁止直接写业务代码**；角色边界约束的是 AI 工作流。
2. **同事无仓库管理员身份**：个人私有仓库协作者 **write** 即可 push / 开 PR / review / merge；**不要求 admin**。已核实（2026-10-16）：同事账号已接受 write 邀请（ID `337920044`），GitHub API 实测 `permission = write`。
3. **共享同步走远端**：GitHub 仓库 + 按任务 Issue / PR + 版本化任务文档；**不依赖**本机 D 盘路径、聊天或 `.agent-runs`；**不共享** worktree / 端口 / 进程 ID。路径用仓库相对路径与 `<repo>` 占位；`tax-browser` 绝对路径只作负责人本机现场，同事不需去找 / 重做。
4. **文件所有权单一**：`accounting.mjs` / `coa.mjs` / `db.mjs` / `server.mjs` / `agent-tools.mjs` / MCP 注册 / `scripts/test-all.mjs` / `package.json` / `public/*` / 共享状态索引为共享受控，同一时刻唯一编辑责任人；**B 专属** `report-export` 与 **`tax-report-format.mjs`**（`tax*` 规则的模块名专属例外）；**A 负责** `tax*` 采集 / 登录 / 会话与 `import*` 定向导入。共享接线走独立集成 PR 或**协商短期所有权**（无需每 PR 问用户）。任务锁远端可见（Issue assignee / 状态）。
5. **合并协调如实**：合并前核对最新 `origin/main`、重验受影响范围、锁 head 合并；**GitHub 不能原子锁 base**，共享关键变更串行合并，评论不等于技术互斥。
6. **任务初始状态**「已分配 / 待开工」，**不是**「开发完成」；**RC-B B0 / B1 已交付，不退回 B0 待开工**；B1 / B2 纯模块与合成 DTO 测试可在 RC-3 前先行，完整集成验收才依赖 RC-3 / 接线。
7. **凭据 / 数据边界**：成员各用自己凭据，绝不复制负责人 token / config / session / 账套 DB；必要源码 / 任务 / 合成测试错误限于已授权 tokenhub，**同项目新机器不重复索取已有授权但须核实服务与允许模型**；执行员工仅 GLM 5.3 / DeepSeek V4.1 Flash，**Codex 自身模型不在此限**。**同事 RC-B 会话记载其用户允许 Codex Subagent 实施，属对方任务内例外；保留来源和限定，不冒充本会话新授权，也不泛化给后续任务。**
8. **治理变更非永久禁止**：本轮不加 CI / 不改 settings 是**本轮实现范围**；后续治理变更经项目负责人授权即可评估。当前 API 403 等是**当前计划下的实际限制**，不是永久产品限制；仍不擅自公开 / 付费 / 迁移 / 改设置。

## 远端事实（2026-10-16 管理者实测，不改设置）

- 仓库 **private**；`owner.type = User`；当前 owner `admin = true`；`main` **protected = false**；rulesets API 返回 **403**（要求 GitHub Pro 或公开仓库）。
- **邀请 / Issue 实际状态**：同事 `xiaoyihaishiaini` 已接受 write 邀请（ID `337920044`），API 实测 `permission = write`；[Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13)（RC-A，assignee `huxiaoyang-code`）与 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)（RC-B，assignee `xiaoyihaishiaini`）均 OPEN。子 PR 用 `Refs #13` / `Refs #14`，不因 A0 / B0 完成就 Closes 总任务。
- 本机**无 `.github` 工作流**，**不称 CI 已存在**；本轮只新增 `pull_request_template.md` 与 `ISSUE_TEMPLATE/requirement.md`，**不加 Actions / CODEOWNERS / 规则集**。
- 写权限技术上也能直接推 main；文档约定走分支 + PR 是对人的约定，**不能技术阻止**。
- **本轮未改任何远端设置**；总任务 Issue 与邀请由管理者完成。

## 同事 PR #15 已交付事实（保留，不覆盖）

- PR [#15](https://github.com/huxiaoyang-code/youshu-fork/pull/15) 已合并入 main `c2d5619`；head `843cad08c0e42e0614459bbbfc77160eadf498ad`，代码验证提交 `b913409d420cdd1d8264ad0d64a474880604c90f`。
- B0 / B1 已交付：五类内部 CSV 导出、HTTP 下载、同口径 JSON / 页面预览；**B2 未完成**（缺适用地区 / 准则 / 模板版本 / 上传格式，导出 422 `tax_template_unverified`），**RC-3 / RC-6 未完成**；XLSX / PDF 未实现；浏览器落盘在同事会话未确认，HTTP 附件已由接口套件验证。
- 同事现有 `docs/REPORT-EXPORT.md`、`docs/TAX-REPORT-FORMAT.md`、`docs/handoffs/RC-B-REPORTS.md` **只读保留，不覆盖**；对照见 [REPORT-EXPORT](../REPORT-EXPORT.md) 与 [RC-B 交接](RC-B-REPORTS.md)。
- 同事 PR **没有 CI / 正式 GitHub review 记录**，**不称 CI 通过**。

## 项目方向与历史保留

- 方向不变：本机单用户、多企业 / 多账套批量；**不做多租户 / SaaS / 对外服务**；全国电子税务局仍是目标、**当前真实接入 0**。
- 保留：历史 PR #12 merge `8ebc739`、`tax-browser` 14 个未提交文件哈希未变、RC-0 真实接入 0 的边界与 `tax-browser` 原件（只读，不写回 / 不重做 / 不重置 / 不删除）。
- 旧草稿中「报表无法导出」「无任何模板 / 勾稽」等属于其编写时刻的历史记录；**当前状态已按 PR #15 纠正**，历史仅留追溯。

## 本轮自查（不跑业务回归）

- `git diff --check`：通过（无空白错误）。
- 改动范围：仅新增 / 修改**文档与 Markdown 模板**，目录为 `docs/`、`.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/requirement.md` 与 `AGENTS.md`；`git status` 实际列出的文件与本交接声明一致，**无脚本 / 业务代码 / Skill / CI / 仓库设置改动**。
- 相对链接：已逐条实际校验新增 / 修改文档的 Markdown 相对链接（含 `../` 与 `tasks/`、`handoffs/`），**0 个失效**（外链与占位符不作为已校验的本地链接）。
- 模板字段 / 前置一致性：任务单、Issue、PR、交接四套模板的断言项均为**待填写**，立项不预填已验收 / 已通过；必填项互相覆盖（需求验收结果、文件所有权与共享改动协商、依赖 / 基线、成员 / 执行员工模型、Codex 独立验证、真实数据边界、验证 head、自动合并权限 / 协调记录、回退与交接）。
- 权限一致性：无「所有 PR 需用户再次批准」表述；无「成员可改权限 / 仓库设置」默认；成员自动合并按用户已授权写明，且限定在已确认成员及任务内。
- 无机器专属 / 敏感依赖：未写入负责人 home / 可执行绝对路径为他人默认；`tax-browser` 绝对路径已标注为负责人本机现场；`~/.codex/skills` 已标注为本机事实、非通用路径；入场测试示例用专用临时目录、校验在 TEMP 内、`try/finally` 恢复旧 `WORKBENCH_DATA_DIR`、显式记录退出码、不自动递归删除（保留排障现场）。
- **本地员工未运行任何业务测试**；**本地员工不声称本轮新验证任何业务套件数字**。**管理者本轮独立复验**：在 `c2d5619` 运行 `npm test` 10 套 336 项、exit 0（合成临时库，未读真实数据）；同事 PR 无 CI / 正式 review 记录。

## 会话与进程事实

- 本交接为**文档交付阶段快照**：是否已交付 / 已合并以 Git、PR 与远端为准。
- 本轮 pi 会话日志 `D:/有数云fork/.agent-runs/pi-team-handoff-current.jsonl`、退出码文件 `pi-team-handoff-current.exit`；**管理者已核实**：该进程已自然结束，统一执行 session80422 结果 `exit=0`，即 `pi-team-handoff-current.exit=0`（管理者曾准备终止某 PID，执行时身份检查发现其已退出，**未主动终止任何进程**）。**本次独立终审返工（final）是新进程新会话**，其退出码不预报。
- 本机历史事实：`tax-browser` 历史退出码仍**未核实**，不得声称 exit 0，也不与本轮混同。
- 未启动后台服务；未触碰其他 worktree（含 `tax-browser` 原件与旧 `team-handoff` 草稿）。

## 仍需管理者 / 用户处理（本轮不代做）

- 总任务 Issue #13 / #14 的后续子 Issue 与 `Refs` 维护（管理者）。
- 后续 RC 派工按 [任务看板](../tasks/README.md) 与各成员任务单执行；**成员业务任务本轮不启动**。
- owner 新窗口入口：读最新 main / Issue13 / RC-A-LOGIN-DATA，本次仅收尾团队交接，不启动 A / B 业务开发。

## 上下文

- 本部分为**文档变更**，不要求重跑业务回归；管理者审查只需核对 diff、链接、模板字段一致性、权限与事实边界。
- 下一部分（RC-0 等）使用**新进程、新会话**（`--no-session` / `--no-session-persistence`，不使用 resume）；先识别自己成员身份与已分配任务，避免所有机器默认接 RC-0。
- 授权继承自项目章程与用户后续指示；真实账套数据与税务凭据不发到模型服务；团队新交接保持源数据不外传，同事不需要负责人未提交现场 / 历史日志。
