# 新会话入口 · NEXT SESSION

> 本文件是新 Codex 对话的最小入口。先读本文件，再读 [项目章程](../PROJECT-CHARTER.md)、[阶段状态](STATE.md) 和 [本地优先技能](../../team-skills/local-agent-first/SKILL.md) 即可继续；历史日志（`.agent-runs/`）默认不作为新会话上下文，只在排查具体故障时按需查阅相关日志。

## 当前基线（可核验事实）

- 本轮开始时的 main 基线：`9783420a84dae2fe8a4c4b3021c07947b66fec00`（`docs: 归档第一期交付、验收与上下文重置交接 (#8)`）。这是**本轮交接起点的基线，不是新对话必须停留的 HEAD**；恢复时先核对当前 main / 远端，本轮交接 PR 合入后以实际最新提交为准。
- PR #1–#8 已合并。业务实现合并提交为 `03eba00`（PR #7）；之后 #8 为文档归档，未改业务算法。
- 208 项测试是**既有验收事实**（管理者在 main `03eba00` 上运行 `npm test`，6 套 208/208、exit 0），**不是本轮新跑**。本轮为纯文档 / Skill 变更，未重跑业务测试。
- 工具入口共 45 个：31 available（其中 7 个是税务预留接口）、1 limited、13 unavailable。**真实税局接入数 0**；入口数量不等于真实连接数。

## 未完成现场（先核对，勿重复派工）

