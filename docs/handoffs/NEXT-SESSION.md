# 新会话入口 · NEXT SESSION

> 当前 RC-B 报表导出进展优先查看 [RC-B-REPORTS 交接](RC-B-REPORTS.md) 与 [任务单](../tasks/RC-B-REPORTS.md)：B0/B1 已实现，最终 PR/合并以实际记录为准；B2 的可上传申报文件及 RC-3/RC-6 尚未完成。本任务用户明确授权 Codex Subagent 实施、主 Codex 审核/提交/合并，不据旧执行器限制重新阻塞本任务。

> 本文件是新 Codex 对话的最小入口。先读本文件，再读 [项目章程](../PROJECT-CHARTER.md)、[阶段状态](STATE.md) 和 [本地优先技能](../../team-skills/local-agent-first/SKILL.md) 即可继续；历史日志（`.agent-runs/`）默认不作为新会话上下文，只在排查具体故障时按需查阅相关日志。

## 当前基线（可核验事实）

- 最近一次已知文档/业务合并是 main 提交 `cc6e789b6b398e78034d17b1e143bcf1bd58053b`（`docs: 归档 IMPORT-STRICT 验收合并与下一任务 (#11)`，PR #11 于 2026-10-15 合并）。**这是报表闭环方案的起点，不是新对话必须停留的 HEAD**；恢复时先核对当前 main / 远端，后续 PR 合入后以实际最新提交为准。
- PR #1–#11 已合并。业务实现合并提交为 `03eba00`（PR #7）；#8 为文档归档，#9 为本地执行范式与单机批量交接（文档 / Skill），#10 为 IMPORT-STRICT 导入严格校验（业务代码），#11 为 IMPORT-STRICT 交接文档归档。
- 208 项测试是**既有验收事实**（管理者在 main `03eba00` 上运行 `npm test`，6 套 208/208、exit 0），**不是本轮新跑**。IMPORT-STRICT 合并后为 **7 套 262 项**（管理者在 PR #10 验证头 `aa9f08d3` 复跑 `npm test` 262/262、`npm run test:smoke` 28/28，均 exit 0；见 [IMPORT-STRICT](IMPORT-STRICT.md)）。本报表闭环方案为文档变更，未重跑业务测试。
- 工具入口共 45 个：31 available（其中 7 个是税务预留接口）、1 limited、13 unavailable。**真实税局接入数 0**；入口数量不等于真实连接数。

## 未完成现场（先核对，勿重复派工）

- worktree `D:/有数云fork/.worktrees/tax-browser`，分支 `codex/tax-browser-import`，基线 main `9783420a84dae2fe8a4c4b3021c07947b66fec00`。
- 状态：**未提交、未 PR、未合并**；为福建漳州浏览器登录后读取企业 / 批量新建或绑定账套的本地草稿，**不能代表全国接入**。
- 员工交接 `D:/有数云fork/.worktrees/tax-browser/docs/handoffs/TAX-BROWSER.md`；员工**自报** 272 项通过，管理者**未独立复跑**，**真实税局登录未验收**。
- 日志 `D:/有数云fork/.agent-runs/pi-tax-browser.jsonl` 退出码**尚未核实**，不能声称 exit 0；该历史退出码与本轮文档部分、与 IMPORT-STRICT 的 exit 0 均**不能混同**。
- 保留原目录，不重置 / 删除 / 覆盖 / 重做；新版方案已把草稿复审列为**首包 RC-0**（`TAX-BROWSER-REVIEW`，可合理与 `LOGIN-DATA-PROOF` 统一为一个 ID）：在新隔离工作区复审 / 整合，保留原件，检查与最新 main 的冲突。本轮核实：其原 **14 个未提交文件内容哈希与本轮清单一致**（`.agent-runs/import-strict-tax-preservation.json`，逐文件 SHA256 全部命中），分支 / worktree 保持原样，本轮未触碰该目录。

## 方向（不可漂移）

