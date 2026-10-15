# 新会话入口 · NEXT SESSION

> 本文件是新 Codex 对话的最小入口。先读本文件，再读 [项目章程](../PROJECT-CHARTER.md)、[阶段状态](STATE.md) 和 [本地优先技能](../../team-skills/local-agent-first/SKILL.md) 即可继续；历史日志（`.agent-runs/`）默认不作为新会话上下文，只在排查具体故障时按需查阅相关日志。

## 当前基线（可核验事实）

- 本轮文档收尾的起点是 main 提交 `67f5e4541fd05878e3d681638dcb95a9c33b799b`（`fix(import): 严格校验原始数据并统一预检与写入约束 (#10)`，PR #10 于 2026-10-15 合并）。这是**本次交接起点的基线，不是新对话必须停留的 HEAD**；恢复时先核对当前 main / 远端，后续交接 PR 合入后以实际最新提交为准。
- PR #1–#10 已合并。业务实现合并提交为 `03eba00`（PR #7）；#8 为文档归档，#9 为本地执行范式与单机批量交接（文档 / Skill），#10 为 IMPORT-STRICT 导入严格校验（业务代码）。
- 208 项测试是**既有验收事实**（管理者在 main `03eba00` 上运行 `npm test`，6 套 208/208、exit 0），**不是本轮新跑**。IMPORT-STRICT 合并后为 **7 套 262 项**（管理者在 PR #10 验证头 `aa9f08d3` 复跑 `npm test` 262/262、`npm run test:smoke` 28/28，均 exit 0；见 [IMPORT-STRICT](IMPORT-STRICT.md)）。本次文档收尾未重跑业务测试。
- 工具入口共 45 个：31 available（其中 7 个是税务预留接口）、1 limited、13 unavailable。**真实税局接入数 0**；入口数量不等于真实连接数。

## 未完成现场（先核对，勿重复派工）

