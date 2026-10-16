# 成员入场包 · MEMBER ONBOARDING

> 本文件可直接转发给新成员（同事）。它**自足**：不依赖负责人电脑上的任何路径、进程或聊天记录。
> 读完本文件 + [团队协作协议](../TEAM-COLLABORATION.md) + [项目章程](../PROJECT-CHARTER.md) 即可开工。
> 占位符 `<repo>` = 你（新成员）自己的克隆目录，可放在你喜欢的任何位置。**示例命令只是示例，本文不声称已在你的机器上实跑。**

## 1. 你要加入的项目（30 秒版）

- 本项目是本机**单用户**财税工作台：一名操作者在自己电脑上运行，可对**多家企业 / 多个账套**批量处理。**开发多人 ≠ 产品多租户**；不做 SaaS / 对外服务 / 账户体系。
- 当前目标是**报表闭环**：办税员账号 → 验证码 → 登录 → 授权企业 / 账套 → 财务操作 → 出报表；**两类报表都要**（内部 3 表 + 余额表 / 明细账，以及税局申报格式）。方案见 [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md)。
- 你（同事 `xiaoyihaishiaini`）负责 **RC-4 / RC-5**：两类报表的口径核对与导出，以及报表现状口径盘点。入口任务见 [RC-B-REPORTS](../tasks/RC-B-REPORTS.md)（总任务 [Issue #14](https://github.com/huxiaoyang-code/youshu-fork/issues/14)）。
- RC-B 已有进展：B0 口径 / 契约盘点与 B1 五类内部 CSV 已实现并通过审查合并（[PR #15](https://github.com/huxiaoyang-code/youshu-fork/pull/15)，见 [RC-B 交接](../handoffs/RC-B-REPORTS.md)）。**B2 税局可上传申报文件、RC-3 / RC-6 尚未完成**；接续时**不退回 B0 待开工**。
- 全国电子税务局是长期目标，**当前真实接入数 0**；预留接口不等于已接入。

## 2. 身份与访问

- 仓库 URL：`https://github.com/huxiaoyang-code/youshu-fork`（**private**）。
- 你的 GitHub 账号：`xiaoyihaishiaini`。
- **邀请状态（2026-10-16 管理者实测）**：项目负责人已向你发出协作者 write 邀请（邀请 ID `337920044`），且**你已接受**；GitHub API 实测你的 `permission = write`，push、开 PR、review、合并自己的 PR 均已具备。**不需要 admin 权限**，不需要改仓库设置。
- 自行完成本机登录（**不要**复制负责人的任何凭据）：

```bash
gh auth login          # 用你自己的 GitHub 账号，选择 HTTPS + 浏览器 / token
gh auth status         # 确认已登录且账号正确
```

- 事实核对（只作了解）：private、`owner.type = User`、`main` 无分支保护、rulesets API 返回 403（需 GitHub Pro 或公开仓库）。**不擅自改远端设置、不建议公开仓库**。写权限技术上也能直接推 main，但**约定走分支 + PR**。

## 3. 克隆与环境核验

**克隆而不是拷贝负责人的目录**（不复制 DB、凭据、`.agent-runs`、`node_modules`、临时 profile）。

> 下面命令**不含占位符以外的假设**；`<repo>` 与目录名请替换成你自己的值。`&&` 在 Windows PowerShell 5.1 不支持，因此**逐行执行**。

```bash
git clone https://github.com/huxiaoyang-code/youshu-fork.git <repo>
cd <repo>
git checkout main
git pull
```

**零第三方依赖**：`package.json` 无依赖，**不需要 `npm install`**。不要把 `npm install` 当成必要步骤（缺失依赖才需要排查，而不是先装一堆包）。

在本机核验工具链（**实际探测**，不要照抄负责人的版本号）：

| 工具 | 最低要求 | 核验命令 | 说明 |
|---|---|---|---|
| Git | 任意近期版本 | `git --version` | 用于克隆 / 分支 |
| Node.js | **≥ 22.5.0** | `node --version`，并实测 `node -e "require('node:sqlite'); console.log('sqlite ok')"` | 关键：依赖 `node:sqlite` 内置模块 |
| GitHub CLI | 任意近期版本 | `gh --version`、`gh auth status` | push / PR / review |
| 本地执行员工 | pi 或 Claude Code | 见 §6 | 二者留其一即可 |

Windows 用户注意：示例命令里的路径、盘符、临时目录**由你自己的机器决定**，本文不写负责人的 home / 绝对路径作为默认值。

## 4. 用临时合成数据跑现有测试

**重要边界**：仓库历史上的 **7 套 262 项**、**smoke 28 项**是**旧基线的已通过事实**；当前 main（`c2d5619`）管理者复验为 **10 套 336 项**。这些都**不代表你的新电脑已经通过**；请以你本机的**实际结果**为准并记录（成功或失败都如实记录）。

**永远不要覆盖 / 指向生产库**。用**专用临时目录**，并**先保存旧的 `WORKBENCH_DATA_DIR`，结束后恢复**；所有 `npm` 命令都**显式记录退出码**：

```powershell
# 示例（在你的仓库根目录逐行运行）；<repo> 之外的路径由你自己的机器决定
$oldDataDir = $env:WORKBENCH_DATA_DIR
# 目录边界校验：先把 TEMP 与目标目录规范化（GetFullPath），再比较前缀（TEMP 末尾补分隔符），
# 避免 "C:\Temp2" 误判在 "C:\Temp" 内。创建前先校验。
$sep = [string][System.IO.Path]::DirectorySeparatorChar
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
if (-not $tempRoot.EndsWith($sep)) {
  $tempRoot += $sep
}
$tmpDataDir = [System.IO.Path]::GetFullPath((Join-Path $tempRoot ("youshu-onboarding-" + [guid]::NewGuid().ToString("N"))))
if (-not $tmpDataDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "临时目录不在 TEMP 内，停止：$tmpDataDir"
}
New-Item -ItemType Directory -Force -Path $tmpDataDir | Out-Null
try {
  $env:WORKBENCH_DATA_DIR = $tmpDataDir
  Push-Location 06-workbench
  try {
    node --version
    npm test
    Write-Host "npm test exit=$LASTEXITCODE"
    npm run test:smoke
    Write-Host "npm run test:smoke exit=$LASTEXITCODE"
  } finally {
    Pop-Location
  }
} finally {
  # 恢复旧值，避免污染后续会话；临时目录保留供排障，不自动递归删除
  $env:WORKBENCH_DATA_DIR = $oldDataDir
  Write-Host "临时数据目录（保留供排障）：$tmpDataDir"
}
```

- **每个 npm 命令的退出码都要如实报告**；失败时不要为了「通过」删改断言或伪造结果。
- **不自动 `Remove-Item -Recurse -Force`** 该临时目录：保留现场便于排障；确需清理时由你自行确认路径确在 `TEMP` 内再手工删除。
- 失败时**记录实际错误原文**（命令、工作目录、退出码、报错行），先判断是**环境问题**（Node 版本 / `node:sqlite` 不可用 / 端口占用 / 权限）还是代码问题。环境问题按 §8 处理。

## 5. 分支、任务与文件所有权

```bash
git fetch origin
# 建独立 worktree（推荐）：在克隆主目录之外另开目录，不干扰主目录当前检出
git worktree add <worktree-path> -b codex/<member>/<task> origin/main
# 例：git worktree add ../youshu-rc-b -b codex/xiaoyihaishiaini/rc-b-reports origin/main
# 随后在该 worktree 目录内工作（cd <worktree-path>），主目录保持在 main。
# 若不使用独立 worktree，也可在克隆目录内切换分支：
git checkout -b codex/<member>/<task> origin/main   # 例：codex/xiaoyihaishiaini/rc-b-reports
```

- 开工前在 GitHub 上确认你的任务 Issue 的 **assignee / 状态 / 最新 PR**，并确认你要改的共享文件当前**无冲突**：由本任务持有（或已协商取得短期所有权）后方可编辑（见 [团队协作协议 §6 文件所有权矩阵](../TEAM-COLLABORATION.md)）。
- 你的新模块 `report-export`（RC-4）与 **`tax-report-format.mjs`**（RC-5）归你；`accounting.mjs` / `coa.mjs` / `db.mjs` / `server.mjs` / MCP 注册 / `package.json` 等属**共享受控文件**，改动前先申请或走独立集成 PR，**不要**与负责人同时改 `accounting.mjs`。
- 归属规则以 [团队协作协议 §6](../TEAM-COLLABORATION.md) 为准：`tax*` / `import*` 税务采集 / 登录 / 定向导入 → 负责人 A，**`tax-report-format.mjs` 是模块名专属例外 → 你（B）**。
- 初始任务状态是**「已分配 / 待开工」**，不是「开发完成」；`Refs #14` 关联子 PR，**不因 B0 / B1 完成就 Closes 总任务**。

## 6. 本地执行员工与模型约束

- 固定范式：**本机执行员工实现，你自己本机 Codex 管理 / 审查 / 提交 / 合并**（见 [本地优先技能](../../team-skills/local-agent-first/SKILL.md)）。
- 你的本机 Codex **不直接补写业务代码 / 测试 / 交付文档**，即使小修也退回本机员工。
- **执行员工只允许 GLM 5.3 或 DeepSeek V4.1 Flash**，主模型与回退模型**都显式锁定**；不得使用其他模型或子 agent。启动前通过本机帮助 / 模型清单**核实模型 ID 及其映射**，不猜 ID。该约束**不**限制你自己 Codex 的模型。
- 本机执行员工**不执行 Git 提交 / 推送 / 合并**；由你本机 Codex 在审查通过后执行。

**技能仓库的读取 / 安装**：

- 仓库权威技能在 `team-skills/local-agent-first/SKILL.md`，可**显式读取 / 执行**（`team-skills/` **不是** Codex 自动发现路径）。
- 如果你想安装到自己的 Codex 技能目录：先由**你自己的 Codex 审查内容**，**检查同名技能避免覆盖**，再安装。
- 官方当前支持的用户技能目录是 **`~/.agents/skills`**；负责人机器上的 `~/.codex/skills` 只是**那台机器的本机事实**，**不是**通用硬编码路径。
- **不要**写「配置全开权限 / 禁用审批」之类的设置；权限与实际授权匹配。

## 7. 提交与合并

- 走 `codex/<member>/<task>` 分支 + PR；PR 正文用 [PR 模板](../../.github/pull_request_template.md)，写明需求 / 验收结果、文件所有权与共享改动协商、依赖与基线、成员与执行员工模型、Codex 独立验证、真实数据边界、验证 head、自动合并权限 / 协调记录、回退与交接。
- 你可以在**满足验收与整合约束**后**自动合并自己的 PR**（用户已授权）；不需要其他成员逐 PR 批准，也不需要用户逐一确认。
- 合并前：`git fetch origin`、把分支更新到最新 `origin/main`、**重验受影响范围**、核对最新 `origin/main` 后**锁定已验证 head**。**GitHub 不能原子锁 base**：若两个 PR 基于不同基线，共享关键变更要**串行合并**。

## 8. 缺 pi 或环境不可用时

- **缺 pi 不能让你的 Codex 接手写业务代码**。先在**当前已授权的客户端、服务与已核实获准模型**之间诊断 / 重试 / 切换：
  - 核实 Node / `node:sqlite` / 端口 / 权限等环境项；
  - 核实旧进程与交接，避免重复启动或覆盖未完成成果；
  - 环境问题**记录实际错误**，不覆盖生产库。
- 持续不可用：**保留任务与交接、报告阻塞**；只有需要改变角色或扩大授权时才询问负责人。
- **不得**仅因换了新会话就推断任务丢失，先读交接恢复。

## 9. 凭据与数据边界

- 用**你自己的** GitHub / Codex / 模型服务凭据；绝不复制负责人的 token / config / session / 账套 DB。
- 真实账套数据与税务凭据**不发到模型服务**；真实登录 / 验证码 / 凭据只在你**本机可信界面**处理，**不回传原文**，不进日志 / Git / PR。
- 自动测试**只用合成数据**；不覆盖生产库；不绕过沙箱。
- 项目已授权的必要源码 / 任务说明 / 合成测试错误可发到**已授权 tokenhub** 范围；同项目新机器**不重复索取已有授权**，但必须**核实服务与允许模型**，**不得扩大到别的服务**。

## 10. 你需要知道的事实来源

- 现行任务排序与工作包：[报表闭环补全方案](../REPORT-CLOSURE-PLAN.md) · [阶段状态](../handoffs/STATE.md)
- 协作协议与文件所有权：[团队协作协议](../TEAM-COLLABORATION.md)
- 任务看板：[docs/tasks/README.md](../tasks/README.md)
- 你的任务单：[RC-B-REPORTS](../tasks/RC-B-REPORTS.md)
- RC-B 现状交接：[handoffs/RC-B-REPORTS.md](../handoffs/RC-B-REPORTS.md) · [REPORT-EXPORT](../REPORT-EXPORT.md) · [TAX-REPORT-FORMAT](../TAX-REPORT-FORMAT.md)
- 交接口径：[交接模板](../handoffs/TEMPLATE.md)

---

## 可直接复制给你的 Codex 的开场提示

```text
你是我（成员 xiaoyihaishiaini）本机的 Codex 管理者。先读：
- docs/handoffs/MEMBER-ONBOARDING.md（本文件，入场与自足说明）
- docs/TEAM-COLLABORATION.md（团队协议 / 双层角色 / 文件所有权 / 合并协调）
- docs/PROJECT-CHARTER.md 与 docs/handoffs/STATE.md（项目规则与当前状态）
- docs/tasks/RC-B-REPORTS.md（我的任务：RC-4 / RC-5）与 docs/handoffs/RC-B-REPORTS.md（B0 / B1 现状）
- team-skills/local-agent-first/SKILL.md（本地执行、Codex 管理 / 审查 / 提交 / 合并的范式）

事实与边界：
- 我是独立成员，使用我自己的 GitHub / Codex / 模型服务凭据，不复制负责人任何 token / config / session / 账套 DB。
- 产品是本机单用户、可多账套批量；不做多租户 / SaaS / 对外服务。当前目标是报表闭环，两类报表都要。
- 全国电子税务局当前真实接入 0；税局是否提供科目 / 期初 / 凭证 / 银行 / 发票不可先行承诺。
- B0 口径 / 契约与 B1 五类内部 CSV 已由 PR #15 交付；B2 税局可上传申报文件、RC-3 / RC-6 未完成，不退回 B0 待开工。
- 我的本地执行员工只允许 GLM 5.3 或 DeepSeek V4.1 Flash（主 / 回退都显式锁定，启动前核实模型 ID 与映射）；不得用其他模型或子 agent；该约束不限制你（Codex）自身的模型。
- 本地员工只做实现与自测，不执行 Git 提交 / 推送 / 合并；你负责拆解、隔离 worktree、读实际 diff、跑验证、写任务单与 PR 正文、提交 / 推送 / 合并，且不直接补写业务代码 / 测试 / 交付文档。

工作方式：
- 从最新 origin/main 建分支 `codex/xiaoyihaishiaini/<task>`（建议用独立 worktree，见 §5）；开工前确认 Issue #14 的 assignee / 状态 / 最新 PR，并确认共享文件（accounting.mjs / coa.mjs / db.mjs / server.mjs / MCP 注册 / package.json / test-all.mjs）当前**无冲突**：由本任务持有或已协商取得短期所有权后再编辑。
- 我的新模块 report-export（RC-4）与 tax-report-format.mjs（RC-5）归我；tax* / import* 采集与导入归负责人；共享接线改动走独立集成 PR 或先申请短期所有权。
- 我可以按团队协议自动合并我自己的 PR（用户已授权），前提是通过验收与整合约束；合并前拉最新 origin/main、重验受影响范围、锁定已验证 head。
- 不要新建 GitHub Actions / CODEOWNERS / 规则集，不声称已有 CI 或分支保护，不擅自改远端设置。
- 不用 npm install（零第三方依赖）；用临时合成数据目录跑测试，绝不覆盖生产库；自动测试只用合成数据。

请先核实我的环境（Git / Node ≥ 22.5.0 与 node:sqlite 实测 / gh 登录 / 本机执行员工与允许模型）、确认任务与文件范围没有冲突，然后直接按当前阶段派本地员工：从 B2 现行模板证据 / 格式 / 映射 / 成功出口开始（含向负责人汇总 RC-3 核心缺口），**不重做已交付的 B0 / B1**；只有确实缺必要输入或需要扩大授权时才来问我。
```
