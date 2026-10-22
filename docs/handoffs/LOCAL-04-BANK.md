# 交接 · LOCAL-04-BANK 本地银行 CSV、持久对账与余额调节

- 状态：**实施 + 首轮独立审查 5 项阻塞修复与回归完成，工作区未提交**；待管理者读 diff、复现、独审、提交 / PR / 合并。**不声称最终已通过**。本文件不预写 PR、head、merge。
- 审查基线（冻结 head）：`e2545216226b87262508d8a94f38426415670d8c`；本轮只改原 10 个文件，未新增 / 未越界。
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

`git status` 只显示以上 10 个文件（本轮首轮审查修复在冻结 head `e2545216` 上改其中 7 个：4 实现 + 3 测试，
再加 3 个文档更新）；无 `data/`、无临时库、无日志、无 `package.json` / 锁文件 / `test-all.mjs` 改动。

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

## 2.1 首轮独立审查 5 项阻塞的修复（本轮）

审查基线为冻结 head `e2545216226b87262508d8a94f38426415670d8c`。复现方式：把该 head 的 4 个实现文件
导出到临时目录的独立副本，再对同一复现脚本双重运行（冻结 head / 修复后），全部使用真实临时 SQLite、
真实建库入口、真实建账套 / 期初 / posted 凭证 / 导入 / 确认 / 对账路径，金额用独立手算常量（分）。
复现脚本与旧副本均在忽略目录，不入库。冻结 head 上 29 / 51 项断言失败，修复后 51 / 51 通过。

| # | 阻塞现象（冻结 head 真实结果） | 根因 | 修复位置 |
|---|---|---|---|
| 1 | 501 笔×100 分全确认后返回调节后 50200 / 50200 且 `reconciled`，最后 1 笔被两侧重复列未达；反过账后 `refresh` checked=500 / `invalidated[]`；候选占用漏 1；批次数 200 封顶；歧义 500 封顶；>500 已复核失效匹配掩盖后续未复核 | 内部业务判定直接使用展示分页（`listMatches` 默认 500、`listBatches` 200、`listAmbiguities` 500）并先分页后过滤 | `bank-storage.mjs` 新增 `BANK_SCHEMA_CONTRACT` 之外的完整读取 / 聚合 API（`listAllMatches` 键集游标分块、`listMatchesForTransactionIds`、`listConfirmedMatchSides`、`countBatchesByStatus`、`countMatchesByStatus`、`countTransactionMatchStates`、`countPendingAmbiguities*`、`countUnresolvedInvalidatedMatches` / `listUnresolvedInvalidatedMatches`）；`bank-reconciliation.mjs` 的失效核验、候选占用、流水视图、对账未达项、状态计数全部改用上述能力，展示分页只留给输出 |
| 2 | 1/31 账面收款 1000.00 + 2/1 银行收款（容差 1 天已确认）→ 1/31 未达项 0、调节后 1000 / 0、差额 1000 | 未达项只看「有没有匹配」，不看两侧是否在 asOf 前都已发生 | `reconcileBank` 改用 `listConfirmedMatchSides` 取双方日期：只有凭证日期与流水日期都 `<= asOf` 才从截止日未达项消除；跨日匹配合法、不回写账务；`book.matchedEntryCount` 改为同口径 |
| 3 | v1 库插入 `version=2` 后 `ensureBankSchema` 返回 success 且 `registerBankAccount` 能写；删除 `bank_reconcile_runs` 后初始化仍 success；CLI 同因旁路 | 存储 `from >= 目标` 直接放行、领域只看 `< 1`、CLI 只看版本号 | 新增 `BANK_SCHEMA_CONTRACT` + `bankSchemaContract(db)` + `assertBankSchemaReady(db)`：未来版本 / 矛盾版本 / 缺表 / 缺列 / 主键 / UNIQUE / 索引签名 / 外键动作 / 额外 `bank_*` 表均在业务写前拒绝；`ensureBankSchema`、CLI `ensureBankReady`、`resolveBankScope`、`registerBankAccount` 共用同一门槛；拒绝时不做 DDL / 写入（不用 `CREATE IF NOT EXISTS` 修补），只做结构核对、不扫全表内容；仍为组件 v1 |
| 4 | 合成触发器让 `reconcile_computed` 审计插入失败后，runs 变 `[{id:1,stale:1},{id:2,stale:0}]`（旧结果被误废弃） | 旧记录 stale、新运行记录、审计三步不在同一事务 | `reconcileBank` 把三步包在 `inTransaction`（嵌套自动用 SAVEPOINT）；插 run 失败与插 audit 失败两路都有回归 |
| 5 | 合法表头 + 201 行 `2026-01-10,bad,in` 抛 `Assignment to constant variable.`；重复流水号路径不封顶 | `errorsTruncated` 用 `const` 却在行级循环里赋值；重复 refId 直接 `push` | `previewCsvImport` 改用有界 `addError`：CSV 解析 / 缺列 / 期间 / 行级错误 / 文件内重复流水号共用 `maxErrors=200` 总上限，超过只置 `errorsTruncated=true`，不抛错也不误报 ok |

新增回归用例（均在冻结 head 上失败、修复后通过）：

