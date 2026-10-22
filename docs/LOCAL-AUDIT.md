# LOCAL-06 审计与恢复 ledger（A 包契约）

> 状态：**A 包组件（存储 / 契约 / 只读 CLI / 恢复 ledger 原语）已实现并自测；尚未接线任何领域入口。**
> 本文件描述**实际已存在**的接口与边界。B / C 包的真实入口验收（HTTP / Agent / MCP、批量、备份恢复）
> **尚未开始**，不得据本文件宣称「LOCAL06 审计已覆盖全部动作」。
>
> 关联：[任务单](tasks/LOCAL-06-AUDIT.md) · [交接](handoffs/LOCAL-06-AUDIT.md) · [增量导入契约](LOCAL-IMPORT.md)

## 1. 范围与非目标

**本包提供**

1. 业务库内的独立审计组件（组件版本表 + 数据库实例表 + append-only 事件表），含受保护初始化与结构检查；
2. 严格的事件字段 / 固定 action / outcome / resultCode / reasonCode 契约与固定错误映射；
3. 稳定 operation / attempt / 父操作上下文，技术 ID 与关联令牌校验；
4. 事务协调原语：事务内 append、回滚后失败事件 append、嵌套 SAVEPOINT、提交结果不明确的固定处理；
5. 只读过滤分页查询与只读 CLI（显式 `--db` / `--ledger`，无默认数据目录）；
6. 独立「恢复操作 ledger」：started / prepared / succeeded / failed / rejected / unknown 状态机、
   幂等与冲突、故障注入下不伪造终态、显式 reconcile 原语；
7. 真实临时 SQLite 验收（`test/local-audit.test.mjs`、`test/local-restore-audit.test.mjs`）。

**本包明确不做**

- 不接线 `db.mjs` / `accounting.mjs` / `import-incremental.mjs` / `server.mjs` / `agent-tools.mjs` / MCP；
- 不编辑 LOCAL-02 核心、`import-storage.mjs`、backup / batch / bank 候选模块、`package.json`、`public/*`；
- 不实现 `createBackup` / `verifyBackup` / `restoreNew` 的真实接线（C 包），也不复制 / 覆盖任何目录；
- 不做多租户、权限、对外服务、账户体系；审计只记录本机技术事实；
- 不对既有业务库执行组件安装（见 §8：**明确拒绝**）。

## 2. 文件与依赖方向

| 文件 | 职责 | 依赖 |
|---|---|---|
| `06-workbench/server/local-audit.mjs` | 契约：固定词表、技术 ID 校验、operation 上下文、错误映射、事务原语 | 仅 `node:crypto` |
| `06-workbench/server/local-audit-storage.mjs` | 业务库审计组件：结构 / 安装门槛 / 事务内 append / 只读查询 / 受控执行 | `local-audit.mjs`、`node:sqlite` |
| `06-workbench/server/local-restore-audit.mjs` | 独立恢复 ledger：结构 / 状态机 / 幂等冲突 / reconcile | `local-audit.mjs`、`node:sqlite` |
| `06-workbench/scripts/local-audit.mjs` | 只读查询 CLI | 上面三个模块 |

三个 `server/*.mjs` 都**不** import `db.mjs`、不打开默认库、不创建目录、无模块级副作用（import 即可用，不连库）。
`local-audit-storage.mjs` 依赖 `local-audit.mjs`（单向）；`local-restore-audit.mjs` 只复用 `local-audit.mjs` 的
错误类型与事务原语，**不**引用业务审计存储（两库互不依赖）。

## 3. 业务库审计组件结构（版本 v1）

组件名 `business-audit`，与 LOCAL-02 的全局 `schema_migrations` 版本**相互独立**；组件自身版本记录在
`audit_components(component, version, installed_at, note)`。

```sql
audit_database_instances(
  instance_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  parent_instance_id TEXT,              -- 恢复分叉时记录父实例
  is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
  note TEXT
)  -- 部分唯一索引：同一时刻只有一个活动实例

audit_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, -- 稳定游标
  event_id TEXT NOT NULL UNIQUE,         -- 服务端 UUID
  dedupe_key TEXT NOT NULL UNIQUE,       -- 服务端摘要（见 §7）
  database_instance_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,             -- 服务端 UTC ISO
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (...),
  result_code TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT 'none',
  actor TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  parent_operation_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  account_set_id INTEGER,                -- 内部自增 ID，**无外键**
  voucher_id INTEGER,
  period TEXT CHECK (period IS NULL OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  job_id TEXT, item_id TEXT, stage_id TEXT,
  correlation TEXT,                      -- 只能是服务端 sha256 令牌
  content_digest TEXT NOT NULL           -- 行内容摘要（完整性自检用）
)
```

