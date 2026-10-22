# 交接 · LOCAL-04-BANK 本地银行 CSV、持久对账与余额调节

- 状态：**实施与自测完成，工作区未提交**；待管理者读 diff、复现、独审、提交 / PR / 合并。本文件不预写 PR、head、merge。
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`；分支 `codex/huxiaoyang-code/local-04-bank`；工作区 `.worktrees/local-04-bank`
- 远端载体：[Issue #53](https://github.com/huxiaoyang-code/youshu-fork/issues/53)（`Refs #20` / `Refs #13`）
- 任务单：[tasks/LOCAL-04-BANK](../tasks/LOCAL-04-BANK.md) · 契约：[LOCAL-BANK](../LOCAL-BANK.md)
- 执行模型：按管理者派工锁定的授权模型（GLM 5.3 / DeepSeek V4.1 Flash 范围内的显式锁定），未启动其他模型或员工子 agent。

## 1. 本次实际交付

只新增 10 个文件，未修改任何共享文件：

```
06-workbench/server/bank-import.mjs
06-workbench/server/bank-storage.mjs
06-workbench/server/bank-reconciliation.mjs
06-workbench/scripts/bank-reconcile.mjs
06-workbench/test/bank-import.test.mjs
06-workbench/test/bank-reconciliation.test.mjs
06-workbench/test/bank-reconcile-cli.test.mjs
docs/LOCAL-BANK.md
docs/tasks/LOCAL-04-BANK.md
docs/handoffs/LOCAL-04-BANK.md
```

`git status` 只显示以上 9 个新文件（本交接写入后为 10 个）；无 `data/`、无临时库、无日志、无
`package.json` / 锁文件 / `test-all.mjs` 改动。

## 2. 关键设计决定（审查重点）

1. **模块零默认库副作用**：三个 `server/bank-*.mjs` 都不 import `db.mjs` / `accounting.mjs`，
   所有数据库访问通过显式注入的 `DatabaseSync`。CLI 普通命令只打开 `--db`；只有 `init-db` 在
   「确认目标文件不存在 + 文件名 `workbench.db`」后设置 `WORKBENCH_DATA_DIR` 并调用产品真实建库入口。
2. **创建事实回执**：`claimFreshDatabase()` 只在目标文件不存在时创建空文件并发放进程内回执；
   `ensureBankSchema()` 只在回执匹配时允许免备份建 `bank_*`。回执不落盘、不跨进程，
   因此 CLI 独立调用无法把已有库伪装成新库；也没有 `--force` 之类的旁路参数。
3. **已有库迁移安全拒绝**：`bank_*` 加入已有库前必须有注入的 LOCAL-06 备份实现
   （`createBackup` + `verifyBackup`）。未提供 → `migration_backup_unavailable`（exit 5），
   不建任何银行表、不动业务数据 / 全局版本。备份失败 / 校验失败分别给 `migration_backup_failed` /
   `migration_backup_invalid`。只有校验 ok 后 DDL 才发生，且 DDL 在单事务内，失败整体回滚。
4. **无稳定 ID 优先不误吞**：同特征行不自动判重，而是整行保存为 `bank_ambiguities` 待人工判定；
   同一文件内两条完全相同的记录作为两笔都保留；只有「本批之前已存在的同特征流水」才触发歧义。
   文件级幂等依赖「文件内容摘要 + 映射指纹 + 行顺序」，不同文件交叠行一律成为待判定证据。
5. **匹配只来自 posted 分录**，候选不是已匹配；多候选全部列出由人工选择；组匹配只返回提示码，
   不自动把合计凑数当成匹配。
6. **读时失效核验**：所有读路径与 `confirm` / `reconcile` 都重新核验 `confirmed` 匹配与当前账务是否一致；
   失效在事务内写一次审计并标记对账运行 stale；原样重新过账不恢复失效匹配，必须重新确认。
   观测边界（没有账务修订号 / 事件流）已在契约 §9 明确写出。
7. **余额调节不凑数**：账面截止 = 真实期初 + 截止日全部历史 posted 银行分录；对账单期初 / 期末由
   操作者声明并与覆盖期流水净额自校验；调节后两边与差额按契约公式输出；差额非 0、覆盖不完整、
   未决歧义、失效匹配都降级为 `pending_review` / `incomplete`，不生成 / 修改任何凭证。

