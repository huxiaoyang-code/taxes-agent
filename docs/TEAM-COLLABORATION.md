# 团队协作协议 · TEAM COLLABORATION

生效日期：2026-10-15。依据用户本轮明确确认（多成员跨电脑协作、各自 Codex 可自审自合并、报表口径分工）制定；用户后续明确指示优先于本文件。本文件是**跨成员协作**的权威约定；冲突时以 [项目章程](PROJECT-CHARTER.md) 与用户指示为准。

## 0. 一句话边界

产品仍是**本机单用户**财税工作台（一名操作者、多企业 / 多账套批量处理）；**开发多人不等于产品多租户**。不做 SaaS、多租户、租户权限平台、对外服务或账户体系。本轮只增加**开发协作**方式，不改变产品形态。

## 1. 目标与分工

用户目标仍是**报表闭环**（办税员账号 → 验证码 → 登录 → 授权企业 / 账套 → 财务操作 → 出报表），且**两类报表都要**：内部资产负债表 / 利润表 / 现金流量表 + 余额表 / 明细账，以及税局财务报表申报格式。前端展示次要。工作包 RC-0 ~ RC-6 见 [报表闭环补全方案](REPORT-CLOSURE-PLAN.md)。

本轮明确的人类成员分工：

| 成员 | GitHub | 负责范围 | 任务入口 |
|---|---|---|---|
| 项目负责人 | `huxiaoyang-code` | RC-0 / RC-1 / RC-2a / RC-2b（税局登录、数据接入、目标账套定向导入与集成）；RC-3 会计核心改动统一协调 | [RC-A-LOGIN-DATA](tasks/RC-A-LOGIN-DATA.md)；总任务 [Issue #13](https://github.com/huxiaoyang-code/youshu-fork/issues/13) |
| 同事 | `xiaoyihaishiaini` | RC-4 / RC-5（两类报表口径核对与导出）及报表现状口径盘点 | [RC-B-REPORTS](tasks/RC-B-REPORTS.md)；总任务 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) |

两名成员（**目前登记并经项目负责人授权的仅 `huxiaoyang-code` 与 `xiaoyihaishiaini`**）各自提交 PR、各自的本机 Codex 独立审查验收；满足验收与整合约束后**可以自动合并自己的 PR**，不需要其他成员逐 PR 批准，也不需要用户逐一确认（用户已授权）。该自动合并授权**只适用上表已登记并经项目负责人授权的这两名成员及其任务**；任何新贡献者**不能从通用文档自授权**。用户 / 项目负责人决定跨任务需求范围；成员在**已分配任务内**可作常规实现选择，不擅自扩大需求或权限。**跨成员的评审**按任务风险与共享文件需求安排，不一律强制人工每 PR 批准。

## 2. 双层角色模型

每个**人类成员**下面有两层：该成员**自己的本机 Codex（本机管理者）**，以及该成员派出的**本机执行员工（pi / Claude Code）**。角色与授权对所有成员对称。

| 层 | 角色 | 职责 | 明确不做 |
|---|---|---|---|
| 人类成员 | 需求与授权决定者（本机） | 决定目标 / 范围变更、核对本人授权、在特殊风险时参与验收 | 不擅自扩大已授权需求或权限；跨任务需求范围由用户 / 项目负责人决定 |
| 本机管理者（成员自己的 Codex） | 任务拆解、隔离 worktree、阅读实际 diff、运行验证命令、写任务单与 PR 正文、执行 Git / PR / 合并、安装已审查 Skill、独立内容审查 | 审查、验收、提交、推送、合并、跨人交接、最终 RC-6 集成（由项目负责人或用户指定者担任） | **不直接补写业务代码 / 测试 / 交付文档**，即使小修也退回本机员工；不冒充 GitHub 第二账号做「正式 review 批准」 |
| 本机执行员工（pi / Claude Code） | 文件探索、代码 / 测试 / 文档 / Skill 的实现与修复，并自测 | 按任务单交付、说明实际变更与失败路径 | 不执行 Git 提交 / 推送 / 合并；不读取或转送真实数据；不使用未获准模型或子 agent |

关键语义：

