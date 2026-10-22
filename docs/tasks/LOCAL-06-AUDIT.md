# 任务单 · LOCAL-06 AUDIT（A 包：审计组件与恢复 ledger 原语）

- 类型：后端存储 / 契约 / 只读 CLI / 恢复 ledger 原语 + 测试 + 文档
- 状态：**A 包实现与自测完成，待管理者审查 / PR / 合并**（B、C 未开始）
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（已合并 main）
- 分支 / worktree：`codex/huxiaoyang-code/local-06-audit` / `D:/有数云fork/.worktrees/local-06-audit`
- 人类负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #54](https://github.com/huxiaoyang-code/youshu-fork/issues/54)（`Refs #20`）
- 契约文档：[LOCAL-AUDIT](../LOCAL-AUDIT.md) · 交接：[handoffs/LOCAL-06-AUDIT](../handoffs/LOCAL-06-AUDIT.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)

## 1. 目标（仅 A）

1. 业务库内**独立审计组件**：组件版本表、数据库实例表、append-only 事件表；受保护初始化与结构检查。
2. 严格契约：固定 action / outcome / resultCode / reasonCode 词表；技术 ID / 期间 / attempt / 关联令牌校验；
   未登记字段一律拒绝；未知错误码固定 `internal_error`。
3. 事务原语：事务内 append、回滚后失败事件 append、外层事务 + 内层 SAVEPOINT、提交结果不明确的固定处理、
   审计不可写时明确 `audit_unavailable`。
4. 只读过滤分页查询（参数化、固定排序、稳定游标、limit 上限）与只读 CLI（显式 `--db` / `--ledger`，
   无默认数据目录，无现库初始化入口）。
5. 独立恢复 ledger：started / prepared / succeeded / failed / rejected / unknown、幂等与冲突、
   故障注入下不伪造终态、显式 reconcile 原语。
6. 真实临时 SQLite 验收（两个新测试文件），不改 `scripts/test-all.mjs` / `package.json`。

## 2. 非目标

- 不接线 `db.mjs` / `accounting.mjs` / `import-incremental.mjs` / `server.mjs` / `agent-tools.mjs` / MCP；
- 不编辑 LOCAL-02 核心、`import-storage.mjs`、backup / batch / bank 候选、`public/*`、`package.json`；
- 不实现真实 `createBackup` / `verifyBackup` / `restoreNew` 接线，不复制 / 覆盖任何目录；
- 不对既有业务库执行组件安装（A 只给「明确拒绝」门槛）；
- 不做多租户 / 权限 / 对外服务 / 账户体系；不使用真实账套、备份、凭据或私有数据目录。

## 3. 精确文件清单（本包唯一改动，共 9 个新增文件）

| 文件 | 作用 |
|---|---|
| `06-workbench/server/local-audit.mjs` | 契约：固定词表、技术 ID、operation 上下文、错误映射、事务原语 |
| `06-workbench/server/local-audit-storage.mjs` | 审计组件结构 / 受保护安装 / 事务内 append / 只读查询 / 受控执行 |
| `06-workbench/server/local-restore-audit.mjs` | 独立恢复 ledger 结构 / 状态机 / 幂等冲突 / reconcile |
| `06-workbench/scripts/local-audit.mjs` | 只读查询 CLI（无初始化 / 写入命令） |
| `06-workbench/test/local-audit.test.mjs` | 存储 / 事务 / 去重 / 隐私 / 查询 / 实例分叉验收 |
| `06-workbench/test/local-restore-audit.test.mjs` | ledger 持久化 / 冲突 / 故障注入 / reconcile 验收 |
| `docs/LOCAL-AUDIT.md` | 实际接口、存储 / 事务 / 恢复边界、未接线状态 |
| `docs/tasks/LOCAL-06-AUDIT.md` | 本任务单 |
| `docs/handoffs/LOCAL-06-AUDIT.md` | 本包实现与测试事实交接 |