- **append-only**：`audit_events_no_update` / `audit_events_no_delete` 触发器对 UPDATE / DELETE 直接
  `RAISE(ABORT)`；索引覆盖 `(account_set_id, seq)`、`(operation_id, attempt, seq)`、`(action, seq)`、`(period, seq)`。
- **无外键**：账套 / 凭证删除后事件保留；失败尝试即使没有实际对象 ID 也可留痕；范围隔离靠生产者从真实对象
  核对 `accountSetId`，查询条件本身也是技术 ID。
- **实例分叉**：`markAuditInstanceFork` 保持旧实例历史事件不变，只把活动实例切到新分叉实例（记录父实例），
  新副本的未来事件使用新 instance ID；同一父实例重复调用幂等，父实例不是当前活动实例时给
  `audit_instance_conflict`。
- 只读完整性自检 `verifyAuditEvents(db)` 重算 `content_digest`，返回 `{ checked, mismatched }`。

## 4. 事件字段白名单与固定词表

**允许字段（全量）**：`action`、`outcome`、`resultCode`、`reasonCode`、`attempt`、`operationId`、
`parentOperationId`、`actor`、`correlation`、`accountSetId`、`voucherId`、`period`、`jobId`、`itemId`、`stageId`。
未登记字段**一律拒绝**（`audit_event_invalid`，`reason=unknown_field`，只给数量，不回显键名 / 值）；
`eventId` / `databaseInstanceId` / `occurredAt` 由存储层生成，调用方提供即视为未知字段。

**action**：`import.create`、`import.append`、`import.legacy`、`voucher.post`、`voucher.unpost`、
`period.close`、`period.reopen`、`batch.stage`、`batch.job`、`restore.new`。

**outcome**：`succeeded`、`rejected`、`failed`、`no_change`、`replayed`、`interrupted`、`unknown`
（中断不得伪造成 failed 或 succeeded）。

**actor**：`http`、`agent`、`mcp`、`cli`、`domain`、`batch`、`system`（只表示触发层，不当权限）。

**resultCode**（固定，节选语义分组）：通用 `ok` / `no_change` / `replayed` / `rejected` /
`rejected_validation` / `conflict` / `not_found` / `blocked_period_closed` / `failed` / `internal_error` /
`audit_unavailable` / `interrupted` / `unknown`；领域成功 `import_create_succeeded`、
`import_append_succeeded`、`import_legacy_succeeded`、`import_preview_ok`、`voucher_post_succeeded`、
`voucher_unpost_succeeded`、`period_close_succeeded`、`period_reopen_succeeded`、`batch_stage_succeeded`、
`batch_job_succeeded`、`restore_new_succeeded`；领域失败 / 恢复中间态 `batch_stage_failed`、
`batch_job_failed`、`restore_new_failed`、`restore_new_rejected`、`restore_published_pending`；
审计自身 `audit_install_refused`、`audit_schema_rejected`。完整清单见
`AUDIT_RESULT_CODES` / `AUDIT_REASON_CODES` 常量。

**技术 ID 规则**（不满足即拒绝，不回显原值）：

