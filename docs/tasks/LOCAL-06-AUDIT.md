> **当前 W2b：29完整65独审接受，main0e新head待增量核证／PR（2026-10-24）**：BASE `0e89a2d107fd75ff18dc0998e89d96c3217baeb3`，[最新精确认领](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6376168302)，原66／总65文件不增。五套上游补验已通过，尚未PR／合并；八任务6/8、税局真实0。当前证据与后续动作见[LOCAL06交接](../handoffs/LOCAL-06-AUDIT.md)。

以下保留R4阶段说明；最新main0e与已接受的29独审状态以页头交接为准。

负责人huxiaoyang-code。R4唯一兜底实施者完成四路径修复后停止，root在冻结字节上通过13原套＋1自选probe并实际关闭；当前只收口13docs与总manifest，不改52份非文档。旧81被最终独审拒绝，下一步锁定最终整合head并安排全新最终独审，尚无本W2b PR/merge。

## 2026-10-24 最初882/49窗口实施记录（历史）

基线PR87 merge `882c5b65564fd7e2281eba4a799b3a7a25c5b5f3`；Issue54本片最初46路径，加两处真实旧fixture与模型真实rollback断言的最小扩窗共49（bank-reconciliation.test.mjs仅索引建序；local-audit-install.test.mjs仅新仅core夹具、不改原断言；finance-model-adapter.test.mjs仅真实私有rollback案例并加强失败receipt/业务零变）。范围是真实领域/HTTP/rawAgent/model/MCP/CLI、receipt2可信结果重放、受控保存点/metadata/固定child以及batch最小效果+审计+checkpoint接线。已实施并必要自测，尚未root最终验收/全新独审/PR/合并；不关闭06/07、不标八包完成。接口与限制见[LOCAL-AUDIT](../LOCAL-AUDIT.md)。

历史49窗口 [Issue54 49路径认领](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6372348975)：原46，加银行/core-only两处夹具与模型真实rollback断言的最小窗口；其余旧测试只读。