- **授权自审、自己合并**：**目前登记并经项目负责人授权的成员（`huxiaoyang-code` 与 `xiaoyihaishiaini`）**的本机 Codex 对自己派出的员工成果做**独立于员工的内容审查**（读 diff、跑验证、核对边界），通过后按已验证 head 合并自己的 PR。这是「本机 Codex 审查」，**不代表 GitHub 上的第二账号正式批准**——GitHub 不允许批准自己账号开的 PR，本机审查不冒充该批准。该授权**不从通用文档推给新贡献者**。
- **跨人交接**：一个人完成的工作要交接给另一个人时，走版本化交接（见 §5）与远端 Issue / PR，不依赖聊天、本机 D 盘路径或 `.agent-runs`。
- **最终 RC-6 集成负责人**：端到端联调与交付由项目负责人 `huxiaoyang-code` 统一协调（用户可另行指定）；其他人只提供经审查的 PR 与交接。
- **同事没有仓库管理员身份**：`xiaoyihaishiaini` 作为个人私有仓库协作者拥有 **write** 权限即可 push / 开 PR / review / merge；**不要求 admin 权限**，不要求改仓库设置。

## 3. 远端事实（2026-10-16 实测，不得据此提议改设置）

- 仓库 **private**；`owner.type = User`（个人账号仓库，不是组织）；当前 owner `admin = true`。
- `main` **protected = false**（无分支保护）。
- rulesets API 返回 **403**，要求升级 GitHub Pro 或改为公开仓库。这是**当前账号 / 仓库计划下的实际限制**，不是永久产品限制；**后续治理变更需项目负责人授权**。
- 本机**没有 `.github` 工作流**，因此**不能把 CI 称作已存在**。

**本轮**不改公开 / 付费计划 / 迁移 / 权限，也不据此提议改设置；这类属于**后续治理变更**，**需项目负责人授权后方可评估**。未获授权前，**不开放仓库、不付费、不迁移、不削弱权限**等实质操作一律不做；**不擅自改任何远端设置**。邀请同事的操作由管理者执行。已核实（2026-10-16）：同事账号 `xiaoyihaishiaini` 已接受 write 邀请（邀请 ID `337920044`），**GitHub API 实测 `permission = write`**；[Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) 已实际绑定 assignee `xiaoyihaishiaini`（OPEN）。GitHub 的 write 权限在本仓库**技术上也能直接 push main**；本文档的约定（走分支 + PR）是对人的约定，**不能技术阻止**直接推 main。用户已授权同事自动合并，**无需再卡权限确认**。

## 4. 共享同步机制

跨电脑同步以 **GitHub 仓库 + 按任务 Issue / PR + 版本化任务文档**为准：

- 权威状态在 **仓库文件 + GitHub Issue / PR**，不在任何单台电脑的磁盘、聊天记录或 `.agent-runs/`。
- **不共享** worktree 目录、服务端口或进程 ID；每台电脑各自建立独立 worktree 与分支。
- 分支统一命名 **`codex/<member>/<task>`**（如 `codex/xiaoyihaishiaini/rc-b-reports`）。
- 原始运行日志留在各机 Git 忽略目录 `.agent-runs/`，仅本机可查；对外（PR / 交接）只写**不含敏感数据的摘要**。
- 路径统一使用**仓库相对路径**；确需说明本机位置时用 `<repo>` 占位（`<repo>` = 该成员自己的克隆目录），**不把负责人的 home / 绝对路径写成同事默认**。
- 既有 `tax-browser` 的绝对路径（`D:/有数云fork/.worktrees/tax-browser`）只是**负责人本机现场**，**不要求同事去找 / 重做**；同事可见的是其版本化交接摘要与源码规则。

## 5. 版本化交接契约

每次交接必须是**版本化文档**（仓库内 Markdown，纳入 Git），至少包含：

1. **基线**：分叉时 `origin/main` 的完整 SHA；
2. **已审核 head**：管理者已验证的完整 head SHA；
3. **验证命令与结果摘要**：命令、工作目录（仓库相对）、实际数字与退出码摘要（原始日志不放入仓库）；
4. **依赖契约**：本任务给下游的接口 / 数据契约，与上游依赖；
5. **未完项**：未完成、阻塞、风险与下一任务输入。