| 字段 | 规则 |
|---|---|
| `accountSetId` / `voucherId` | 正整数内部自增 ID（`Number.isSafeInteger && > 0`），不接受字符串 |
| `period` | `^\d{4}-(0[1-9]|1[0-2])$` |
| `operationId` / `parentOperationId` / `jobId` / `itemId` / `stageId` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`，且父操作不得等于自身 |
| `attempt` | 整数 1..1 000 000；同一逻辑操作内**单调递增**，重试复用同一 attempt |
| `correlation` | 只能是由 `correlationToken(...parts)` 生成的 64 位小写 hex |

**用户可改标识**（batchId、来源凭证 ID、企业身份、名称、摘要等）**永不原样入库**：需要关联时用
`correlationToken(batchId, sourceVoucherId, ...)` 生成服务端哈希令牌；令牌只用于关联 / 去重，不参与业务判断。

## 5. 固定错误映射

`classifyFailure(error)` 只读 `error.code`，按**精确 allowlist** 映射到 `(outcome, resultCode, reasonCode)`：

- `account_set_not_found` / `voucher_not_found` / `period_not_found` / `account_not_found` / `batch_not_found`
  → `rejected` + `not_found`；
- `period_closed` / `opening_rewrite_period_closed` → `rejected` + `blocked_period_closed`；
- 其他已知领域规则码（`posted_voucher_requires_unpost`、`period_unbalanced`、`opening_unbalanced`、
  `already_carried_forward`、`asset_has_depreciation_runs` 等）→ `rejected`；
- `voucher_number_conflict` / `voucher_number_unplanned` / `audit_event_conflict` → `rejected` + `conflict`；
- `audit_write_failed` → `failed` + `audit_unavailable`（reason `audit_write_failed`）；
- **其余任何错误码（含看起来像英文的错误码、任意用户字符串）→ `failed` + `internal_error`**，
  `message` / `stack` / `details` 一概不读取、不保存、不回显。

`AuditError`（`code` + `details`）是本包统一错误类型；`details` 只放计数 / 枚举，不放原始值。
`AuditUnavailableError` 额外带 `auditPersisted=false`。

## 6. 事务与原子性语义（`runAuditedOperation`）

```js
LS.runAuditedOperation(db, { context, terminal }, (audit) => {
  // 业务写入（同一个 db 句柄，同一个事务）
  return businessResult;               // terminal = { outcome, resultCode, reasonCode?, ...范围覆盖 }
});
// → { result, event, appended }
```

1. **最外层**：`BEGIN IMMEDIATE` → `fn(audit)` → 写终态事件 → `COMMIT`。
   任何一步失败都不会让业务先提交、审计后补。
2. **嵌套**（已有事务）：改用 `SAVEPOINT` + `RELEASE`；成功事件仍参与**外层**事务，
   外层回滚时成功事件一起消失。
3. **业务失败 / 正式拒绝**：先回滚本层，再由**最外层**用短事务写固定失败事件（`classifyFailure` 映射），
   然后重新抛出原业务异常（原始 `code` 保持不变，便于 HTTP / Agent 继续映射）。
4. **嵌套失败**：不在尚未回滚的外层事务里写「持久失败」；把待写事件挂在
   `error.auditFailurePending`，由最外层回滚后调用 `appendDeferredFailure(db, error)` 落库。
5. **成功事件写不进**（IO / 锁 / 触发器 RAISE）：业务整体回滚，抛 `audit_write_failed`
   （`businessRolledBack=true`、`successEventPersisted=false`），并尽力补写失败事件。
6. **失败事件也写不进**：抛 `audit_unavailable`（`auditPersisted=false`）；若业务已回滚，
   同时给出 `businessRolledBack=true`。**绝不**把这种情况报成成功。
7. **提交结果不明确**（`COMMIT` / `RELEASE` 抛错）：抛 `audit_commit_unknown`，不伪造 succeeded、
   也不写「业务已回滚」的失败事件；调用方须按「结果未知」处理（重新打开库核验），不能机械当作回滚成功。
8. `appendAuditEvent` 在**事务外**调用直接拒绝（`audit_transaction_required`），避免逐语句自动提交破坏
   「业务与审计同一事务」。
9. 不使用第二个连接抢写锁绕开事务；跨库（业务库 ↔ 恢复 ledger）**不假装原子**（§10）。

## 7. 去重语义

- `dedupe_key = sha256({operationId, attempt, action, accountSetId, voucherId, period, jobId, itemId, stageId, correlation})`，
  在数据库层 `UNIQUE`。
- 同一键 + 相同数据（`outcome` / `resultCode` / `reasonCode` / `parentOperationId`）→ 返回已有事件
  （`appended:false`），不写第二条。
- 同一键 + 不同数据 → `audit_event_conflict`（**不用** `INSERT OR IGNORE` 掩盖），不写第二条。
- 不同 attempt 分别记录；`post → unpost → post` 是三次实际动作（建议 attempt 1/2/3 或不同 operationId），
  不会被 `action + 对象` 全局去重。
- 重复操作（例如再次 post）应作为**新 operation** 记 `outcome=no_change`，不要复用旧 attempt。

## 8. 受保护安装（现库门槛）

`ensureAuditSchema(db, { faultInjection? })`：

| 库状态 | 行为 |
|---|---|
| 无任何表（真空库） | 单事务建结构 → 事务内自检（表 / 版本 / 活动实例）→ `COMMIT`；失败整体回滚 |
| 已装且版本 = 1 | `{ installed: false }`，不重建、不重复写版本（含已有业务表的正常启动场景） |
| 已装但缺表 / 缺版本行 / 缺触发器 | `audit_schema_inconsistent` |
| 组件版本 > 1 | `audit_schema_newer` |
| **含其他业务表（既有库）** | **`audit_install_requires_verified_backup` 明确拒绝，库内容零改动** |

「新库」判定来自对 `sqlite_master` 的**实际观察**（没有任何非审计表），不接受调用方布尔值：
测试里即使传 `{ freshDatabase: true }` 也照样拒绝。

> A 包没有已审 backup 支持，因此**不实施**「先备份再给现库装组件」。B 包在已审 backup 就位后接安装流程，
> 并必须在安装前后验证备份；在那之前「现库升级完成」不能作为事实陈述。

## 9. 只读查询与 CLI

查询 API：

```js
LS.queryAuditEvents(db, { action, outcome, resultCode, actor, operationId,
                          accountSetId, voucherId, period, jobId, itemId, afterSeq, limit })