- worktree `D:/有数云fork/.worktrees/tax-browser`，分支 `codex/tax-browser-import`，基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`。
- 状态：**未提交、未 PR、未合并**；为福建漳州浏览器登录后读取企业 / 批量新建或绑定账套的本地草稿，**不能代表全国接入**。
- 员工交接 `D:/有数云fork/.worktrees/tax-browser/docs/handoffs/TAX-BROWSER.md`；员工**自报** 272 项通过，管理者**未独立复跑**，**真实税局登录未验收**。
- 日志 `D:/有数云fork/.agent-runs/pi-tax-browser.jsonl` 退出码**尚未核实**，不能声称 exit 0。
- 保留原目录，不重置 / 删除 / 覆盖 / 重做；`IMPORT-STRICT` 仍是下一实现任务，`TAX-BROWSER` 列为**独立待审队列**（不虚构用户未做的排序决定）。

## 方向（不可漂移）

本机**单用户**财税工作台，可对多个企业 / 账套批量处理；**不做多租户 / SaaS / 租户权限平台 / 对外服务**。只保留账套隔离、操作日志、备份恢复、凭据安全等本机需要。全国电子税务局是产品目标，当前只有预留接口、真实接入 0。详见 [章程](../PROJECT-CHARTER.md) 与 [ROADMAP](../ROADMAP.md)。

## 已完成

- 记账、三大报表、试算、明细账、折旧/摊销、结转损益、封账/反结账、期间登记、旧账导入（JSON / 4 CSV，预检 + 事务）。
- MCP 45 入口与真实能力目录；全国税务适配层与异步会话契约（本地假适配器测试，未联网）。
- 6 套 208 项整体验收通过（既有验收事实，锚定业务提交 `03eba00`，不是本轮新跑）。

## 明确限制（未实现，不承诺）

- 旧账导入**非幂等**；CSV 非法金额文本会被按 0 处理，预检未完整覆盖金额 / 期间约束 → 需 IMPORT-STRICT / IMPORT-IDEMPOTENCY。
- 无本机批量任务队列与管理（并发上限、重启恢复、取消、失败重试等）→ 需 BATCH-QUEUE / BATCH-MANAGEMENT。
- 真实电子税务局 0 接入；辅助核算、银行对账、发票、申报、正式导出均未实现。
- 文档-only 变更不要求重跑 208 项；代码变更按受影响测试，关键合并基线跑全套。

## 下一任务（只明确第一个可派）

- **第一可派任务：`IMPORT-STRICT`（导入严格校验）** —— 拒绝非法金额文本，预检与正式写入使用同一套约束，失败不落库。依赖：无（基于当前 main）。
- 其余依赖任务表见 [阶段状态 §后续可执行任务表](STATE.md)。**不提前把所有接口设计死**，细节由管理者在派工任务单中约定。
- **本次交接本身不主动继续开发**；若新会话用户明确要求继续完善功能，则依据 [STATE 任务表](STATE.md) 直接从 `IMPORT-STRICT` 起派本地 agent 执行，只有缺少必要范围或授权时才询问用户。

## 必要命令

```powershell
# 每段命令都从仓库根独立运行；需要切换目录时用 Push-Location / Pop-Location 成对使用，
# 不要在多行里连续 cd 同一个子目录（第二次 cd 会在已进入目录后再拼接相对路径而失败）。
# 文档变更自查：范围 / 链接（按需）
git diff --stat
# Skill 格式（先在当前机器核实 quick_validate.py 的绝对路径）
python -X utf8 <ABS_QUICK_VALIDATE>/scripts/quick_validate.py team-skills/local-agent-first
# 代码变更时才需要（当前轮不需要），从仓库根运行：
Push-Location 06-workbench
npm test          # 全套 208 项
npm run test:smoke
Pop-Location
```

## 授权与边界

- 用户已授权：将本项目必要源码 / 任务说明 / 测试错误发送到已配置 tokenhub；验收通过后自动合并 PR。范围见章程与 [STATE](STATE.md)。
- 新仓库需重新核对当时授权范围；通用 Skill 不复制这些授权，也不推导外传授权。
- 禁止用真实账套 / 凭据做自动测试；真实账套数据与税务凭据不发到模型服务，开发所需源码 / 任务说明 / 测试错误仅按本项目已授权范围发送到 tokenhub；不绕过沙箱。

## 会话状态

- 本轮（LOCAL-BATCH-HANDOFF 文档 / Skill）的 pi 初稿、返工、最后修订与「未完成现场」补充均已实际退出、退出码 0；Claude 的**独立情境审查**也已退出、退出码 0。以上均为已核对事实，不预报未来；本轮新进程的退出码由管理者在该进程结束后核对。tax-browser 会话的**历史**退出码尚未核实，见「未完成现场」，不得据此声称 exit 0。
- 仓库权威技能 `team-skills/local-agent-first/SKILL.md` 已由管理者审查并安装到**本机** Codex 技能目录 `C:/Users/35007/.codex/skills/local-agent-first/`：本机两处文件 SHA256 与仓库副本一致，`quick_validate.py` 对仓库副本与全局版本均通过，新增 27 个本地 Markdown 链接检查通过，`git diff --check` 通过。安装路径与校验均为**本机信息**，不承诺其他电脑已安装。
- 安装前的原技能备份在 Git 忽略目录 `.agent-runs/local-agent-first-before-20261014-150009.md`，只在本机存在。

---

## 可直接复制给新 Codex 的开场提示

```text
请先读 docs/handoffs/NEXT-SESSION.md、docs/PROJECT-CHARTER.md、docs/handoffs/STATE.md
和 team-skills/local-agent-first/SKILL.md；历史日志默认不读，只在排查具体故障时按需查 .agent-runs/。
恢复时先核对当前 main / 远端：本轮交接起点基线是 9783420a84dae2fe8a4c4b3021c07947b66fec00，
它不是新对话必须停留的 HEAD，以实际最新提交为准。
PR1-8 已合并，208 项为既有验收事实（锚定业务提交 03eba00，不是本轮新跑）。
方向是本机单用户、可多账套批量（批量队列与管理尚待开发），不做多租户。
派工前先核对「未完成现场」：`.worktrees/tax-browser` 的 `codex/tax-browser-import` 有未提交实现（未 PR 未合并，员工自报 272 项通过但未经管理者复验，真实登录未验收），必须保留该 worktree，不重置 / 删除 / 覆盖 / 重做，也不视为已完成。
请继续完善，从 IMPORT-STRICT 开始：依据 STATE 任务表派本地 agent 执行，
只有缺必要范围或授权时才问我。你只负责派工、独立审查验收、Git/PR 与合并，
不直接写业务代码 / 测试 / 交付文档。
```
