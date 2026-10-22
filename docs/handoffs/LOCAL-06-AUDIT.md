# 交接 · LOCAL-06 AUDIT（A 包）

- 日期：2026-10-22（本机时间）
- 人类负责人：`huxiaoyang-code`（已核实）
- 实现员工：本机 pi，主 / 唯一回退均为已核实的 tokenhub `deepseek-v4.1-flash`，新进程无会话持久化，
  未使用子 agent；**未执行 commit / push / merge**，Git 由 root 管理。
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（已合并 main）
- 分支 / worktree：`codex/huxiaoyang-code/local-06-audit` / `D:/有数云fork/.worktrees/local-06-audit`
- 远端载体：[Issue #54](https://github.com/huxiaoyang-code/youshu-fork/issues/54)
- 契约：[LOCAL-AUDIT](../LOCAL-AUDIT.md) · 任务单：[tasks/LOCAL-06-AUDIT](../tasks/LOCAL-06-AUDIT.md)

## 1. 状态

**A 包实现与自测完成，待管理者审查 / PR / 合并。B、C 未开始，未占用共享文件。**

- 本轮只新增 9 个文件（4 代码 + 2 测试 + 3 文档），`git status` 无任何既有文件改动；
- 未修改 `scripts/test-all.mjs` / `package.json`，新测试**不在** `npm test` 内；
- 未读取 LOCAL-02 / backup / LOCAL-07 候选实现源码、日志或私有历史，未复制其候选代码；
- 未接触真实账套库、备份产物、税局凭据或私有数据目录；所有测试均为合成临时库。

## 2. 实际交付

| 文件 | 内容 |
|---|---|
| `06-workbench/server/local-audit.mjs` | 固定 action/outcome/resultCode/reasonCode 词表；技术 ID / 期间 / attempt / 关联令牌校验；`createOperationContext` / `withAttempt` / `createChildOperation`；`classifyFailure` 精确 allowlist 映射；`inTransaction` / `runInTransaction`（外层 BEGIN IMMEDIATE、嵌套 SAVEPOINT） |
| `06-workbench/server/local-audit-storage.mjs` | `audit_components` / `audit_database_instances` / `audit_events`（append-only 触发器、`content_digest`）；受保护安装（空库安装、既有库**拒绝**、坏版本拒绝、故障回滚）；`appendAuditEvent`（仅事务内、去重 / 冲突）；`runAuditedOperation` / `appendDeferredFailure`；只读查询 / 统计 / 完整性自检；实例分叉 |
| `06-workbench/server/local-restore-audit.mjs` | 独立 ledger 三表 + append-only 迁移记录；`beginRestoreOperation` / `markRestorePrepared` / `completeRestoreOperation` / `failRestoreOperation` / `reconcileRestoreOperation`；只读查询与待对账列表 |
| `06-workbench/scripts/local-audit.mjs` | 只读 CLI：`schema` / `instances` / `verify` / `stats` / `events` / `restore-stats` / `restore-operations` / `restore-operation` / `restore-pending` / `restore-transitions`；显式 `--db` / `--ledger`，无初始化与写入口 |
| `06-workbench/test/local-audit.test.mjs` | 25 项：初始化 / 结构 / 事务原子性 / 提交不明 / 去重 / 留痕 / 隔离 / 分页 / 注入 / 隐私哨兵 / 实例分叉 / 篡改自检 / CLI |
| `06-workbench/test/local-restore-audit.test.mjs` | 18 项：打开与结构 / 生命周期 / 幂等冲突 / 终态防伪造 / 故障注入 / reconcile / 分页 / 隐私 / 两库独立 / append-only / CLI |
| `docs/LOCAL-AUDIT.md` | 实际接口清单、白名单、词表、错误映射、事务语义、去重、安装门槛、ledger 状态机与跨库非原子说明、未完成门槛、测试命令 |
| `docs/tasks/LOCAL-06-AUDIT.md` | 任务单（A 范围、9 文件、验收对照、测试结果、B/C 开放条件） |
| `docs/handoffs/LOCAL-06-AUDIT.md` | 本文件 |

## 3. 实跑证据

工作目录 `06-workbench`（基线 `257f962`）：

```
node test/local-audit.test.mjs          → 25/25 通过，exit 0
node test/local-restore-audit.test.mjs  → 18/18 通过，exit 0
```

两套均：`mkdtemp` 临时目录 → 先设 `WORKBENCH_DATA_DIR` → 真实 `node:sqlite` 文件库 →
真实子进程 CLI → 结束关闭句柄并删除本人创建的临时目录（清理失败即 exit≠0）。
关键合成场景均以真实数据库行为验证（触发器 `RAISE(ABORT)` 注入、`BEGIN`/`SAVEPOINT` 回滚、
关闭重开、整库转储扫描哨兵），没有以 mock array / console 输出代替持久化。

**未重跑**其它套件；不声称全套回归通过。仓库无 CI，不冒充 GitHub 第二账号批准。

## 4. 关键设计决定（审查关注点）

1. **审计组件版本独立于 LOCAL-02 全局 schema**：`audit_components` 记 `business-audit=1`，不抢 v4。
2. **既有库安装直接拒绝**（`audit_install_requires_verified_backup`）：A 无已审 backup 支持，故只实现
   门槛；判定来自实际表观察，调用方布尔值（含 `freshDatabase:true`）不能绕过。B 接已审 backup 后放开。
3. **事件无外键 + append-only 触发器**：业务对象删除后留痕仍在；UPDATE / DELETE 被数据库拒绝。
4. **成功事件必须在调用方事务内**：事务外 `appendAuditEvent` 直接 `audit_transaction_required`。
5. **失败事件回滚后写**；嵌套失败不写进未回滚的外层，交由最外层 `appendDeferredFailure`。
6. **提交结果不明确固定 `audit_commit_unknown`**：不伪造成功、不写「业务已回滚」的失败事件。
7. **去重键含 operationId/attempt/action/范围目标/关联令牌**；同键不同数据 `audit_event_conflict`。
8. **用户标识只以服务端 sha256 令牌（`correlationToken`）落库**，不存 batchId / 来源凭证 ID 原串。
9. **恢复 ledger 两阶段 + reconcile**：`succeeded` 只能从 `prepared` + receipt/digest 一致迁移；
   证据不足不改状态，只追加 `restore_reconcile_pending`；明确声明跨库非原子。
10. CLI **无初始化 / 写入命令**，非法参数与未知选项只回固定错误码，不回显用户值或本机路径。

### 审计写入不可用时的真实行为

| 场景 | 返回值 | 业务状态 | 库内留痕 |
|---|---|---|---|
| 成功事件写不进（IO / 锁 / 触发器 RAISE） | `audit_write_failed`，`businessRolledBack=true`、`successEventPersisted=false` | 整体回滚 | 尽力补写固定失败事件（`resultCode=audit_unavailable`、`reasonCode=audit_write_failed`） |
| 连失败事件也写不进 | `audit_unavailable`，`auditPersisted=false`，`businessRolledBack=true` | 整体回滚 | 无 |
| `COMMIT` / `RELEASE` 抛错 | `audit_commit_unknown`，`auditPersisted=false` | **未知**（不得声称已回滚） | 不写失败事件（写了就是伪造「已回滚」） |
| 业务失败 / 正式拒绝 | 原始领域异常原样抛出（含 `code`），附加 `auditEvent` / `auditPersisted` | 已回滚 | 固定失败事件（`classifyFailure` 映射） |
| 嵌套调用失败（外层未回滚） | 原始异常 + `auditFailurePending`，`auditPersisted=false` | 由外层决定 | 外层回滚后 `appendDeferredFailure` 写入 |
| 同 operation/attempt 键已被不同数据占用 | `audit_event_conflict`（`businessError` 附在错误上） | 回滚 | 不覆盖已有事件 |

任何一条都不会把结果报成「完整成功」；调用方（B/C）必须把这些情况映射为明确失败 / 未知。

## 5. 未完成 / 阻塞与下一步

| 项 | 依赖 |
|---|---|
| B：领域入口接线（`db.mjs` / `accounting.mjs` / `import-incremental.mjs`）+ 真实 HTTP / Agent / MCP 验收 | LOCAL-02 真正合并 + 核心独占窗口 + 已审 backup 支持 |
| C：真实 `createBackup` / `verifyBackup` / `restoreNew`、pending→reconcile、批量续跑 / fence 验收 | backup、LOCAL-07 实际合并或原 owner 明确转交 |
| 既有库组件安装（先备份验证） | 已审 backup 模块 |
| 多版本组件升级路径 | 后续包（当前仅 v1，未知更高版本拒绝） |
| 原位恢复保护 / 版本回退 / Windows 交付 | 后续独立包 |

## 6. 恢复本包现场的方法

1. `git -C D:/有数云fork/.worktrees/local-06-audit status --short` 与 `git log --oneline -1` 核对基线；
2. 直接运行 §3 两条命令（无需任何真实数据或端口）；
3. 需要接口细节读 [LOCAL-AUDIT](../LOCAL-AUDIT.md) §11，不要从候选工作区猜实现；
4. 下一部分（B）使用新进程 / 新会话，只载入任务单、本交接与 `docs/LOCAL-AUDIT.md`。
