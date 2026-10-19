# VOUCHER-AMOUNT-GUARDS · 直接凭证金额校验

- 状态：**已合并，业务修复已交付**；[PR #22](https://github.com/huxiaoyang-code/youshu-fork/pull/22) 于北京时间 2026-10-19 22:12:36 合并，merge `0dee7655ab348e20293fed006fc6075c02a42ad4`。
- 日期：2026-10-19；负责人及唯一文件责任人：`huxiaoyang-code`。
- 基线：`654a403b78f9fe91166d5c8de62d8f15103065b7`；分支：`codex/huxiaoyang-code/voucher-amount-guards`，独立 worktree。
- 总任务：[Issue #20](https://github.com/huxiaoyang-code/youshu-fork/issues/20)，子 PR 使用 `Refs #20` / `Refs #17`，不关闭总任务。
- 输入：[接管任务](FULL-DEVELOPMENT-TAKEOVER.md)、[接管交接](../handoffs/FULL-DEVELOPMENT-TAKEOVER.md)、[开发接管计划](../DEVELOPMENT-TAKEOVER-PLAN.md)。输出与证据：[本包交接](../handoffs/VOUCHER-AMOUNT-GUARDS.md)。

## 本轮执行授权

用户本轮明确要求“直接起并发用 subagent 去执行，不需要用本地 agent 执行了”。该授权后，本包改由 Codex subagent 分别负责实现、回归测试和文档，管理者独立审查、验证及执行 Git / PR，不再启动 pi / Claude Code。此前本地 pi 的失败或被停止运行不计交付证据。该授权优先于旧任务包的执行者限制，仅记录本轮，不修改全局技能或将其泛化为永久章程变更。三个 subagent 不构成另一名人类成员的本机 Codex 复核。

用户随后明确授权：“只要不是完成代码的subagent复核就行，用另一个独立subagent，不要有上下文污染复查并且合并代码”。本包跨成员要求据此由新的独立 subagent 复核替代，仅适用于本包 / 本轮，不改变其他任务要求，也不代表另一名人类成员或 GitHub 第二账号批准。

完成验证：管理者已阅读实际 diff，并独立在 `06-workbench` 运行 `npm test`：**11 套 439 项全部通过，exit 0**。未参与实现的 `clean_pr22_review` 以 `fork_turns=none` 启动，不继承聊天或接收前序审查结论，独立复核最终 head `147e71f7f783af086ad136808ebb6cc3f7d2d262`，新套件 **103/103、exit 0**，额外合成边界验证通过，无可信阻塞。管理者已核对该 head 与 merge 的完整树一致。证据详见交接；本次收尾仅改文档并检查链接 / 格式，不重复业务测试。

## 问题与契约

`checkVoucher` 原使用 `r2(Number(raw) || 0)`，可把 `bad-amount` 静默当成零，让非法输入通过。严格旧账导入已有保护，本包只修直接凭证的预检、创建和过账调用链。

- 金额仅接受有限数字或明确语法的普通十进制文本。拒绝垃圾或部分解析文本、非有限值、布尔、数组、对象和超界金额；负数及超界检查先于两位舍入，防止极小负值被舍入掩盖。
- 缺省、`null`、空白借贷栏沿既有调用契约按零处理；整行借贷均零仍非法。十进制文本可带首尾空白、正负号、小数点及前导零（如 `.5`、`1.`），非零负值仍拒绝；不接受指数、十六进制、千分位、货币前缀、内部空白。每侧原值上限 `999999999999.99`，文本精确比较边界后再转换，避免丢失尾数绕过。
- 分录集合必须为数组、每项必须为分录对象；畸形输入给出失败，不意外抛出未处理异常。金额及合计均必须有限。
- 预检与正式保存采用同一归一化结果；合法值按两位金额落库。非法创建不得产生期间、凭证、分录或修改既有账套内容；既有非法凭证不得过账。
- 保留合法草稿、直接过账、正常草稿过账、折旧及结转派生调用和严格导入的既有行为。

本包不重构全库 `REAL` 金额存储、精度体系、期间日期规则、封账前置或报表口径。这些属于接管计划后续必做工作。

## 文件所有权

下列文件已在 Issue #20 登记由 `huxiaoyang-code` 唯一负责；执行者按文件分工，互不修改对方文件。

| 执行分工 | 唯一允许修改文件 | 限制 |
|---|---|---|
| 实现 subagent | `06-workbench/server/accounting.mjs` | 仅直接凭证形状、金额校验及持久化一致性 |
| 测试 subagent | `06-workbench/test/voucher-amount-guards.test.mjs`；`06-workbench/scripts/test-all.mjs` | 新增合成回归；入口仅追加套件，保留旧项 |
| 文档 subagent | `docs/tasks/VOUCHER-AMOUNT-GUARDS.md`；`docs/handoffs/VOUCHER-AMOUNT-GUARDS.md`；`docs/DEVELOPMENT-TAKEOVER-PLAN.md`；`docs/tasks/README.md`；`docs/handoffs/STATE.md` | 后两项仅追加本包索引，不改历史 |

`scripts/test-all.mjs`、任务看板与 STATE 和在途 PR #19 重叠。管理者串行整合，后合并包以包含前包结果的 main 重新验证；Issue 登记不等于技术锁。PR #18 只读，PR #19 不在本包盲目合并或删除。禁止扩大到 HTTP / Agent 接线、DB、COA、前端或其他既有测试。

## 验收与合并门槛

1. 先在原实现运行新增合成回归并记录真实红灯及退出码，再修实现。
2. 覆盖领域 `checkVoucher` / `createVoucher` / `postVoucher`、真实本机 HTTP REST 和 `POST /agent/tools/voucher_check`、`voucher_create`。不能用 JSON 序列化后已变成 `null` 的 `NaN` 冒充非有限值测试。
3. 用临时合成数据库及实际分配的本机端口；用完整内容快照证明非法创建无副作用。注入非法既有凭证只发生在合成库，检查过账失败且内容不变。合法正例独立手算并核对落库值。
4. 子进程关闭并确认退出后清理临时库；运行 `06-workbench` 下 `npm test`，保留旧断言，记录实际套件数、项数与退出码。
5. 管理者读实际 diff、独立复验、检查当前 main 与待合并 head；原 [团队协议 §8](../TEAM-COLLABORATION.md#8-跨成员评审安排) 的本包跨成员要求已按上述用户明确授权调整，并由未参与实现、无历史上下文的独立 subagent 完成复核。不伪造 GitHub 第二账号批准。
6. 已按授权合并并补录 PR / head / merge SHA；回退使用新的 revert PR。其他业务包继续按接管计划推进，本轮不启动新包。

全程仅使用合成数据；真实税局 checkpoint 继续暂停，不恢复登录或采集。真实数据、凭据、会话不进模型、Git 或日志；外部真实提交仍须操作者操作前按批次确认。
