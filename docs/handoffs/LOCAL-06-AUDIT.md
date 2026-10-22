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

**A 包已按独审 5 项 + unknown 边界返工完成，待复审 / PR / 合并。B、C 未开始，未占用共享文件。**

- 本轮只新增 9 个文件（4 代码 + 2 测试 + 3 文档），`git status` 无任何既有文件改动；
- 未修改 `scripts/test-all.mjs` / `package.json`，新测试**不在** `npm test` 内；
- 未读取 LOCAL-02 / backup / LOCAL-07 候选实现源码、日志或私有历史，未复制其候选代码；
- 未接触真实账套库、备份产物、税局凭据或私有数据目录；所有测试均为合成临时库；
- **B / C 仍未接线**；既有库组件安装与真实 `createBackup` / `verifyBackup` / `restoreNew`、
  安装备份流程均**未完成**；unknown → succeeded 只是显式核验结果，**不声称跨库原子**。

## 2. 实际交付

| 文件 | 内容 |
|---|---|
| `06-workbench/server/local-audit.mjs` | 固定 action/outcome/resultCode/reasonCode 词表；技术 ID / 期间 / attempt / 关联令牌校验；`createOperationContext` / `withAttempt` / `createChildOperation`；`classifyFailure` 精确 allowlist 映射；`inTransaction` / `runInTransaction`（外层 BEGIN IMMEDIATE、嵌套 SAVEPOINT） |
| `06-workbench/server/local-audit-storage.mjs` | `audit_components` / `audit_database_instances`（`note_code` 固定枚举）/ `audit_events`；**UPDATE / DELETE / INSERT OR REPLACE 三重 append-only 触发器**；受保护安装（空库安装、既有库**拒绝**、坏版本 / 缺列 / 缺少或同名无效触发器拒绝、故障回滚）；`appendAuditEvent`（仅事务内、去重 / 冲突）；`runAuditedOperation` / `appendDeferredFailure`；只读查询 / 统计 / 完整性自检；实例分叉 |
| `06-workbench/server/local-restore-audit.mjs` | 独立 ledger 三表 + **UPDATE / DELETE / REPLACE 迁移历史保护**；`beginRestoreOperation` / `markRestorePrepared` / `completeRestoreOperation` / `failRestoreOperation` / `reconcileRestoreOperation`；终态按完整字段幂等 / 冲突；unknown 保持可对账；只读查询与待对账列表 |
| `06-workbench/scripts/local-audit.mjs` | 只读 CLI：`schema`（完整结构断言 + `ok/state/problems`，非 ok exit 3）/ `instances` / `verify` / `stats` / `events` / `restore-stats` / `restore-operations` / `restore-operation` / `restore-pending` / `restore-transitions`；显式 `--db` / `--ledger`，无初始化与写入口 |
| `06-workbench/test/local-audit.test.mjs` | 28 项：初始化 / 结构 / 事务原子性 / 提交不明 / 去重 / 留痕 / 隔离 / 分页 / 注入 / 隐私哨兵 / 实例分叉 / note 枚举 / REPLACE 防护 / CLI schema 结构断言 / 篡改自检 |
| `06-workbench/test/local-restore-audit.test.mjs` | 22 项：打开与结构 / 生命周期 / 幂等冲突 / 终态防伪造 / fail 完整字段幂等 / 故障注入 / reconcile / **unknown 可对账** / 分页 / 隐私 / 两库独立 / append-only + REPLACE / 触发器定义 / 缺列 |
| `docs/LOCAL-AUDIT.md` | 实际接口清单、白名单、词表、错误映射、事务语义、去重、安装门槛、ledger 状态机与跨库非原子说明、未完成门槛、测试命令 |
| `docs/tasks/LOCAL-06-AUDIT.md` | 任务单（A 范围、9 文件、验收对照、测试结果、B/C 开放条件） |
| `docs/handoffs/LOCAL-06-AUDIT.md` | 本文件 |

## 3. 实跑证据

工作目录 `06-workbench`（基线 `257f962`）：

```
node test/local-audit.test.mjs          → 28/28 通过，exit 0
node test/local-restore-audit.test.mjs  → 22/22 通过，exit 0
```

两套均：`mkdtemp` 临时目录 → 先设 `WORKBENCH_DATA_DIR` → 真实 `node:sqlite` 文件库 →
真实子进程 CLI → 结束关闭句柄并删除本人创建的临时目录（清理失败即 exit≠0）。
关键合成场景均以真实数据库行为验证（触发器 `RAISE(ABORT)` 注入、`BEGIN`/`SAVEPOINT` 回滚、
关闭重开、`INSERT OR REPLACE` 实际拒绝、整库转储扫描哨兵），没有以 mock array / console 输出代替持久化。