- `bank-import.test.mjs`：「预检错误总上限…」
- `bank-reconciliation.test.mjs`：「内部判定不被展示分页截断…」、「批次与待决歧义真实数量…」、
  「余额调节按截止日 asOf 判定未达项…」、「对账结果持久化原子…」、「组件结构 / 版本契约…」、
  「失效匹配复核计数先过滤再限条…」
- `bank-reconcile-cli.test.mjs`：「CLI 组件结构契约损坏…」（子进程，exit 5、无写入、不重建表）

本轮改动仍限于原 10 个文件：4 个实现 + 3 个测试修改；3 个文档更新。未改共享核心 / backup / 其他员工文件，
未新增依赖，未完成「已有库安装 / 备份恢复」闭环（见 §4）。

## 3. 实际验证与关键业务输出（本次运行）

环境：Windows，Node v24.15.0，`node:sqlite`。全部合成临时目录 / 合成 CSV。工作目录 `06-workbench`。

| 命令 | 结果 |
|---|---|
| `node --test test/bank-import.test.mjs` | 16 / 16 通过 |
| `node --test test/bank-reconciliation.test.mjs` | 26 / 26 通过 |
| `node --test test/bank-reconcile-cli.test.mjs` | 10 / 10 通过 |
| 三套合并 | 52 / 52 通过，exit 0（约 10.7s） |
| `npm test` | 上一轮 47 / 47 套件通过；**本轮未重跑**（只改银行包内文件，未动上游共享代码，按任务边界只跑定向 3 套） |

原 44 个用例保留未改断言（15 / 20 / 9），本轮新增 8 个回归用例（1 导入 + 6 领域 + 1 CLI）。

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
   **本组件结构与版本组合要求**：LOCAL-06 候选（PR #55）已独审但**仍 OPEN**，且其严格拒绝只针对 schema v3 的
   `unexpected_tables`，**不等于**已支持 `bank_*` 额外表；要可宣称「现库安装 / 备份恢复闭环」，必须先按
   `docs/LOCAL-BANK.md` §4.1 的结构 / 版本契约（表 / 列 / PK / UNIQUE / 索引 / FK 动作 / 组件 v1）与已审 backup
   明确组合，由集成窗口重新核验。本包**不**读取未合并候选当已支持，也**不**修改其文件。
   当前**不声称**旧库迁移可用，也不修改 backup 白名单或降版本；本包仍只有组件 v1，不伪造 v2。
2. **03 双准则 / 1002 叶子科目尚未复验**：本包只接受 `1002` 或其显式明细作为资产类借方叶子科目，
   且首版一个银行账户绑一个叶子科目；LOCAL-03 双准则与辅助维度合并后必须重新验，不能声称已完成 03 依赖。
3. **共享接线**：HTTP / Agent / MCP / UI 与 `scripts/test-all.mjs`（三套件登记）另开共享串行窗口；
   本包不碰这些文件。
4. **LOCAL-02 / LOCAL-03 稳定合同**：合并后补真实兼容回归与版本记录；辅助核算维度下
   「同科目多银行账户」支持需按合同重新评估。
5. 组匹配（一对多 / 多对一）仍未实现，只返回 `group_match_requires_manual` / `unsupported_group_match`。
6. 外币 / 换汇、银行网站 / API：不在范围。

## 5. 管理者复验建议

- 先读 `server/bank-storage.mjs` 的备份门槛、`BANK_SCHEMA_CONTRACT` / `bankSchemaContract` / `assertBankSchemaReady`
  与完整读取 API，再读 `server/bank-reconciliation.mjs` 的失效核验 / 候选 / 对账三段；CLI 只做参数与输出封装。
- 复现固定金额与 1 分差异（命令见契约 §13 与任务单 §6）；复现已有库无备份时 exit 5 且无 `bank_*`。
- 重跑冻结 head 与本头的差异重点：501 笔全确认后的调节后 50100 / 50100（不是 50200）、反过账后 checked=501 /
  `invalidated` 长度 1、候选 `available=false`、201 批次 / 501 歧义的**真实计数**、跨日 asOf 未达项 1000 / 1000、
  结构损坏（未来版本 / 缺表）exit 5 且无写入、对账插 run / 插 audit 失败后全组件快照不变。
- 检查三套测试是否真的只用合成临时目录（`mkdtempSync` + `rmSync`），以及是否没有读真实库 / 凭据。
- 关注点：文件级幂等的边界（换行 / 编码变化不算同文件）、未决歧义对批次与对账状态的降级、
  失效审计只写一次、旧匹配记录保留、`bank_*` 不写全局版本、额外 `bank_*` 表会被契约拒绝。

## 6. 现场与边界

- 未执行 Git 提交 / 推送 / 合并；工作区只有原 10 个文件（4 实现 + 3 测试 + 3 文档）的改动，无新增文件。
- 复现脚本、冻结 head 临时副本、合成临时库全在忽略目录 / 系统临时目录，未入库；未读取真实账套、银行文件、
  凭据、税局窗口 / 后端 / 私有采集资料；未启动浏览器。
- 未修改共享 STATE / 索引 / 其他 docs / backup 候选 / 其他员工文件；本包状态由管理者在收口时统一登记。
- 复验可使用相对路径与合成值；不要把本机绝对路径 / PID / 原始日志写入 Git。