未改任何既有文件（`git status` 只有上述 9 个 `??` 新文件）。

## 4. 验收口径与结果

| 验收项 | 结果 |
|---|---|
| 真实 SQLite：业务行 + 成功事件同事务提交 | ✅ `runAuditedOperation` 测试，重启后仍可查询 |
| 事件触发器 RAISE / 确定性故障使两者全部回滚 | ✅ 触发器注入成功事件失败 → 业务 0 行，仅固定失败事件 |
| 外层 BEGIN + 内层 SAVEPOINT 后外层失败 | ✅ 业务与成功审计均无；回滚后仅固定失败事件；重启可查 |
| 同 operation 重复相同事件一条；同键不同数据拒绝 | ✅ 去重返回 `appended:false`；冲突 `audit_event_conflict` |
| 不同 attempt 失败分别保留；post/unpost/post 不被粗糙去重 | ✅ attempt 1/2/3 三条事件 |
| 业务对象不存在 / 删除后审计保留；两账套不串数据 | ✅ 事件无外键；范围过滤互斥 |
| 分页无重复 / 无遗漏；非法过滤失败且无注入 | ✅ 23 条分页 + 注入串全部 `audit_filter_invalid` |
| 合成敏感哨兵不进库 / 不进 CLI / 不进错误 | ✅ payload / summary / name / batchId / error.* / 未知 metadata |
| schema 缺表 / 坏版本拒绝；现库无验证备份拒绝且库不变 | ✅ 含传 `freshDatabase:true` 仍拒绝 |
| 初始化异常回滚；查询不创建库 | ✅ 故障注入后无半截对象；只读打开缺文件不创建 |
| ledger started / 终态真实持久化、幂等、冲突 | ✅ 关闭重开后仍可读；冲突不覆盖 |
| ledger 故障注入不能伪造终态 | ✅ 触发器阻止 UPDATE → 状态仍 `prepared`，无终态字段 |
| ledger reconcile 证据不足维持未知、证据完整补记 | ✅ 三种证据不足场景 + 幂等补记 |
| 审计不可写 / 提交结果不明确 | ✅ `audit_unavailable`（`auditPersisted:false`）/ `audit_commit_unknown` |

**未完成的验收（不得声称已完成）**：B 的真实 HTTP / Agent / MCP 领域事件验收；C 的真实
`createBackup` / `verifyBackup` / `restoreNew` / 批量续跑 / 恢复 pending→reconcile 接线验收。
A 不满足「LOCAL06 审计已覆盖全部动作」。

## 5. 实际测试（本机实跑）

工作目录 `06-workbench`，基线 `257f96275031eefa484699dd71bd012e2d221e51`：

| 命令 | 结果 |
|---|---|
| `node test/local-audit.test.mjs` | **25 / 25 通过，exit 0** |
| `node test/local-restore-audit.test.mjs` | **18 / 18 通过，exit 0** |

两套使用 `mkdtemp` 合成临时目录、导入前锁定 `WORKBENCH_DATA_DIR`、真实 `node:sqlite` 文件库、
真实子进程调用 CLI；进程结束清理本人创建的路径（清理失败即非 0 退出）。
**未修改 `scripts/test-all.mjs` / `package.json`**，因此 `npm test` 不包含这两套；
本轮未重跑其它套件，不声称全套回归通过。

## 6. 后续开放条件

- **B**：LOCAL-02 真正合并 + 核心独占窗口 + 已审 backup 对当前 schema/audit 的支持到位后，才能接
  `db.mjs` / `accounting.mjs` / `import-incremental.mjs` 与真实 HTTP / Agent / MCP 验收。
- **C**：backup / LOCAL-07 实际合并或原 owner 明确转交后，接恢复 / 批量 / 快照验收；
  本包不重做调度器，不编辑 04 bank 文件。
- 原位恢复保护、版本回退、Windows 交付仍列后续包。