本机**单用户**财税工作台，可对多个企业 / 账套批量处理；**不做多租户 / SaaS / 租户权限平台 / 对外服务**。只保留账套隔离、操作日志、备份恢复、凭据安全等本机需要。全国电子税务局是产品目标，当前只有预留接口、真实接入 0。详见 [章程](../PROJECT-CHARTER.md) 与 [ROADMAP](../ROADMAP.md)。

## 已完成

- 记账、三大报表、试算、明细账、折旧/摊销、结转损益、封账/反结账、期间登记、旧账导入（JSON / 4 CSV，预检 + 事务，**严格校验**：拒绝非法金额文本、负数与超界在舍入前判定，预检与正式写入同一套约束，失败不落库）。
- MCP 45 入口与真实能力目录；全国税务适配层与异步会话契约（本地假适配器测试，未联网）。
- 6 套 208 项整体验收通过（既有验收事实，锚定业务提交 `03eba00`，不是本轮新跑）；IMPORT-STRICT 合并后 7 套 262 项（锚定合并提交 `67f5e45`，管理者复验）。

## 明确限制（未实现，不承诺）

- 旧账导入**非幂等**（每次新建账套，**不修改既有账套**，也不涉及既有账套的封账 / 既有凭证状态）→ 在报表闭环中归入 **RC-2**。
- 无本机批量任务队列与管理（并发上限、重启恢复、取消、失败重试等）→ 报表闭环完成后再定归属（本计划不先行搭建泛用批量平台与展示大屏）。
- 真实电子税务局 0 接入；辅助核算、银行对账、发票、申报、正式导出均未实现。
- **报表无法下载导出**（仅网页查看；`downloadText` 只用于导入模板）；**无任何税局申报模板 / 字段映射 / 勾稽实现**。
- 税局是否提供科目 / 期初 / 凭证 / 银行 / 发票**不可先行承诺**；若仅有企业列表 / 申报汇总，**不能完成自动财务闭环**。
- 文档-only 变更不要求重跑 208 / 262 项；代码变更按受影响测试，关键合并基线跑全套。

## 下一任务（只明确第一个可派）

- **`RC-0` = `TAX-BROWSER-REVIEW` + `LOGIN-DATA-PROOF`（可合理统一为一个 ID）**：在新隔离工作区复审 `tax-browser` 草稿（复跑其套件、检查与最新 main 冲突、审计安全边界），并**用真实登录**验证「账号 → 验证码 → 授权企业 → 实际财务数据来源」是否成立，填写数据可得性矩阵。依赖：无（首包）。**RC-0 分两步**：无账号时先做代码审查 / 合成复验（第一步），真实验证待用户本机参与（第二步）；不会等账号才开始审查。
- 完整工作包 RC-0 ~ RC-6、数据可得性门槛、分类结论与验收场景见 [报表闭环补全方案](../REPORT-CLOSURE-PLAN.md)；依赖任务表见 [阶段状态 §后续可执行任务表](STATE.md)。
- 已替代：旧序「IMPORT-IDEMPOTENCY 第一优先」已失效；IMPORT-IDEMPOTENCY **并入 RC-2**，不再是首包。
- **本次交接本身不主动继续开发**：本文件只描述入口，RC-0 由管理者按任务单派工，本地员工不得抢跑。

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
- **本轮 REPORT-CLOSURE-PLAN 为文档变更**（新增 2 个文档 + 更新 7 个既有文档，共 9 个）：**未改业务代码 / 测试 / Skill、未重跑业务测试**。进程与退出事实**见 [REPORT-CLOSURE 交接](REPORT-CLOSURE.md)**（避免重复长日志）：本方案**初稿**、`review`、`review2` 三次实施会话均已实际退出码 0（**管理者已核实**），本次 **final** 进程的实时状态由管理者在其结束后另行核对，本文件不预报。IMPORT-STRICT 的**两个交接会话**亦均退出 0（管理者已核实）。
- tax-browser 会话的**历史**退出码尚未核实，见「未完成现场」，不得据此声称 exit 0，也不得与本任务的 exit 0 混同。
- 仓库权威技能 `team-skills/local-agent-first/SKILL.md` 已由管理者审查并安装到**本机** Codex 技能目录 `C:/Users/35007/.codex/skills/local-agent-first/`：本机两处文件 SHA256 与仓库副本一致，`quick_validate.py` 对仓库副本与全局版本均通过，新增 27 个本地 Markdown 链接检查通过，`git diff --check` 通过。安装路径与校验均为**本机信息**，不承诺其他电脑已安装。
- 安装前的原技能备份在 Git 忽略目录 `.agent-runs/local-agent-first-before-20261014-150009.md`，只在本机存在。