**修复前先红**：把同两份测试放到 `HEAD` 的 4 个代码文件上实跑，审计 `25/28`、ledger `16/22`
（共 9 项失败，含 2 项原有加强用例）；修复后 `28/28`、`22/22`。原 25 / 18 项全部保留、未弱化。

**未重跑**其它套件；不声称全套回归通过。仓库无 CI，不冒充 GitHub 第二账号批准。

## 4. 关键设计决定（审查关注点）

1. **审计组件版本独立于 LOCAL-02 全局 schema**：`audit_components` 记 `business-audit=1`，不抢 v4。
2. **既有库安装直接拒绝**（`audit_install_requires_verified_backup`）：A 无已审 backup 支持，故只实现
   门槛；判定来自实际表观察，调用方布尔值（含 `freshDatabase:true`）不能绕过。B 接已审 backup 后放开。
3. **事件无外键 + 三重 append-only 触发器**：业务对象删除后留痕仍在；UPDATE / DELETE 被数据库拒绝；
   `audit_events_no_replace` 在 BEFORE INSERT 阶段拒绝与既有 `seq` / `event_id` / `dedupe_key`
   冲突的插入，**默认 `recursive_triggers=0`** 下的 `INSERT OR REPLACE` / `REPLACE INTO` / UPSERT
   也不能替换历史（不声称抵御 DBA 主动 DROP TRIGGER；结构断言会发现并拒绝）。
4. **成功事件必须在调用方事务内**：事务外 `appendAuditEvent` 直接 `audit_transaction_required`。
5. **失败事件回滚后写**；嵌套失败不写进未回滚的外层，交由最外层 `appendDeferredFailure`。
6. **提交结果不明确固定 `audit_commit_unknown`**：不伪造成功、不写「业务已回滚」的失败事件。
7. **去重键含 operationId/attempt/action/范围目标/关联令牌**；同键不同数据 `audit_event_conflict`。
8. **用户标识只以服务端 sha256 令牌（`correlationToken`）落库**，不存 batchId / 来源凭证 ID 原串。
9. **恢复 ledger 两阶段 + reconcile**：`succeeded` 能从 `prepared` 或**带 receipt 的 unknown** +
   receipt/digest 一致迁移；证据不足不改状态，只追加 `restore_reconcile_pending`；明确声明跨库非原子。
   `unknown` 是「结果待确认」：保留在 `restore-pending` 可对账集合，不能被猜成功或盲改 failed。
10. **实例分叉 note 是固定技术枚举**（`initial` / `restore-new`）：不接受自由文本 / 本机路径，
   数据库 CHECK 兜底；错误只回字段名。
11. **ledger 迁移历史同样三重保护**（UPDATE / DELETE / REPLACE），已安装检查与只读打开都逐字比对
    触发器定义；同名但空 body 的触发器不能假通过。缺列 / 未知版本先结构检查再查询，给固定结构化拒绝。
12. CLI **无初始化 / 写入命令**，非法参数与未知选项只回固定错误码，不回显用户值或本机路径；
    `schema` 是完整结构断言（`ok/unsupported/invalid/not_installed`），非 ok 按契约 exit 3 且只读不改库。

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
| C：真实 `createBackup` / `verifyBackup` / `restoreNew`、安装备份、pending→reconcile、批量续跑 / fence 验收 | backup、LOCAL-07 实际合并或原 owner 明确转交 |
| 既有库组件安装（先备份验证） | 已审 backup 模块 |
| 多版本组件升级路径 | 后续包（当前仅 v1，未知更高版本拒绝） |
| 原位恢复保护 / 版本回退 / Windows 交付 | 后续独立包 |

**边界声明（不得省略）**：B / C 未接线；真实 `createBackup` / `verifyBackup` / `restoreNew`、
安装备份流程与「pending → reconcile」实际接线都未完成；审计组件对既有业务库仍只给「明确拒绝」门槛；
unknown → succeeded 是之后显式核验的结果，ledger 与业务库**非跨库原子**；不声称 LOCAL06 审计已覆盖全部动作。

## 6. 恢复本包现场的方法

1. `git -C D:/有数云fork/.worktrees/local-06-audit status --short` 与 `git log --oneline -1` 核对基线；
2. 直接运行 §3 两条命令（无需任何真实数据或端口）；
3. 需要接口细节读 [LOCAL-AUDIT](../LOCAL-AUDIT.md) §11，不要从候选工作区猜实现；
4. 下一部分（B）使用新进程 / 新会话，只载入任务单、本交接与 `docs/LOCAL-AUDIT.md`。