// → { events, nextCursor, hasMore }；固定 seq ASC；limit 默认 100、上限 500
LS.getAuditEvent(db, { eventId }) / { seq }
LS.auditEventStats(db)      // 只计数，不含业务内容
LS.verifyAuditEvents(db)    // content_digest 自检
LS.assertAuditSchema(db)    // 只读结构断言
```

未知过滤键、非法枚举、非法 ID 类型、`limit` 越界、注入串一律 `audit_filter_invalid`（不回显原值）；
查询不建表、不初始化、不写库。**结构不一致 / 版本更高**的库直接拒绝查询。

CLI（`06-workbench/scripts/local-audit.mjs`，**只读**、必须显式路径、无默认数据目录、无初始化入口）：

```bash
node scripts/local-audit.mjs schema  --db <workbench.db>
node scripts/local-audit.mjs instances --db <workbench.db>
node scripts/local-audit.mjs verify  --db <workbench.db>
node scripts/local-audit.mjs stats   --db <workbench.db>
node scripts/local-audit.mjs events  --db <workbench.db> [--action a] [--outcome o] [--result-code r]
                                     [--actor x] [--operation id] [--account-set n] [--voucher n]
                                     [--period YYYY-MM] [--after-seq n] [--limit n]
node scripts/local-audit.mjs restore-stats        --ledger <ledger.db>
node scripts/local-audit.mjs restore-operations   --ledger <ledger.db> [--status s] [--producer p]
                                                 [--result-code r] [--after-started-at iso]
                                                 [--after-operation id] [--limit n]
node scripts/local-audit.mjs restore-operation    --ledger <ledger.db> --operation <id>
node scripts/local-audit.mjs restore-pending      --ledger <ledger.db> [--limit n]
node scripts/local-audit.mjs restore-transitions  --ledger <ledger.db> --operation <id>
```

退出码：`0` 成功、`2` 参数 / 过滤非法、`3` 文件 / 结构 / 版本不可用、`4` 其他不可用。
错误只输出固定码（`{"error":"audit_filter_invalid"}` 形态），不回显用户值或本机路径。输出恒为 JSON。

## 10. 恢复操作 ledger（独立 SQLite）

`restore_ledger_meta` / `restore_operations` / `restore_operation_events`（迁移历史 append-only）。
调用方**显式**提供路径，并自行放于备份 / 目标目录之外；ledger 不存原始路径、业务金额、凭据或异常原文。

状态机：

```
started ──prepare──► prepared ──publish+receipt──► succeeded
   │                    │
   └────fail/reject────► failed | rejected | unknown
