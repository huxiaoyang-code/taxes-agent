# VOUCHER-AMOUNT-GUARDS · 首包交接

日期：2026-10-19。状态：**实现、管理者内容审查及独立验证完成；跨成员复核条件待满足，PR 待创建、未合并**。任务与文件所有权见 [任务单](../tasks/VOUCHER-AMOUNT-GUARDS.md)，全量后续安排见 [开发接管计划](../DEVELOPMENT-TAKEOVER-PLAN.md)。

## 基线与授权

- 仓库：`huxiaoyang-code/youshu-fork`；总任务 [Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)，负责人 `huxiaoyang-code`。
- 分叉基线：`654a403b78f9fe91166d5c8de62d8f15103065b7`；分支：`codex/huxiaoyang-code/voucher-amount-guards`。
- Node `v24.15.0` 与 `node:sqlite` 内存库已由管理者实测通过。基线 `06-workbench` 下 `npm test`：**10 套 336 项，exit 0**，合成临时库。
- 本轮用户明确授权 Codex subagent 并发替代本地 pi / Claude Code；实现、测试、文档分文件负责，管理者独立验收及 Git / PR。未改全局技能或长期章程。
- PR [#18](https://github.com/huxiaoyang-code/youshu-fork/pull/18) 为 Draft，固定 head `346e1c307379e9a6bf96ef34244dee154558777f` 的业务 PRD 已只读核对；PR [#19](https://github.com/huxiaoyang-code/youshu-fork/pull/19) 为 OPEN，head `a47a53c3e7b077edcf827ee34aa40450cc3694ff`，当前无 review，已请求 `xiaoyihaishiaini`。二者未并入本包。Issue #13 / #14 / #17 / #20 仍 OPEN。

## 交付行为与验证记录

实现已通过管理者内容审查及独立验证：拒绝直接凭证的非法金额与畸形分录，统一预检和持久化金额，保持失败原子性；严格导入既有保护不重写。尚未满足全部合并门槛，不等同已合并。

- 接受有限数字、普通十进制文本；文本 trim 后允许符号、`.5`、`1.`、前导零，拒绝指数 / 十六进制 / 千分位 / 货币前缀 / 内部空白。`undefined` / `null` / 空白为零，全零分录仍拒绝。
- 非零负值在舍入前拒绝，包括负文本下溢；每侧原始金额上限 `999999999999.99`，文本边界精确比较防止转换丢尾数。合法数值按既有两位舍入规则处理。
- 非数组分录集合、稀疏数组、非对象或数组分录均失败。`checkVoucher` 保留 `ok` / `errors` / `total_debit` / `total_credit` 返回契约；创建 / 过账保留 `voucher_invalid` 及 `details`。归一化分录内部复用，不加入对外预检返回。

| 证据 | 当前记录 |
|---|---|
| 新增回归在未修改实现上运行 | `06-workbench` 下 `node test/voucher-amount-guards.test.mjs`：41/95 通过、54 失败，exit 1；有效红灯已记录于本机忽略目录 `.agent-runs/voucher-amount-subagent-red.log` |
| 实现后的新增回归及全套测试 | 执行者在 `06-workbench` 运行 `node test/voucher-amount-guards.test.mjs`：103/103 通过，exit 0；本机日志 `.agent-runs/voucher-amount-subagent-green.log`。管理者独立全套结果见下一行 |
| 管理者实际 diff 审查及独立复验 | 已阅读实际代码 / 测试、三份新文档及索引 diff；独立在 `06-workbench` 运行 `npm test`：**11 套 439 项全部通过，exit 0**。日志位于主仓库忽略目录 `.agent-runs/voucher-amount-independent-all.log`，退出码记录为同名 `.exit` 文件 |
| 另一名成员本机 Codex 复核 | 待满足；本轮并发 subagent 不能替代跨成员证据 |
| 已审核代码提交 SHA | `dcfe9c2549e07b49bb1ad4ad0b7a4b2c409a6219`（三个代码 / 测试文件）；最终含文档的 PR head 待创建 PR 后核对 |
| 本包 PR / merge SHA | 待创建 / 待合并 |

实现 subagent 自测：`06-workbench` 下分别运行 `node test/accounting-guards.test.mjs`（23/23）、`node test/accounting-derived.test.mjs`（31/31）、`node test/import-strict.test.mjs`（54/54），均 exit 0；`git diff --check` exit 0。此为执行者自测，不代替管理者验收。此前本地 pi 的失败或被停止运行不计交付证据。

红灯后新增 8 项“非零侧会被强制转换为有效数值”的回归，最终为 103 项；不能称这 103 项都曾在原实现跑过。第一次绿灯为 102/103，失败是新增测试错误地将 Agent 入口的非数组 `entries_required` 契约当作领域 `voucher_invalid`；按既有入口契约修正断言后为 103/103，未修改入口来迁就测试。

提交前，管理者复核三个代码 / 测试文件的 SHA256，**3/3 与独立验收内容一致**；随后仅删除新增测试文件末尾一个空白行，无逻辑变化。该差异已审查，未因此重复业务测试；暂存差异 `git diff --cached --check` 通过。上述代码提交可追溯到已验证内容，文档提交另行记录。

额外 `independent_review` subagent 已只读复核实际代码、测试及三份新文档，未发现可信的阻塞问题或必须补充的遗漏；其未运行测试。该复核是本轮独立内容审查的补充，**不构成另一名人类成员的本机 Codex 复核**，不能据此宣称跨成员门槛已满足。

## 恢复与下游输入

- 先核对当前 Git 状态、在途 PR 和执行会话，不因会话中断重复派工；本文件不声称本机全部进程已退出。
- `scripts/test-all.mjs`、`docs/tasks/README.md`、`docs/handoffs/STATE.md` 与 PR #19 重叠，必须串行整合；main 变化后重验影响范围并锁定待合并 head。
- 关闭本包执行会话需在验收、合并、交接完成后进行；下一包采用新会话。本包未完时保留证据与文件。
- 后续继续处理金额精度、封账完整性、资产卡片与总账一致性、真实数据来源、连续两月定向导入及全量 PRD，不能把本包通过解释为会计核心或全国税务全部完成。
- [税局 checkpoint](TAX-POSTLOGIN-CHECKPOINT.md) 继续暂停；无真实登录、采集、申报或缴款。用户在本机配合且满足 checkpoint 前置条件后才另行恢复；自动点击浏览器路线永久不用。
- 回退通过新的 revert PR，禁止重写 main；真实账套与凭据不用于自动测试。