交接模板见 [handoffs/TEMPLATE.md](handoffs/TEMPLATE.md)。原始日志本地忽略，公开材料只用无敏感摘要。

## 6. 文件所有权矩阵

**共享受控文件**（同一时刻只能有一个编辑责任人）：

| 共享文件 / 区域 | 当前唯一编辑责任人 | 说明 |
|---|---|---|
| `06-workbench/server/accounting.mjs` | 项目负责人（RC-3 统一协调） | 会计核心；B **不得**与 A 同时改 |
| `06-workbench/server/coa.mjs` | 项目负责人（RC-3） | 科目表 / 准则 |
| `06-workbench/server/db.mjs` | 项目负责人（RC-1 / RC-2） | 持久层与迁移 |
| `06-workbench/server/server.mjs` | 按任务登记（见 §7） | 接口挂载，接线改动可走独立集成 PR |
| `06-workbench/server/agent-tools.mjs` | 按任务登记 | Agent / MCP 工具注册 |
| MCP 注册（`finance-mcp/{tools.mjs,backend.mjs}`、`tax-tools.mjs`） | 按任务登记 | 契约同步 |
| `06-workbench/scripts/test-all.mjs` | 项目负责人 | 评测入口；**不得覆盖**新版（含 IMPORT-STRICT 套件） |
| `06-workbench/package.json` | 项目负责人 | 脚本 / 依赖（零第三方依赖） |
| `06-workbench/public/app.js` / `index.html` | 按任务登记 | 前端 |
| 共享状态 / 索引文档（`docs/handoffs/STATE.md`、`docs/INDEX.md`、`docs/CHANGELOG.md`） | 按任务登记 | 索引同步 |

**新增模块归属**：

- `report-export`（内部报表导出，RC-4）与 `tax-report-format.mjs`（税局申报格式，RC-5）→ **同事 B**（`tax-report-format.mjs` 是 `tax*` 规则的**模块名专属例外**）；
- `tax*` 税务采集 / 登录 / 会话（如 `tax-gateway.mjs`、`tax-browser*.mjs`、`tax-import.mjs`）与 `import*` 数据 / 适配 / 定向导入 → **负责人 A**；
- **所有协作文档 / 任务单统一遵循本条规则**，不再出现「`tax*` 一律归 A」与「`tax-report-format` 归 B」的冲突表述。

**规则**：

- 每个任务在任务单里登记**当前唯一编辑责任人**；同一共享文件不得有两个任务同时声称编辑。
- 共享**接线**改动可以走后续**独立集成 PR**，或申请**短期文件所有权**（共享文件规则**允许协商短期所有权，无需每个 PR 都问用户**）；**不得**把共享文件责任推给管理者去亲写业务代码。
- 任务锁 / 认领必须**远端可见**：建议每个任务一个 GitHub Issue；开工前查看 assignee / 状态 / 最新 PR，由负责人确认同一文件唯一持有人。**禁止把仅本地的一份编辑表格当作全局锁**。
- 合并需协调，避免两个 PR 各自在**不同基线**上验证后同时合入：合并前核对最新 `origin/main`；基线变动就**重验受影响范围**；锁定已验证 head 再合并。**GitHub 不能原子锁 base**，该限制如实写明；共享关键变更**串行合并**，可用远端 Issue 明确当前整合人，但**不声称评论等于技术互斥**。

## 7. 任务生命周期与认领规则

生命周期：**已分配（assigned）→ 开发中（in progress）→ 审查中（review）→ 已合并（merged）/ 阻塞（blocked）**。