prepared ──reconcile（证据完整）──► succeeded
```

| 原语 | 语义 |
|---|---|
| `beginRestoreOperation(db, {operationId, backupDigest, backupBytes, backupSchemaVersion, componentVersions, producer, noteCode})` | 发布前持久化 `started`；同 operationId 同数据幂等，任一不一致 → `restore_operation_conflict` |
| `markRestorePrepared(db, {operationId, receipt})` | 持久化 operation-bound receipt；不同 receipt → `restore_receipt_mismatch` |
| `completeRestoreOperation(db, {operationId, receipt, backupDigest, targetDigest, targetInstanceId})` | **只能**从 `prepared` 迁移，且 receipt / backupDigest 必须与登记一致；已 succeeded 且证据一致 → 幂等；证据不一致 → 冲突 |
| `failRestoreOperation(db, {operationId, status, resultCode, reasonCode})` | `failed` / `rejected` / `unknown`；已 succeeded 不可改写；同值重复幂等 |
| `reconcileRestoreOperation(db, {operationId, verifyPublished})` | 只基于显式目标 + 回执 + 备份摘要补记终态；不重做恢复、不复制 / 覆盖目录；证据不足 → `terminal:'unknown'` 且**不改状态**，只追加 `restore_reconcile_pending` 迁移记录 |
| `getRestoreOperation` / `listPendingRestoreOperations` / `queryRestoreOperations` / `listRestoreTransitions` / `restoreLedgerStats` | 只读 |

**不能伪造终态**：`succeeded` 需要「已 prepared + receipt 一致 + backupDigest 一致 + 合法 target 摘要 / 实例」；
写入故障整体回滚（测试用真实触发器 RAISE 验证状态仍为 `prepared`，无 `terminal_at`、无 succeeded 迁移记录）。
底层写入失败（IO / 锁 / 触发器）统一归一为 `restore_ledger_write_failed`，不把原始 SQLite 文本当业务结论。

**发布后记账失败**：目标已发布但 ledger 终态没写成时，业务结果应报 `restore_new_...` +
`restore_published_pending`（ledger 保持 `prepared`），随后用 `reconcileRestoreOperation` 在重启后补记；
不得把已发布结果报成「业务已回滚」，也不得重复复制目录。

**跨库语义**：ledger 与业务库是两个数据库，本包**不**声称原子提交；只提供两阶段 + 可对账原语，
真实恢复接线与窗口覆盖由 C 包验收。

**关联方式**：业务库中 `action=restore.new` 事件的 `operationId` 与 ledger 行的 `operation_id` 相同，
ledger 的 `target_instance_id` 与恢复后库的活动审计实例一致；两处都只含技术 ID / 摘要，
不保存备份与目标的原始路径或任何业务记录。

## 11. 给 B / C 的接口清单（不得猜实现细节）

```js
// 契约层（server/local-audit.mjs）
AUDIT_COMPONENT, AUDIT_SCHEMA_VERSION
AUDIT_ACTIONS, AUDIT_OUTCOMES, AUDIT_ACTORS, AUDIT_RESULT_CODES, AUDIT_REASON_CODES
AUDIT_EVENT_FIELDS, AUDIT_EVENT_OVERRIDABLE_FIELDS
AuditError, AuditUnavailableError, auditError(code, details?)
isTechId(v), isTechnicalRowId(v), isAuditPeriod(v), correlationToken(...parts)
createOperationContext(raw), withAttempt(ctx, n), createChildOperation(ctx, {operationId, action, ...}), contextTargets(ctx)
normalizeAuditEvent(raw, context, server), auditEventDedupeKey(event), auditEventDigest(event)
classifyFailure(error), inTransaction(db), runInTransaction(db, fn)

// 业务库审计存储（server/local-audit-storage.mjs）
AUDIT_TABLES, AUDIT_TRIGGERS
inspectAuditSchema(db), assertAuditSchema(db), ensureAuditSchema(db, {faultInjection?})
openAuditDatabase(path, {readOnly=true})
currentAuditInstanceId(db), markAuditInstanceFork(db, {parentInstanceId, note}), listAuditInstances(db)
appendAuditEvent(db, event, {context})                    // 必须在事务内
queryAuditEvents(db, filter), getAuditEvent(db, {eventId|seq}), auditEventStats(db), verifyAuditEvents(db)
runAuditedOperation(db, {context, terminal}, fn, {testHooks?})   // testHooks 仅供测试
appendDeferredFailure(db, error)