## 3. 实际验证与关键业务输出（本次运行）

环境：Windows，Node v24.15.0，`node:sqlite`。全部合成临时目录 / 合成 CSV。工作目录 `06-workbench`。

| 命令 | 结果 |
|---|---|
| `node --test test/bank-import.test.mjs` | 15 / 15 通过 |
| `node --test test/bank-reconciliation.test.mjs` | 20 / 20 通过 |
| `node --test test/bank-reconcile-cli.test.mjs` | 9 / 9 通过 |
| 三套合并 | 44 / 44 通过，exit 0 |
| `npm test` | 47 / 47 套件通过，exit 0（新增三套件未注册进 `test-all.mjs`，属共享接线范围） |

固定手算（领域与 CLI 两处独立断言，常量写在测试里，不用被测公式生成）：

- 账面期初 80000、未达收 30000 / 未达付 10000 → 账面截止 100000；
- 银行期初 80000、未达收 50000 / 未达付 10000 → 银行截止 120000；
- 调节后账面 = 100000 + 50000 − 10000 = 140000；调节后银行 = 120000 + 30000 − 10000 = 140000；差额 0，状态 `reconciled`。
- 银行付款改 10001、声明截止仍 120000 → 计算期末 119999（声明与计算差 1 分）、
  调节后账面 139999 / 调节后银行 140000、差额 −1、状态 `pending_review`，问题码含
  `statement_balance_mismatch` 与 `adjusted_balance_difference`。

其他实际证据：同批重试与同文件新批次均不增流水；同稳定 ID 改金额整批回滚且既有流水不变；
文件内两条同特征记录保留两笔；交叠文件只产生 1 条 `pending` 歧义且批次 `pending_review`；
反过账后匹配立即 `invalidated`（`voucher_unposted`）且审计只记一次；重过账后仍失效；
SQL 改金额 / 日期 / 科目 / 行号 / 删分录分别识别；触发器注入第 3 行失败后 0 笔流水、
批次 `failed`，修复后同批次重试成功并保留尝试次数；删除账套后审计事件仍在。

## 4. 未完成项 / 下一步（不得视为整体已完成）

1. **已有库迁移与升级验收**：等 LOCAL-06 已审备份实现合并，接真实合同（`createBackup` /
   `verifyBackup` / `restoreNew` 与 v3 支持确认），补迁移前备份、WAL 已提交内容、迁移失败回滚、
   恢复新目标、组件 / 审计 / 来源 / 金额完整性证据；届时把 `--backup-service` 接到真实模块。
   当前**不声称**旧库迁移可用，也不修改 backup 白名单或降版本。
2. **共享接线**：HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs`（三套件登记）另开共享串行窗口；
   本包不碰这些文件。
3. **LOCAL-02 / LOCAL-03 稳定合同**：合并后补真实兼容回归与版本记录；辅助核算维度下
   「同科目多银行账户」支持需按合同重新评估。
4. 组匹配（一对多 / 多对一）仍未实现，只返回 `group_match_requires_manual` / `unsupported_group_match`。
5. 外币 / 换汇、银行网站 / API：不在范围。

## 5. 管理者复验建议

- 先读 `server/bank-storage.mjs` 的备份门槛与创建事实，再读 `server/bank-reconciliation.mjs`
  的导入 / 失效 / 对账三段；CLI 只做参数与输出封装。
- 复现固定金额与 1 分差异（命令见契约 §13 与任务单 §6）；复现已有库无备份时 exit 5 且无 `bank_*`。
- 检查三套测试是否真的只用合成临时目录（`mkdtempSync` + `rmSync`），以及是否没有读真实库 / 凭据。
- 关注点：文件级幂等的边界（换行 / 编码变化不算同文件）、未决歧义对批次与对账状态的降级、
  失效审计只写一次、旧匹配记录保留、`bank_*` 不写全局版本。

## 6. 现场与边界

- 未执行 Git 提交 / 推送 / 合并；工作区只有上述新增文件。
- 未读取真实账套、银行文件、凭据、税局窗口 / 后端 / 私有采集资料；未启动浏览器。
- 未修改共享 STATE / 索引 / 其他 docs；本包状态由管理者在收口时统一登记。
- 复验可使用相对路径与合成值；不要把本机绝对路径 / PID / 原始日志写入 Git。
