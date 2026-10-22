# 交接 · LOCAL-06 AUDIT（A 包）

- 日期：2026-10-22（本机时间）
- 人类负责人：`huxiaoyang-code`（已核实）
- 实现员工：本机 pi，主 / 唯一回退均为已核实的 tokenhub `deepseek-v4.1-flash`；本次为新的 pi 进程、
  无会话持久化，未启用子 agent；**未执行 commit / push / merge**，Git 由 root 管理。
- 已审源码 head：`63d03840bff2d28a662514340e7b873f9997e149`（未参与实现的 `review_audit06_final`
  通过原 5 项问题修复 + 后续 9 组复审）
- 整合候选 head：`104336a5a66dd4ed43a31a2f618d0ebe7828bd8e`（由管理者将精确 `main`
  `db6020aa381965d3143a4f1fd895a8cceaf8e937` 合入本分支形成；本包 9 文件与源码 head 逐字未变）
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（A 包开发基线，已合并 main）
- 分支：`codex/huxiaoyang-code/local-06-audit`
- 远端载体：[Issue #54](https://github.com/huxiaoyang-code/youshu-fork/issues/54) / [Issue #49](https://github.com/huxiaoyang-code/youshu-fork/issues/49)，均保持 OPEN
- 契约：[LOCAL-AUDIT](../LOCAL-AUDIT.md) · 任务单：[tasks/LOCAL-06-AUDIT](../tasks/LOCAL-06-AUDIT.md)

## 1. 状态

**A 包已通过最终独立审查（原 5 项 + 后续 9 组复审），已并入整合候选 head；
本包未创建 PR、未合并，待文档更新后的最终 head 增量复核。B、C 未开始，未占用共享文件。**

- 包内共 9 个文件（4 代码 + 2 测试 + 3 文档），`63d0384` → `104336a` 之间逐字未变（`git diff` 为空），
  未动任何既有源码 / 测试 / CLI / schema；
- 未修改 `scripts/test-all.mjs` / `package.json`，新测试**不在** `npm test` 内；
- 未读取其他包候选实现源码、日志或私有历史，未复制其候选代码（main 已含独立备份子包，本包不调用、
  不依赖其实现细节）；
- 未接触真实账套库、备份产物、税局凭据或私有数据目录；所有测试均为合成临时库；
- **B / C 仍未接线**；既有库组件安装与真实 `createBackup` / `verifyBackup` / `restoreNew`、
  安装备份流程均**未完成**，现库仍一律拒绝；unknown → succeeded 只是显式核验结果，**不声称跨库原子**。

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

工作目录 `06-workbench`（两个 head 必须区分）：

```bash
node test/local-audit.test.mjs          # 28/28，exit 0
node test/local-restore-audit.test.mjs  # 22/22，exit 0
```

| head | 实跑者 | 结果 |
|---|---|---|
| 已审源码 `63d0384` | 管理者 | `28/28`、`22/22`，exit 0 |
| 整合候选 `104336a`（9 文件与 `63d0384` 逐字一致） | 管理者 | 合成临时库 `28/28`、`22/22`，exit 0 |

历史实施自测记录（修复前代码）：`25/28`、`16/22`；不作为已审 `63d0384` 或整合 `104336a`
的管理者红测证据。

两套均：`mkdtemp` 临时目录 → 先设 `WORKBENCH_DATA_DIR` → 真实 `node:sqlite` 文件库 →
真实子进程 CLI → 结束关闭句柄并删除本人创建的临时目录（清理失败即 exit≠0）。
关键合成场景均以真实数据库行为验证（触发器 `RAISE(ABORT)` 注入、`BEGIN`/`SAVEPOINT` 回滚、
关闭重开、`INSERT OR REPLACE` 实际拒绝、整库转储扫描哨兵），没有以 mock array / console 输出代替持久化。

原始运行日志保存在本机 Git 忽略的管理目录，不入 Git，本文件不写本机路径。
所有测试均为合成临时库，即真实 SQLite 行为验证均使用合成临时库；未做真库验证。
只读 CLI 的产品边界（契约 §9）不变。
本次文档更新**未重跑**业务测试；其它套件也未重跑，不声称全套回归通过。
仓库无 CI，不冒充 GitHub 第二账号批准。

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
| 本包收尾：文档更新后的最终 head 增量复核 → 建 PR / attach → 合并 | 原独立审查者（未参与实现）；主线合并锁在 root，本任务无合并权 |
| B：领域入口接线（`db.mjs` / `accounting.mjs` / `import-incremental.mjs`）+ 真实 HTTP / Agent / MCP 验收 | LOCAL-02 真正合并 + 核心独占窗口 + 独立备份子包就位 |
| C：真实 `createBackup` / `verifyBackup` / `restoreNew`、安装备份、pending→reconcile、批量续跑 / fence 验收 | 独立备份子包、LOCAL-07 实际合并或原 owner 明确转交 |
| 既有库组件安装（先备份验证） | B 接线安装前后备份验证；本包只保留拒绝门槛 |
| 多版本组件升级路径 | 后续包（当前仅 v1，未知更高版本拒绝） |
| 原位恢复保护 / 版本回退 / Windows 交付 | 后续独立包 |

**边界声明（不得省略）**：B / C 未接线；真实 `createBackup` / `verifyBackup` / `restoreNew`、
安装备份流程与「pending → reconcile」实际接线都未完成；现库安装仍一律拒绝；本包不具跨库原子事务；
unknown → succeeded 是之后显式核验的结果，ledger 与业务库**非跨库原子**；不声称 LOCAL06 审计已覆盖全部动作。

## 6. 恢复本包现场的方法

1. 在本仓库（分支 `codex/huxiaoyang-code/local-06-audit`，不得直接改 main）核对 `git status --short` /
   `git log --oneline -1`；变更范围应限于 4 代码 + 2 测试 + 本 3 个文档；A 包原语的已审源码 head 仍为
   `63d0384`，合入 main 后的整合／文档 head 为 `104336a` 及其后续；
2. 在 `06-workbench` 目录直接运行 §3 两条命令（无需任何真实数据或端口）；
3. 需要接口细节读 [LOCAL-AUDIT](../LOCAL-AUDIT.md) §11，不要从其他候选分支猜实现；
4. 最终 head 增量复核 → PR 由管理者 / 原独立审查者接手；B 包使用新进程 / 新会话，
   只载入任务单、本交接与 `docs/LOCAL-AUDIT.md`。