- 任务以 GitHub **Issue** 为载体（模板见 `.github/ISSUE_TEMPLATE/requirement.md`），任务文档在 `docs/tasks/`。
- 开工前：确认 Issue assignee、状态、最新 PR；确认文件所有权唯一；拉最新 `origin/main` 建 `codex/<member>/<task>` 分支。
- 初始状态一律写**「已分配 / 待开工」**，**不是「开发完成」**；完成后由本人管理者验证并更新。
- 首个任务包可细分为 `A0` / `B0` / `B1` 等，每个都写明：需求、非目标、输入 / 输出建议、文件范围、验收、依赖与阻塞路径、交接对象。
- **总任务与子任务**：总任务用 Issue（如 #13 / #14）承载；子 PR 用 `Refs #13` / `Refs #14` 关联，**不因 A0 / B0 完成就 Closes 总任务**；新子需求可另开 Issue 链接总任务。只有总任务所有验收完成才关闭总 Issue。
- **纯模块与合成 DTO 测试可在集成依赖完成前开发**：`report-export` / `tax-report-format` 的独立模块实现可基于已协商 DTO 先行；**完整集成验收**才依赖 RC-3 / 接线。
- `RC-3`（会计核心改动）由负责人统一协调；根据 B 的报表口径发现**另开聚焦任务**，**不得** B 和 A 各改一份 `accounting.mjs`。

## 8. 跨成员评审安排

跨成员评审按**任务风险**与**共享文件需求**决定，不以「每 PR 强制人工批准」为默认：

- 触碰会计核心、共享接线、数据边界或破坏性操作的任务 → 安排跨成员评审（至少另一名成员的本机 Codex 独立复核）；
- 纯新增模块（如 `report-export` / `tax-report-format.mjs`）在文件所有权清晰、验收可独立复现时 → 成员本机 Codex 自审后合并即可，**跨成员评审可选**；
- 共享文件的多 PR → **串行**，后合并者必须基于已含前者结果的基线重验。
- 跨成员 / 跨任务协作与共享文件所有权协商均可不依赖用户逐次批准；只有**扩大授权或改变范围**时才问。

## 9. 凭据与数据边界（不可协商）

- 每名成员使用**自己的** GitHub / Codex / 模型服务凭据；**绝不**复制负责人的 token / config / session / 账套数据库。
- 延续本项目**必要源码、任务说明、合成测试错误**到已授权 tokenhub 的范围；**同项目新机器不重复索取已有授权**，但必须**核实服务与允许模型**，**不得扩大到别的服务**。
- **仅允许本机执行员工 GLM 5.3 / DeepSeek V4.1 Flash**（主 / 回退显式锁定）；**Codex 自身的模型不受此限制**。
- 真实账套数据与税务凭据**不发到模型服务**；真实登录、验证码、凭据只在用户 / 成员**本机可信界面**处理，不回传原文；自动测试只用**合成数据**；**不得覆盖生产库**，不绕过沙箱。

## 10. 官方参考（管理者已读，短摘要）

- [Codex AGENTS.md 文档](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：Codex 工作前读取 `AGENTS.md`；仓库指令随代码一起传递。
- [Codex Skills 文档](https://learn.chatgpt.com/docs/build-skills)：Codex 扫描仓库 `.agents/skills` 与用户 `~/.agents/skills`；**同名技能不合并**；仓库 `team-skills/` **不是自动发现路径**，需显式读取或审查后安装。
- [个人仓库权限级别](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository)：个人私有仓库协作者 **write** 可创建并合并 PR；这**不是**独立的 Codex GitHub 账户。
- [受保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)：私有仓库保护需相应计划；本仓库 API 实测**不支持**，**不虚构已启用**。

## 11. 明确不做

- 不做多租户 / SaaS / 对外服务；开发多人不改变产品形态。
- 本轮**不新增 GitHub Actions、`CODEOWNERS` 或规则集**；**不声称已有 CI / 分支保护**。这是**本轮实现范围**，不是永久禁止后续建议；**后续治理变更经项目负责人授权即可评估**。
- 不修改 `team-skills/` 内容、不安装技能到他人全局目录（沿用仓库副本，成员自己的 Codex 审查后自行安装）。
- 不新增脚本 / 业务代码（本轮为文档与模板）。
- **本轮本地员工未代发任务 Issue**；总任务 Issue [#13](https://github.com/huxiaoyang-code/youshu-fork/issues/13) / [#14](https://github.com/huxiaoyang-code/youshu-fork/issues/14) 已由管理者建立并分配。
- **不擅自改远端设置（公开 / 付费 / 迁移）**；当前 API 403 等限制是当前计划下的实际限制，不是永久产品限制。