// 恢复 ledger（server/local-restore-audit.mjs）
RESTORE_LEDGER_COMPONENT, RESTORE_LEDGER_SCHEMA_VERSION, RESTORE_LEDGER_TABLES,
RESTORE_STATUSES, RESTORE_RESULT_CODES, RESTORE_REASON_CODES
normalizeComponentVersions(raw)
inspectRestoreLedger(db), ensureRestoreLedgerSchema(db), openRestoreLedger(path, {create, readOnly})
beginRestoreOperation, markRestorePrepared, completeRestoreOperation, failRestoreOperation,
reconcileRestoreOperation, getRestoreOperation, listPendingRestoreOperations,
queryRestoreOperations, listRestoreTransitions, restoreLedgerStats
```

B 接线要点（契约约束，不是已完成的实现）：

- 成功 / 实际 `no_change`：事件写在**最外层业务事务提交之前**（用 `runAuditedOperation` 或手工
  `runInTransaction` + `appendAuditEvent`）。
- 拒绝 / 失败：先确认业务回滚，再写失败事件；`dryRun` / 预检成功**不写执行成功事件**。
- 重复操作记 `outcome:no_change`，不要伪造第二次状态变化；不同 attempt 保留各自失败。
- 同一领域入口只记一条领域事件（HTTP / Agent / MCP 均已委托领域层，不要在适配器重复记账）。
- 单条事件只能覆盖 `correlation` 与范围技术 ID（`accountSetId` / `voucherId` / `period` / `jobId` /
  `itemId` / `stageId`）；`operationId` / `attempt` / `action` / `actor` 一律来自上下文，逐条改写给
  `audit_event_field_not_overridable`。
- 审计写入不可用时返回明确 `audit_unavailable` / `auditPersisted:false`，不得吞错后报成功。

## 12. 隐私与数据边界

- 事件只存固定词表 + 内部技术 ID + 服务端时间 + 服务端哈希令牌；不存金额、原始凭证、摘要、姓名、
  企业身份、路径、payload、SQL、堆栈、`e.message`、`e.code`、`e.details` 或任意 metadata JSON。
- 未登记字段一律拒绝，错误信息只给数量 / 字段名枚举，不回显值；未知错误码固定 `internal_error`。
- 测试用合成哨兵放进 payload / summary / name / 用户 batchId / `error.message|code|details|stack` /
  未知 metadata，验证数据库整库转储（含 WAL 合并后）与 CLI stdout/stderr 中均不出现原串。
- 不使用真实账套库、真实备份、税局凭据或私有数据目录；`.agent-runs/` 日志不入 Git。

## 13. 未完成 / 后续门槛

| 项 | 状态 |
|---|---|
| 领域入口接线（db / accounting / import-incremental） | **未做**，等 LOCAL-02 真正合并 + 核心独占窗口 |
| 既有库组件安装（先备份验证再装） | **未做**，A 只实现「明确拒绝」门槛；需已审 backup 支持 |
| HTTP / Agent / MCP 真实入口审计验收 | **未做**（B） |
| 真实 `createBackup` / `verifyBackup` / `restoreNew` 快照 / 恢复 / pending / reconcile 验收 | **未做**（C） |
| 批量 job / stage / fence / 重放接线 | **未做**（C，依赖 LOCAL-07） |
| bank（LOCAL-04）结构纳入备份白名单 | 由各 owner 负责，本包不认领 |
| 原位恢复保护、版本回退、Windows 干净安装/升级 | 后续独立包 |
| 多版本组件升级路径 | 当前只有 v1；新增结构必须加迁移并递增版本，未知更高版本一律 `audit_schema_newer` |

## 14. 测试（本机实跑）

```bash
cd 06-workbench
node test/local-audit.test.mjs          # 25/25，exit 0
node test/local-restore-audit.test.mjs  # 18/18，exit 0
```

两套均为合成临时目录（`mkdtemp`，先设 `WORKBENCH_DATA_DIR`，进程结束清理本人创建的路径）、
真实 `node:sqlite` 文件库（非内存 mock）、不监听端口；CLI 用真实子进程调用。
**未**修改 `scripts/test-all.mjs` / `package.json`，因此 `npm test` 不包含这两套；也不代表其它套件被重跑。