- worktree `D:/有数云fork/.worktrees/tax-browser`，分支 `codex/tax-browser-import`，基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`。
- 状态：**未提交、未 PR、未合并**；为福建漳州浏览器登录后读取企业 / 批量新建或绑定账套的本地草稿，**不能代表全国接入**。
- 员工交接 `D:/有数云fork/.worktrees/tax-browser/docs/handoffs/TAX-BROWSER.md`；员工**自报** 272 项通过，管理者**未独立复跑**，**真实税局登录未验收**。
- 日志 `D:/有数云fork/.agent-runs/pi-tax-browser.jsonl` 退出码**尚未核实**，不能声称 exit 0；该历史退出码与本轮文档部分、与 IMPORT-STRICT 的 exit 0 均**不能混同**。
- 保留原目录，不重置 / 删除 / 覆盖 / 重做；`TAX-BROWSER` 列为**独立待审队列**（不虚构用户未做的排序决定）。本轮核实：其原 **14 个未提交文件内容哈希与开工时一致**，分支 / worktree 保持原样，本轮未触碰。

## 方向（不可漂移）

本机**单用户**财税工作台，可对多个企业 / 账套批量处理；**不做多租户 / SaaS / 租户权限平台 / 对外服务**。只保留账套隔离、操作日志、备份恢复、凭据安全等本机需要。全国电子税务局是产品目标，当前只有预留接口、真实接入 0。详见 [章程](../PROJECT-CHARTER.md) 与 [ROADMAP](../ROADMAP.md)。

## 已完成

- 记账、三大报表、试算、明细账、折旧/摊销、结转损益、封账/反结账、期间登记、旧账导入（JSON / 4 CSV，预检 + 事务，**严格校验**：拒绝非法金额文本、负数与超界在舍入前判定，预检与正式写入同一套约束，失败不落库）。
- MCP 45 入口与真实能力目录；全国税务适配层与异步会话契约（本地假适配器测试，未联网）。
- 6 套 208 项整体验收通过（既有验收事实，锚定业务提交 `03eba00`，不是本轮新跑）；IMPORT-STRICT 合并后 7 套 262 项（锚定合并提交 `67f5e45`，管理者复验）。

## 明确限制（未实现，不承诺）

- 旧账导入**非幂等**（每次新建账套，**不修改既有账套**，也不涉及既有账套的封账 / 既有凭证状态）→ 需 IMPORT-IDEMPOTENCY。
- 无本机批量任务队列与管理（并发上限、重启恢复、取消、失败重试等）→ 需 BATCH-QUEUE / BATCH-MANAGEMENT。
- 真实电子税务局 0 接入；辅助核算、银行对账、发票、申报、正式导出均未实现。
- 文档-only 变更不要求重跑 208 / 262 项；代码变更按受影响测试，关键合并基线跑全套。

## 下一任务（只明确第一个可派）

- **`IMPORT-IDEMPOTENCY`**（重复导入同一批次不重复建账 / 过账，可安全重试）：依赖 IMPORT-STRICT，后者已合并（PR #10，merge `67f5e45`），因此已可派工。需要先约定**批次标识 / 去重键**契约。
- 其余依赖任务表见 [阶段状态 §后续可执行任务表](STATE.md)。**不提前把所有接口设计死**，细节由管理者在派工任务单中约定。
- **本次交接本身不主动继续开发**：本文件只描述入口，IMPORT-IDEMPOTENCY 由管理者按任务单派工，本地员工不得抢跑。

## 必要命令

```powershell
# 每段命令都从仓库根独立运行；需要切换目录时用 Push-Location / Pop-Location 成对使用，
# 不要在多行里连续 cd 同一个子目录（第二次 cd 会在已进入目录后再拼接相对路径而失败）。
# 文档变更自查：范围 / 链接（按需）
git diff --stat
git diff --check
# Skill 格式（先在当前机器核实 quick_validate.py 的绝对路径）
python -X utf8 <ABS_QUICK_VALIDATE>/scripts/quick_validate.py team-skills/local-agent-first
# 代码变更 / 复审时从仓库根运行：
Push-Location 06-workbench
npm test          # 全套（IMPORT-STRICT 合并后为 7 套 262 项；更早基线为 6 套 208 项）
npm run test:smoke
Pop-Location
```

## 授权与边界

- 用户已授权：将本项目必要源码 / 任务说明 / 测试错误发送到已配置 tokenhub；验收通过后自动合并 PR。范围见章程与 [STATE](STATE.md)。
- 新仓库需重新核对当时授权范围；通用 Skill 不复制这些授权，也不推导外传授权。
- 禁止用真实账套 / 凭据做自动测试；真实账套数据与税务凭据不发到模型服务，开发所需源码 / 任务说明 / 测试错误仅按本项目已授权范围发送到 tokenhub；不绕过沙箱。

## 会话状态

- **IMPORT-STRICT 本部分是代码变更**（不是文档-only）：员工返工自测 `import-strict` 54/54、`npm test` 7 套 262/262、`npm run test:smoke` 28/28；管理者已于 2026-10-15 在 `D:/有数云fork/.worktrees/import-strict/06-workbench` **独立复跑并通过**（同结果、exit 0），随后合并 PR #10。IMPORT-STRICT 的 pi 初稿 / 返工 1 / 返工 2 三个实施会话均已实际结束，管理者核对各退出码为 0。
- 「IMPORT-STRICT 合并后交接收尾」文档会话初稿进程已由管理者核对实际退出，`.agent-runs/pi-import-strict-handoff.exit` = 0；本文件不预报当前文档修订进程的退出码，实时进程状态恢复时另行核对。
- tax-browser 会话的**历史**退出码尚未核实，见「未完成现场」，不得据此声称 exit 0，也不得与本任务的 exit 0 混同。
- 仓库权威技能 `team-skills/local-agent-first/SKILL.md` 已由管理者审查并安装到**本机** Codex 技能目录 `C:/Users/35007/.codex/skills/local-agent-first/`：本机两处文件 SHA256 与仓库副本一致，`quick_validate.py` 对仓库副本与全局版本均通过，新增 27 个本地 Markdown 链接检查通过，`git diff --check` 通过。安装路径与校验均为**本机信息**，不承诺其他电脑已安装。
- 安装前的原技能备份在 Git 忽略目录 `.agent-runs/local-agent-first-before-20261014-150009.md`，只在本机存在。

---

## 可直接复制给新 Codex 的开场提示

```text
请先读 docs/handoffs/NEXT-SESSION.md、docs/PROJECT-CHARTER.md、docs/handoffs/STATE.md
和 team-skills/local-agent-first/SKILL.md；历史日志默认不读，只在排查具体故障时按需查 .agent-runs/。
恢复时先核对当前 main / 远端：本文件记录的最新已核实基线是 67f5e4541fd05878e3d681638dcb95a9c33b799b
（IMPORT-STRICT 合并提交），它不是新对话必须停留的 HEAD，以实际最新提交为准。
PR1-10 已合并；208 项为既有验收事实（锚定业务提交 03eba00，6 套），IMPORT-STRICT 合并后为 7 套 262 项
（管理者在 PR #10 验证头 aa9f08d3 复跑，262/262 + smoke 28/28，均 exit 0）。
IMPORT-STRICT 已验收合并（PR #10），不再是待审队列；两轮返工只是过程历史，不代表仍阻塞。
方向是本机单用户、可多账套批量（批量队列与管理尚待开发），不做多租户。
派工前先核对「未完成现场」：`.worktrees/tax-browser` 的 `codex/tax-browser-import` 有未提交实现
（未 PR 未合并，员工自报 272 项通过但未经管理者复验，真实登录未验收，历史退出码未核实），
必须保留该 worktree，不重置 / 删除 / 覆盖 / 重做，也不视为已完成。
下一个可派任务是 IMPORT-IDEMPOTENCY（重复导入同一批次不重复建账 / 过账，可安全重试）：
由你依据现有代码制定批次标识 / 去重键契约与文件所有权，写入任务单后派本地员工；仅缺必要信息或授权时询问用户；
你只负责审查验收、Git/PR 与合并，不直接写业务代码 / 测试 / 交付文档；
只有缺必要范围或授权时才问我。
```