---

## 可直接复制给新 Codex 的开场提示

```text
请先读 docs/handoffs/NEXT-SESSION.md、docs/PROJECT-CHARTER.md、docs/handoffs/STATE.md
和 team-skills/local-agent-first/SKILL.md；历史日志默认不读，只在排查具体故障时按需查 .agent-runs/。
恢复时先核对当前 main / 远端：本文件记录的最新已核实基线是 cc6e789b6b398e78034d17b1e143bcf1bd58053b
（PR #11，IMPORT-STRICT 交接文档归档），它不是新对话必须停留的 HEAD，以实际最新提交为准。
PR1-11 已合并；208 项为既有验收事实（锚定业务提交 03eba00，6 套），IMPORT-STRICT 合并后为 7 套 262 项
（管理者在 PR #10 验证头 aa9f08d3 复跑，262/262 + smoke 28/28，均 exit 0）；报表闭环方案为文档变更，未重跑业务测试。

用户最新目标已覆盖旧优先级：最终交付是**报表闭环**
（导入办税员账号 → 接收并输入验证码 → 登录 → 获取名下企业 / 账套 → 完成所需财务操作 → 生成报表），
且**两类报表都要**：内部资产负债表 / 利润表 / 现金流量表 + 余额表 / 明细账，以及税局财务报表申报格式。
前端展示次要，功能优先。完整方案、工作包 RC-0~RC-6、数据可得性门槛与验收场景见 docs/REPORT-CLOSURE-PLAN.md，
本轮交接见 docs/handoffs/REPORT-CLOSURE.md。

方向仍为本机单用户、可多账套批量；不做多租户 / SaaS / 对外服务。全国电子税务局是长期目标，**当前真实接入 0**；
税局是否提供科目 / 期初 / 凭证 / 银行 / 发票不可先行承诺；若仅有企业列表 / 申报汇总，不能完成自动财务闭环。
验证码默认由用户从实际接收渠道取得并在本机输入；凭据与会话留本机，不进模型 / 日志 / Git。

下一个可派任务是 **RC-0 = TAX-BROWSER-REVIEW + LOGIN-DATA-PROOF**（可合理统一为一个 ID）：
分两步——无账号时先做代码审查 / 合成复验，真实验证待用户本机参与；不会等账号才开始审查。
在新隔离 worktree 复审 `.worktrees/tax-browser` 草稿（复跑其套件并记录实际结果、检查与最新 main 冲突、审计安全边界），
并用真实登录验证「账号 → 验证码 → 授权企业 → 实际财务数据来源」能否成立；结论必须明确「数据链路成立 / 不成立」。
派工前先核对「未完成现场」：该 worktree 仍是未提交实现（未 PR 未合并，员工自报 272 项未经复验，
真实登录未验收，历史退出码未核实），必须保留原件，不重置 / 删除 / 覆盖 / 重做，也不视为已完成。
IMPORT-IDEMPOTENCY 已并入 RC-2，**不从它开始**；不要续用旧会话。
你只负责审查验收、Git/PR 与合并，不直接写业务代码 / 测试 / 交付文档；
只有缺必要范围或授权时才问我。
```
