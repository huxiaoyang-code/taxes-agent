# 银行流水与持久对账契约 · LOCAL-BANK（LOCAL-04 交付）

状态：**实施与自测完成，待管理者审查 / 提交 / PR / 合并**。本文件不预写 PR 编号、已审 head 或 merge。
- 远端载体：[Issue #53](https://github.com/huxiaoyang-code/youshu-fork/issues/53)（`Refs #20` / `Refs #13`）
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（含已审 PR #52 导出模块、PR #50 输出策略模块）
- 分支：`codex/huxiaoyang-code/local-04-bank`；工作区：`.worktrees/local-04-bank`
- 任务单：[tasks/LOCAL-04-BANK](tasks/LOCAL-04-BANK.md) · 交接：[handoffs/LOCAL-04-BANK](handoffs/LOCAL-04-BANK.md)

本包只新增 10 个文件（4 个实现 + 3 个测试 + 3 个文档），**未修改**共享文件
（`accounting.mjs` / `db.mjs` / `import-storage.mjs` / `coa.mjs` / `server.mjs` / `agent-tools.mjs` /
MCP / `scripts/test-all.mjs` / `package.json` / 锁文件 / `public/*` / 共享 STATE / 索引 / 其他 docs）。

## 1. 为什么需要这一层

本机操作者需要把银行对账单变成**可核对、可追溯、可重放**的本地数据：

- 银行账户**不是第二本账套**：一个银行账户属于一个账套，绑定该账套里一个明确、有效、可独立归属的银行存款叶子科目；
- 流水导入必须能安全重试（同批同内容幂等、同文件重导不增流水），也必须**优先不误吞**：
  没有银行稳定流水 ID 时，相同日期 / 金额 / 摘要只是**疑似重复**，不得自动合并；
- 银行流水与账务分录的匹配是**人工确认**的结果，不是自动对账；候选必须来自当前真实的 posted 凭证分录；
- 余额调节以真实期初 + 截止日全部历史 posted 银行分录为账面口径，对账单期初 / 期末由操作者显式提供，
  四类未达项与调节后余额必须逐项可追溯，差额不得用「调整项」凑平。

本版本不接银行网站 / 银行 API，不新增任何凭据服务，不生成或修改账务凭证。

## 2. 边界与产品口径

- 本机单用户；一家企业一个账套，多企业批量 = 多账套；银行账户只是账套内的辅助标识。
- 首版只支持 **CNY（分）**：不猜外币、不换汇、不把同科目下多个银行账户推断为可区分。
- 账套 / 银行账户 / 币种 / 日期窗口 / 账务期间必须**同时显式声明**；任何跨账套引用都拒绝。
- 银行账号 / 名称只是本地字段，**不能当企业身份**。
- 不自动改 `periods` 状态；银行侧「已对平」不等于账务可结账。
- 不生成、修改、删除任何 `vouchers` / `voucher_entries` / `opening_balances` / `periods` 数据。

## 3. 实现文件与职责

| 文件 | 职责 |
|---|---|
| `06-workbench/server/bank-import.mjs` | 纯函数：CSV 解析、字段映射校验、日期 / 金额 / 方向规范化、预检、指纹与限制。**无数据库副作用**。 |
| `06-workbench/server/bank-storage.mjs` | `bank_*` 独立命名空间、组件版本 `bank_component_migrations`、迁移前备份门槛、创建事实回执、CRUD 与审计 / 对账运行记录。 |
| `06-workbench/server/bank-reconciliation.mjs` | 账户登记、导入落库（单事务）、批次 / 流水 / 歧义查询、候选、确认 / 取消、读时失效核验、余额调节、状态汇总。 |
| `06-workbench/scripts/bank-reconcile.mjs` | 本机 CLI：显式 `--db`、JSON / text 输出、稳定错误码与退出码；`init-db` 使用产品真实建库入口创建新库。 |

三个模块都**不 import** `db.mjs` / `accounting.mjs`：数据库连接由调用方显式注入，导入模块不会打开默认库、
不会触发 LOCAL-01 / LOCAL-02 的全局迁移。账务数据一律按当前已核实结构只读查询。

## 4. 数据模型（组件 schema v1）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `bank_component_migrations` | 组件版本 | `version INTEGER PRIMARY KEY`；只写本表，不写 `schema_migrations` / `schema_backups` / `PRAGMA user_version` |
| `bank_component_backups` | 组件迁移前备份证据 | 记录备份位置、字节数、完整性、创建原因（`existing-database` / `component-upgrade`） |
| `bank_accounts` | 银行账户登记 | PK `(account_set_id, bank_account_id)`；`UNIQUE(account_set_id, gl_account_code)` 保证一个叶子科目不被两个不可区分账户并行绑定；`currency` 目前固定 `CNY` |
| `bank_batches` | 批次身份与结果 | PK `(account_set_id, bank_account_id, batch_id)`；`content_sha256`（整份文件）、`mapping_fingerprint`、`normalization_version`、`period`、`source_id`、`status`、`attempts`、`replay_of_batch` |
| `bank_transactions` | 文件中的已确认流水行 | 有稳定 ID 时 `UNIQUE(account_set_id, bank_account_id, source_id, bank_ref_id)`（部分索引）；`UNIQUE(account_set_id, bank_account_id, batch_id, row_index)`；`content_fingerprint` + `row_fingerprint` |
| `bank_batch_rows` | 批次逐行追踪 | `UNIQUE(account_set_id, bank_account_id, batch_id, row_index)`；行状态 `imported` / `duplicate_reused` / `replayed` / `ambiguity_pending` / `ambiguity_resolved_same` / `ambiguity_resolved_distinct` |
| `bank_ambiguities` | 无稳定 ID 的疑似重复证据 | `UNIQUE(account_set_id, bank_account_id, batch_id, row_index)`；`candidate_transaction_ids` 保留候选证据；`status` / `decision` / `decision_reason` / `resolved_transaction_id` |
| `bank_matches` | 人工确认 / 取消 / 失效的匹配记录 | 部分唯一索引 `UNIQUE(transaction_id) WHERE status='confirmed'`、`UNIQUE(account_set_id, entry_id) WHERE status='confirmed'`：数据库级禁止双重占用；`snapshot_json` 保存确认时账务快照 |
| `bank_audit_events` | append-only 审计 | **无级联外键**：账套 / 账户 / 批次被业务删除后审计证据仍保留 |
| `bank_reconcile_runs` | 每次余额调节的运行记录 | 记录状态、账面 / 银行截止余额、调节后余额、差额、结果摘要、`stale` 标记 |

银行账户 / 批次 / 流水 / 逐行记录 / 歧义之间有外键（`ON DELETE CASCADE` 跟随账套删除）；
`bank_matches.transaction_id` 与 `bank_ambiguities.resolved_transaction_id` 使用 `ON DELETE SET NULL`，
快照字段保留原值，避免业务删除把匹配证据连带抹掉。

## 5. 账户与科目合同

登记请求：`accountSetId`、`bankAccountId`、`sourceId`、`glAccountCode`、`currency`（缺省 CNY）、
可选 `displayName` / `bankAccountNo`。

- `bankAccountId` / `sourceId` 是本组件在账套内的稳定标识（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`）。
- `glAccountCode` 必须是该账套内**存在**、**叶子**（`is_leaf=1` 且没有子科目）、**资产类借方**、
  且属于 `1002` 银行存款或其显式明细科目（`1002xxxx`）。父科目含多账户时必须显式选择明细；无法区分则拒绝。
- 同一账套同一 `glAccountCode` 只允许一个银行账户；同一 `bankAccountId` 的绑定不允许静默改写
  （`bank_account_conflict`）；完全相同的重复登记幂等返回。
- 同一个 `bankAccountId` 出现在不同账套是**不同范围**，互不影响。
- 每次解析范围都会重新校验科目仍存在、仍是叶子、仍是银行存款科目，账套 / 账户 / 币种三者必须一致。

## 6. CSV 与字段映射

限制（`BANK_CSV_LIMITS`）：`maxBytes = 5 MiB`、`maxRows = 20000`、`maxColumns = 40`、
`maxFieldChars = 4096`、`maxErrors = 200`、`summaryMaxChars = 200`、`refIdMaxChars = 64`。

CSV 解析：UTF-8 BOM、CRLF / LF / CR、引号包裹、`""` 转义、字段内逗号与换行；重复 / 空表头、
未闭合引号、字段中途引号、引号后杂字符、字段过多、超限都返回结构化错误（含行号 / 起始行）。

映射（JSON）关键字段：

```json
{
  "columns": { "date": "交易日期", "summary": "摘要", "amount": "金额", "direction": "收付",
                "refId": "流水号", "currency": "币种", "balance": "余额" },
  "amountMode": "amount_direction",
  "directionLabels": { "inflow": ["收", "收入"], "outflow": ["付", "支出"] },
  "dateFormat": "YYYY-MM-DD",
  "currency": "CNY",
  "thousandsSeparator": ",",
  "allowCurrencySymbol": false,
  "negativeAmount": "reject",
  "ignoreBlankRows": true
}
```

- 两种模式：`debit_credit`（借 / 贷两列）与 `amount_direction`（金额 + 收付方向）。
- 业务方向统一企业视角：`inflow` = 银行余额增加 = 银行存款借方；`outflow` = 银行余额减少 = 贷方。
  银行原文件的借贷含义必须由映射确认，不按列名 / 符号 / 顺序猜。
- 日期：`YYYY-MM-DD` / `YYYY/MM/DD` / `YYYYMMDD` 三选一，必须显式声明；真实日历校验；
  行日期必须落在本次声明的账务期间（`YYYY-MM`）内；不做时区换算。
- 金额：必须规范化为安全整数分，上限 99,999,999,999,999 分；拒绝指数写法、多个小数点、混杂文本、
  `NaN` / `Infinity`、未声明千分位时含逗号、超过两位小数、超界、负数（除非 `amount_direction` 模式且
  `negativeAmount: "reverse_direction"` 显式声明才翻转方向）。空值（未提供）与显式 `0` 有区别：
  借 / 贷模式下两列都为空或 0 视为「本行没有发生额」而拒绝；整行有一个非零发生额才有效。
- 币种：无币种列时必须在映射里显式声明 `CNY`；有币种列时逐行必须是 `CNY`，否则拒绝。
- 余额列可选，允许负数（透支）；只保存为 `balance_after_cents`，不据此推断方向或对账平衡。
- 银行稳定流水 ID 可缺；有值时只能由映射显式指定列。**同一文件内重复的稳定 ID 直接拒绝**
  （无法判断哪一行才是该 ID 的规范内容）。
- 摘要超长拒绝（不截断），流水 ID 字符 / 长度非法拒绝。

**预检（`import-preview`）与正式导入共用同一套规范化规则**，预检只读、不写任何表。

## 7. 批次身份、幂等与去重

批次身份 = `accountSetId + bankAccountId + sourceId + batchId + 文件内容摘要 + 映射指纹 + 规范化版本 + period`。

| 场景 | 行为 |
|---|---|
| 同 `batchId` + 同内容 + 同映射 + 同期间 | 直接回放，不新增流水（`replayKind: same-batch`），不修改批次记录 |
| 同 `batchId` 但内容 / 映射 / 来源 / 期间变化 | `batch_content_conflict`，已完成批次不被覆盖 |
| 同文件（同内容摘要 + 同映射）用新 `batchId` | 识别为已完成来源：新建批次记录 + 逐行 `replayed` 追踪到既有流水，**不新增流水**；已完成批次 → 回放批次 `completed`，待判定批次 → 回放批次 `pending_review` |
| 失败批次用同一 `batchId` 修正后重试 | 允许：失败批次的业务事务已整体回滚、没有半笔流水，先删除失败记录再重跑；尝试次数保留 |
| 有稳定 ID、规范内容相同 | 逐行 `duplicate_reused`，不新增流水 |
| 有稳定 ID、规范内容变化 | `source_transaction_content_changed`，整批回滚，不覆盖既有流水 |
| 无稳定 ID、同特征流水已存在（本批之前） | 保存到 `bank_ambiguities`（`pending`），该行**不进入已确认流水**；批次转 `pending_review` |
| 无稳定 ID、同一文件内两条完全相同的记录 | **两笔都保留**（可能是两笔交易）；文件内重复不触发歧义 |
| 无稳定 ID、不同文件交叠窗口 | 只把**本批之前已存在**的同特征流水作为候选证据，逐行等待人工判定 |

无稳定 ID 时 `row_fingerprint = sha256(date|direction|amountCents|summary)` 只是**疑似重复信号**，
绝不作为可靠唯一标识；稳定 ID 的唯一键为 `(accountSetId, bankAccountId, sourceId, bankRefId)`，
**同一 ID 在不同来源命名空间是不同流水**（跨来源不合并、不互相去重）。

人工判定（`resolve-ambiguity`）：

- `decision=same`：必须显式给 `--transaction <id>`（或候选唯一时自动取唯一候选），关联到既有流水，不新增；
- `decision=distinct`：新增一笔流水，保留来源行证据；
- 必须给理由；已判定的同一决定幂等返回，改判给 `ambiguity_already_resolved`；
- 批次内所有歧义判定完成后，`pending_review` → `completed`；未判定完成前批次**不会被伪报 complete**。

整批事务：任何行级错误、内容冲突或数据库错误都整体回滚，不留半笔流水 / 半行记录 / 半条匹配；
失败审计在独立事务写入（`markBatchFailed`），且**不覆写已完成批次**；失败审计本身失败时调用方如实返回。

## 8. 候选与人工匹配

候选来源：同一真实库内 `vouchers.status='posted'` 且分录科目 = 登记账户绑定科目的
`voucher_entries`，以 `voucher_id + entry_id + line_no` 标识。草稿不参与。

- 金额与方向必须与流水**完全一致**（整数分、同方向）。
- 日期窗口显式且有限：默认同日；`dateToleranceDays` 只能是 `0..31`；显式 `from` / `to` 超出
  「流水日期 ± 允许偏差」直接拒绝（`date_window_too_wide`）。
- 存在多个等价候选时全部列出且 `selection = requires_manual_choice`，绝不自动选第一条。
- 已被有效匹配占用的分录仍然列出但 `available=false` / `claimedByMatchId`。
- 一对多 / 多对一：**未实现自动组匹配**。只做提示：
  若同一窗口、同方向、未占用的两条分录合计恰好等于流水金额，返回
  `groupMatch.code = group_match_requires_manual` 与候选对；否则返回 `unsupported_group_match`。
  任何情况下都不自动占用分录、不把合计凑数当成已匹配。

确认（`confirm`）：必须显式 `--transaction`、`--voucher`、`--entry` 与理由。事务内用最新账务快照复核：

- 流水 / 分录 / 凭证都属于该账套与银行账户；
- 凭证 `posted`、分录科目 = 绑定科目、借贷方向明确、金额与流水完全一致；
- 凭证日期与流水日期偏差不超过显式允许值；凭证期间 = 凭证日期的月份；
- 同一流水 / 同一分录没有其他有效匹配（数据库部分唯一索引兜底，并发只会成功一次）。

取消（`cancel`）：必须给理由；释放占用但保留原匹配、原确认理由、成员与取消事件；重复取消幂等
（不新增审计事件）；取消后可再次确认并产生新的匹配记录（旧记录保留）。

## 9. 读时失效核验（无共享写入口接线时的真实工作路径）

`status` / `transactions` / `matches` / `candidates` / `confirm` / `reconcile` 每次都会重新核验范围内
所有 `confirmed` 匹配与当前账务是否一致。失效原因（写入 `bank_matches.invalidation_reason`）：

| 原因码 | 触发 |
|---|---|
| `bank_transaction_missing` | 银行流水被删除 |
| `bank_transaction_scope_changed` | 流水账套 / 账户变化 |
| `bank_transaction_changed` | 流水规范内容指纹变化 |
| `voucher_missing` | 凭证被删除 |
| `account_set_mismatch` | 凭证不属于该账套 |
| `voucher_unposted` | 凭证被反过账 |
| `voucher_entry_missing` | 分录被删除 / entry_id 不存在（含同号新凭证） |
| `entry_account_changed` | 分录科目变化 |
| `entry_line_changed` | 分录行号变化 |
| `entry_amount_changed` | 借方 / 贷方金额变化 |
| `entry_amount_unreadable` | 账务金额不是有限数或不是精确到分 |
| `voucher_date_changed` | 凭证日期变化 |
| `voucher_period_changed` | 凭证期间变化 |
| `voucher_period_date_mismatch` | 凭证期间与日期月份不一致 |

失效处理：事务性把匹配置为 `invalidated` 并写一条 `match_invalidated` 审计（**只写一次，不重复刷**），
把旧的对账运行记录标记 `stale`；重新展示必要未达项。**旧凭证反过账后又原样过账，不会自动恢复失效匹配**，
必须重新确认（产生新匹配记录）。

观测边界（如实说明）：本版本没有可靠的账务修订号 / 变更事件流，检测发生在**读取时**，
因此只能保证「本次读取时点」的账务状态一致性，不能声称捕获两次调用之间未观察到的所有中间操作。
共享写入口（`accounting.mjs` 的反过账 / 删除 / 修改）的事件接线属于后续共享窗口任务，本包未改那些文件。

## 10. 余额调节

请求必须显式：`accountSetId`、`bankAccountId`、`currency`（CNY）、`period`、`asOf`、
`statementOpenCents`、`statementCloseCents`、`coverageFrom`、`coverageTo`、`statementSource`。

- 账面截止余额 = 该账套该银行存款科目的真实期初（`opening_balances` 借 - 贷）
  + `voucher_date <= asOf` 的**全部历史 posted** 银行分录（借 - 贷）。
  不按本月 / 候选窗口净额代替；asOf 必须落在声明期间内；期间早于账套启用期间拒绝。
- 银行截止余额由操作者显式声明；同时校验
  `声明期初 + 覆盖期流水净额 = 声明期末`，不一致保留差异（`statement_balance_mismatch`），
  不自动改余额、不补项。
- 覆盖范围必须包含 `asOf`，否则 `incomplete`。
- 四类未达项（逐项带来源）：
  - 企业已收银行未收：未匹配的账面 posted 银行借方分录；
  - 企业已付银行未付：未匹配的账面 posted 银行贷方分录；
  - 银行已收企业未收：未匹配的银行流入流水；
  - 银行已付企业未付：未匹配的银行流出流水。
- 公式（整数分，BigInt 累加后校验范围）：
  - 调节后账面 = 账面截止余额 + 银行已收企业未收 − 银行已付企业未付
  - 调节后银行 = 银行截止余额 + 企业已收银行未收 − 企业已付银行未付
  - 差额 = 调节后账面 − 调节后银行
- 状态：`reconciled` 只在「差额为 0 + 对账单期初/期末校验一致 + 覆盖包含 asOf + 无未决歧义 +
  无未复核的失效匹配 + 期间日期一致」时给出；否则 `incomplete`（覆盖 / 期间 / 来源类）
  或 `pending_review`（差异 / 歧义 / 失效匹配类）。
- 每次调节都写 `bank_reconcile_runs` 与 `reconcile_computed` 审计，并把同一账户更早的运行记录标记 `stale`；
  调节不生成、不修改任何凭证，也不改 `periods` 状态。

固定手算验收（单位分，测试中直接写独立常量）：两边期初 80000；账面仅有未达收款 30000、付款 10000；
银行仅有未达收款 50000、付款 10000 → 账面截止 100000，银行截止 120000，
调节后账面 = 100000 + 50000 − 10000 = 140000，调节后银行 = 120000 + 30000 − 10000 = 140000，差额 0。
把银行付款改为 10001 且保持声明截止 120000 → 计算期末 119999、声明与计算差 1 分、
调节后账面 139999 / 调节后银行 140000、差额 −1，状态 `pending_review`。

## 11. CLI

```
node scripts/bank-reconcile.mjs <command> --db <库文件> [选项] [--format json|text]
```

| 命令 | 作用 | 主要参数 |
|---|---|---|
| `init-db` | 在**不存在**的新路径创建账务库并初始化 bank_*（唯一允许建库的命令） | `--db <目录>/workbench.db` |
| `account-register` | 登记银行账户 | `--account-set`、`--bank-account`、`--source`、`--gl-code`、可选 `--name` / `--number` / `--currency` |
| `accounts` | 列出已登记账户 | `--account-set` |
| `import-preview` | 预检 CSV + 映射（不写库） | `--account-set`、`--bank-account`、`--source`、`--period`、`--csv`、`--mapping` |
| `import` | 执行导入 | 同上 + `--batch` |
| `batches` | 批次状态 | `--account-set`、`--bank-account`、可选 `--limit` |
| `transactions` | 流水查询（含匹配状态） | 可选 `--from` / `--to` / `--status matched\|unmatched\|all` / `--limit` |
| `ambiguities` | 疑似重复待判定行 | 可选 `--status` |
| `resolve-ambiguity` | 人工判定 same / distinct | `--ambiguity`、`--decision`、`--reason`、可选 `--transaction` |
| `candidates` | 候选分录（只读） | `--transaction`、可选 `--from` / `--to` / `--tolerance-days` / `--period` |
| `confirm` | 确认匹配 | `--transaction`、`--voucher`、`--entry`、`--reason`、可选 `--tolerance-days` |
| `cancel` | 取消匹配 | `--match`、`--reason` |
| `matches` | 匹配记录与有效性 | 可选 `--status` |
| `reconcile` | 余额调节 | `--period`、`--as-of`、`--statement-open`、`--statement-close`、`--coverage-from`、`--coverage-to`、`--statement-source`，可选 `--currency` / `--note` |
| `status` | 账户 / 批次 / 流水 / 匹配 / 歧义 / 最近对账 | `--account-set`、`--bank-account` |
| `audit` | append-only 审计事件 | 可选 `--limit` |
| `help` / `--help` | 命令列表（不接触数据库） | — |

金额参数用元（最多两位小数），输出同时给整数分与两位小数文本。`--format text` 给操作者本机可读明细。

退出码：`0` 成功；`2` 用法 / 路径 / 范围参数错误；`3` 业务拒绝或冲突；
`4` 内部错误（默认不输出 SQL / 堆栈）；`5` 依赖未就绪（备份 / 结构门槛）。

常用错误码（完整列表见实现与 `test/bank-reconcile-cli.test.mjs`）：

| 类别 | 错误码 |
|---|---|
| 数据库 / 结构 | `db_not_found`、`db_not_workbench`、`schema_not_supported`、`bank_schema_missing` |
| 迁移门槛 | `migration_backup_unavailable`、`migration_backup_failed`、`migration_backup_invalid`、`bank_migration_failed` |
| 账户 / 范围 | `account_set_not_found`、`bank_account_not_registered`、`bank_account_conflict`、`bank_gl_account_already_bound`、`bank_gl_account_not_found`、`bank_gl_account_not_leaf`、`bank_gl_account_invalid`、`currency_unsupported`、`period_before_start` |
| CSV / 映射 | `csv_duplicate_header`、`csv_unclosed_quote`、`csv_stray_quote`、`csv_trailing_characters`、`csv_missing_column`、`mapping_*`、`row_date_*`、`row_amount_*`、`amount_*` |
| 批次 / 去重 | `batch_content_conflict`、`source_transaction_content_changed`、`import_rejected`、`replay_row_mismatch` |
| 歧义 | `ambiguity_not_found`、`ambiguity_already_resolved`、`ambiguity_decision_invalid`、`ambiguity_target_required`、`ambiguity_target_scope_mismatch` |
| 匹配 | `voucher_not_posted`、`entry_not_bank_account`、`match_amount_mismatch`、`match_date_out_of_window`、`entry_already_matched`、`match_already_confirmed`、`match_not_found` |
| 对账 | `statement_source_required`、`statement_coverage_required`、`statement_coverage_invalid`、`as_of_period_mismatch`、`date_window_too_wide` |

## 12. 组件迁移与备份门槛（LOCAL-06 依赖）

- `bank_*` 使用自己的 `bank_component_migrations` 版本（当前 v1），**不写** LOCAL-01 的
  `schema_migrations` / `schema_backups`，也不写 `PRAGMA user_version`。
- **已有库**首次加入 `bank_*`（或组件升级）必须先完成一次可验证的一致备份。备份实现来自
  LOCAL-06，本包只作为窄依赖注入（需 `createBackup({dbPath,outDir})` 与 `verifyBackup({backupDir})`）：
  - 未提供备份服务 → `migration_backup_unavailable`，原库结构 / 数据 / 版本都不动；
  - 备份生成失败 → `migration_backup_failed`；备份校验不通过 → `migration_backup_invalid`；
  - 只有备份校验返回 ok 之后，才在同一事务里建立组件表、记录备份证据与组件版本；DDL 失败整体回滚。
- 新库：`claimFreshDatabase({ dbPath })` 只在目标文件**不存在**时创建空文件并返回**进程内**创建回执；
  `ensureBankSchema` 只在回执匹配时允许免备份初始化。回执不落盘、不跨进程，因此 CLI 独立调用
  **无法**把已有库伪装成新库，也没有 `--force` 之类的旁路布尔参数。
- CLI 的 `init-db` 是唯一允许建库的入口：它先确认目标文件不存在（且文件名必须是 `workbench.db`），
  声明创建事实，设置 `WORKBENCH_DATA_DIR` 指向显式目录后调用产品真实建库入口 `server/db.mjs`，
  再在同一进程内初始化 `bank_*`。已有库加入 `bank_*` 时 CLI 支持 `--backup-service <模块>`。

**当前状态（如实）**：LOCAL-06 已审查备份实现尚未合并进本分支，因此**已有库的银行组件迁移尚未可用**，
CLI 对这类库返回 `migration_backup_unavailable`（exit 5），并有测试证明此时不创建任何 `bank_*` 表。
新库生命周期（`init-db` / 进程内创建事实）与全部业务功能已可真实运行。
若后续 LOCAL-06 合同与本包的注入点不一致，由集成窗口按真实合并合同调整，不在本包修改 backup 白名单或降版本。

**停写 / 维护窗口与恢复损失边界（执行前提，不是已保证）**：

- 备份是「迁移前某一时点」的快照。SQLite 的 `VACUUM INTO` 不能在事务内执行，因此 CLI 在备份前
  无法把外部连接写入也锁住；本包**不声称**能阻止其他进程在备份时点与组件 DDL 之间提交写入。
- 因此已有库迁移必须在操作者确认的**停写维护窗口**内执行：先关闭其他会写该库的进程（后端 / Agent / 脚本），
  再由单个 CLI 进程运行迁移；DDL 本身在 `BEGIN IMMEDIATE` 单事务内完成，失败整体回滚。
- 恢复损失边界：备份时点**之后**提交的任何业务写入都不在快照内；若用该备份恢复，这些写入会丢失。
  迁移前如需更高保证，应先自行保护现库、停写并在恢复后逐项核对；本组件不冒充 LOCAL-06 的完整恢复工具。
- 失败时的可验证备份文件保留在原地（未登记为成功迁移证据），便于人工核对后重试或回退。

## 13. 验收与测试（本次实际运行）

环境：Windows，Node v24.15.0，`node:sqlite`（无第三方依赖）。全部使用合成临时目录与合成 CSV，
不读取真实账套 / 银行文件 / 凭据。

| 套件 | 命令（在 `06-workbench` 目录） | 结果 |
|---|---|---|
| CSV / 映射 / 规范化 | `node --test test/bank-import.test.mjs` | 15 / 15 通过 |
| 持久化 / 匹配 / 失效 / 余额调节 | `node --test test/bank-reconciliation.test.mjs` | 20 / 20 通过 |
| CLI 端到端（子进程） | `node --test test/bank-reconcile-cli.test.mjs` | 9 / 9 通过 |
| 三套合计 | `node --test test/bank-import.test.mjs test/bank-reconciliation.test.mjs test/bank-reconcile-cli.test.mjs` | 44 / 44 通过，exit 0 |
| 既有全套回归 | `npm test` | 47 / 47 套件通过，exit 0 |

三套件**尚未注册**到 `scripts/test-all.mjs`：该文件属于共享测试总入口，按任务边界由后续共享接线窗口登记；
本包不修改它，因此 `npm test` 不包含这三个套件。

## 14. 限制与未完成项（不声称已交付完成）

1. **已有库迁移不可用**：等待 LOCAL-06 已审备份合同合并后，由集成窗口完成真实迁移前备份、
   WAL 已提交内容、迁移失败回滚、备份恢复新目标、银行组件 / 审计 / 来源 / 金额完整性验收。
   本包只用失败分支与「DDL 发生在备份校验之后」的顺序测试证明门槛，**未把 fake backup 当迁移验收**。
2. **共享接线未做**：HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs` 均未接入，由共享串行窗口另开任务；
   当前交付的是可直接调用的 Node CLI 与领域 API。
3. **LOCAL-02 / LOCAL-03 未合并**：本包按当前真实 v3 schema 读取账务；LOCAL-02 的金额 / 期末完整性、
   LOCAL-03 的辅助核算维度稳定后，需补真实兼容回归与版本记录，并再评估「同科目多银行账户」的辅助维度支持。
4. **组匹配未实现**：只返回提示码 `group_match_requires_manual` / `unsupported_group_match`，不自动组合。
5. **单一币种**：只有 CNY（分），无外币、无换汇、无汇率字段。
6. **一个银行账户绑定一个叶子科目**：没有辅助维度时，同科目多个银行账户会被拒绝；
   不按科目名称 / 前缀猜整套准则，只接受 1002 或显式 1002 明细。
7. **无稳定 ID 的去重边界**：文件级幂等依赖「文件内容摘要 + 映射指纹 + 行顺序」；同一份对账单被
   另存为不同换行 / 编码即视为新文件，交叠行会变成待判定歧义（不会被静默合并），这是有意的保守行为。
8. **观测边界**：失效核验在读取时进行，没有账务修订号 / 事件流，不能声称捕获两次调用之间的所有中间操作；
   共享写入口事件接线待后续任务。
9. **对账单完整性**：银行截止余额由操作者声明并与覆盖期流水净额自校验；不读取银行原件、
   不自动判断对账单是否覆盖全部交易，只按显式覆盖范围与来源说明给状态。
10. **不做**：银行网站 / 银行 API、SaaS / 多租户、自动调整凭证、自动结账、发票 / 税务适配。