> 2026-10-23 W2a 当前任务：基线PR74 merge `c4ae3674988ebefdc80baf12a2a20b06ff623147`；[Issue54精确21路径](https://github.com/huxiaoyang-code/youshu-fork/issues/54#issuecomment-6366469014)，负责人huxiaoyang-code。唯一经用户明确授权的fallback实施者完成本片实现与自测后冻结，root独立验收、全新未实施者独审与Git/PR；本任务不直接关闭Issue54。范围仅audit2基础、strict官方备份、owner-only/durable pending/私有单用授权/receipt-only与audit先装后bank/aux兼容。实际业务接线/统一锁/批量/恢复分叉/Windows不在本片。下一片先W3a batch1/2严格备份与保护升级，再W2b可信coordinator，随后W3b/W4/Windows/最终整链；不得预放行batch。原八包01/02/03/04/05/08为6/8，06/07未完、税局0。实际验收证据见[审计交接](../handoffs/LOCAL-06-AUDIT.md)，不预报PR/合并。
# 任务单 · LOCAL-06 AUDIT（A 包：审计组件与恢复 ledger 原语）

- 类型：后端存储 / 契约 / 只读 CLI / 恢复 ledger 原语 + 测试 + 文档
- 状态：**A 包已通过最终独立审查（原 5 项问题 + 后续 9 组复审），已并入整合候选 head；
  待最终 head 增量复核 → 建 PR → 合并。本包未创建 PR、未合并，B、C 未开始**
- 已审源码 head：`63d03840bff2d28a662514340e7b873f9997e149`
- 整合候选 head：`104336a5a66dd4ed43a31a2f618d0ebe7828bd8e`（由管理者将精确 `main`
  `db6020aa381965d3143a4f1fd895a8cceaf8e937` 合入本分支形成；本包 9 文件与该源码 head 逐字未变）
- 基线：`257f96275031eefa484699dd71bd012e2d221e51`（A 包开发基线，已合并 main）
- 分支：`codex/huxiaoyang-code/local-06-audit`
- 人类负责人：`huxiaoyang-code`（已核实）
- 远端载体：[Issue #54](https://github.com/huxiaoyang-code/youshu-fork/issues/54)（`Refs #20`）、
  [Issue #49](https://github.com/huxiaoyang-code/youshu-fork/issues/49)：**均保持 OPEN**，本包不关闭任何 Issue
- 契约文档：[LOCAL-AUDIT](../LOCAL-AUDIT.md) · 交接：[handoffs/LOCAL-06-AUDIT](../handoffs/LOCAL-06-AUDIT.md)
- 总览：[INDEPENDENT-PRODUCT-WORK](INDEPENDENT-PRODUCT-WORK.md)

## 1. 目标（仅 A）

1. 业务库内**独立审计组件**：组件版本表、数据库实例表、append-only 事件表；受保护初始化与结构检查。
2. 严格契约：固定 action / outcome / resultCode / reasonCode 词表；技术 ID / 期间 / attempt / 关联令牌校验；
   未登记字段一律拒绝；未知错误码固定 `internal_error`。
3. 事务原语：事务内 append、回滚后失败事件 append、外层事务 + 内层 SAVEPOINT、提交结果不明确的固定处理、
   审计不可写时明确 `audit_unavailable`。
4. 只读过滤分页查询（参数化、固定排序、稳定游标、limit 上限）与只读 CLI（显式 `--db` / `--ledger`，
   无默认数据目录，无现库初始化入口；`schema` 执行完整结构断言并按契约 exit 3）。
5. 独立恢复 ledger：started / prepared / succeeded / failed / rejected / unknown、幂等与冲突、
   故障注入下不伪造终态、显式 reconcile 原语；unknown 保持可对账并可显式核验。
6. 真实临时 SQLite 验收（两个新测试文件），不改 `scripts/test-all.mjs` / `package.json`。
7. 独审修复：实例分叉 note 固定枚举；默认连接下审计 / ledger 历史不可被 `INSERT OR REPLACE` 替换；
   终态幂等按完整字段；结构断言覆盖列 / 触发器定义；unknown 不退出可对账集合。

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

未改任何既有文件：包内 9 个文件在源码 head `63d0384` 与整合候选 head `104336a` 之间逐字未变
（`git diff` 为空），未动 `scripts/test-all.mjs`、`package.json`、共享状态索引或任何源码 / 测试 / CLI。

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
| 合成敏感哨兵不进库 / 不进 CLI / 不进错误 | ✅ payload / summary / name / batchId / error.* / 未知 metadata；**另含本机路径哨兵** |
| schema 缺表 / 坏版本拒绝；现库无验证备份拒绝且库不变 | ✅ 含传 `freshDatabase:true` 仍拒绝 |
| 初始化异常回滚；查询不创建库 | ✅ 故障注入后无半截对象；只读打开缺文件不创建 |
| **实例分叉 note 只接受固定枚举** | ✅ `initial` / `restore-new`；自由文本 / 路径样哨兵 → `audit_operation_invalid`，数据库 CHECK 兜底，CLI / 错误无哨兵 |
| **默认连接不能替换审计历史** | ✅ `recursive_triggers=0` 下 `INSERT OR REPLACE`（seq / event_id / dedupe_key）被 BEFORE INSERT 触发器拒绝；原事件 / 摘要自检不变，合法幂等仍 `appended:false` |
| **schema 完整结构断言** | ✅ 更高版本 → CLI `exit 3` + `state:unsupported`；缺触发器 / 缺列 → `exit 3` + `state:invalid`；只读不改库 |
| ledger started / 终态真实持久化、幂等、冲突 | ✅ 关闭重开后仍可读；冲突不覆盖 |
| **ledger 终态幂等按完整字段** | ✅ 同请求 `changed:false`；同 status 改 resultCode / reasonCode / noteCode → `restore_state_conflict`，原库与迁移历史不变；可迁移行上的非法 status/resultCode 组合 → `restore_operation_invalid` |
| ledger 故障注入不能伪造终态 | ✅ 触发器阻止 UPDATE → 状态仍 `prepared`，无终态字段 |
| **ledger 触发器真实保护 + 结构检查** | ✅ 缺失或同名无效触发器 → ensure / 只读 open 均 `restore_ledger_inconsistent`；REPLACE 迁移历史被拒；缺列先结构检查给固定拒绝 |
| ledger reconcile 证据不足维持未知、证据完整补记 | ✅ 三种证据不足场景 + 幂等补记 |
| **unknown 保持可对账** | ✅ prepared→unknown 后 reconcile 调用证据 callback；证据不足保持 unknown 且在待对账列表；完整证据 → succeeded；unknown 不得被盲改 failed |
| 审计不可写 / 提交结果不明确 | ✅ `audit_unavailable`（`auditPersisted:false`）/ `audit_commit_unknown` |
| **最终独立审查（`review_audit06_final`，未参与实现）** | ✅ 原 5 项问题逐项修复 + 后续 9 组复审通过；不冒充 GitHub 第二账号批准 |
| **整合候选 head 复验** | ✅ 整合候选 `104336a` 另在合成临时库复验 `28/28`、`22/22`（exit 0）；9 文件与 `63d0384` 逐字未变，合入的是精确 `main` `db6020a` |

**未完成的验收（不得声称已完成）**：B 的真实 HTTP / Agent / MCP 领域事件验收；C 的真实
`createBackup` / `verifyBackup` / `restoreNew` / 批量续跑 / 恢复 pending→reconcile 接线验收。
A 不满足「LOCAL06 审计已覆盖全部动作」。

## 5. 实际测试（本机实跑）

工作目录 `06-workbench`（开发基线 `257f962`；两个 head 必须区分）：

```bash
node test/local-audit.test.mjs          # 28/28，exit 0
node test/local-restore-audit.test.mjs  # 22/22，exit 0
```

| head | 实跑者 | 结果 |
|---|---|---|
| 已审源码 `63d0384` | 管理者 | `28/28`、`22/22`，exit 0 |
| 整合候选 `104336a` | 管理者 | 另在合成临时库实跑 `28/28`、`22/22`，exit 0 |

历史实施自测记录（修复前代码）：`25/28`、`16/22`；不作为已审 `63d0384` 或整合 `104336a`
的管理者红测证据。

两套使用 `mkdtemp` 合成临时目录、导入前锁定 `WORKBENCH_DATA_DIR`、真实 `node:sqlite` 文件库、
真实子进程调用 CLI；进程结束清理本人创建的路径（清理失败即非 0 退出）。原始日志保存在本机 Git
忽略的管理目录，不入 Git；本文件不写本机路径。
**未修改 `scripts/test-all.mjs` / `package.json`**，因此 `npm test` 不包含这两套；
本轮未重跑其它套件，不声称全套回归通过。

所有测试均为合成临时库，即真实 SQLite 行为验证均使用合成临时库；未使用真实账套 / 备份 / 税局凭据。
只读 CLI 的产品边界（A 契约 §9）不变。
本轮（文档更新）**未重跑**业务测试。

## 6. 后续开放条件

- **本包收尾**：本轮文档更新会产生最终新 head，交回原独立审查者绑定该 head 做增量复核；之后才由
  管理者建 PR 并 attach、按已授权流程合并（主线合并锁在 root）。在此之前不预报 PR 号 / merge SHA。
- **B**：LOCAL-02 真正合并 + 核心独占窗口 + 独立备份子包对当前 schema / audit 的支持到位后，才能接
  `db.mjs` / `accounting.mjs` / `import-incremental.mjs` 与真实 HTTP / Agent / MCP 验收。
  **本轮未接线任何领域入口**，不声称审计已覆盖实际动作。
- **C**：backup / LOCAL-07 实际合并或原 owner 明确转交后，接恢复 / 批量 / 快照验收；
  本包不重做调度器，不编辑 04 bank 文件。**真实 `createBackup` / `verifyBackup` / `restoreNew`、
  安装备份与 pending→reconcile 接线仍未完成**；unknown → succeeded 只是之后显式核验的结果，
  不声称跨库原子。
- 既有库组件安装（先备份验证）仍未实现，现库仍一律拒绝（安装接线属 B）；本包不改既有 schema / 接线，
  不具跨库原子事务。
- 原位恢复保护、版本回退、Windows 交付仍列后续包。
