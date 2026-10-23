> **2026-10-24 W3a 同轮返工候选**：完整 `605e057794850a19d0f533ce273323b4ae1c7f4d` 复审仍拒一项P2：已claim/成功report缺必需snapshot/artifact反向存在性；原内部种子失败保全P2已由独审实际闭合。现补own tuple存在与归属，保未claim无记录、已claim未发布、旧attempt及最新可变DTO/CSV窗口。实际report-p2两组/92拒绝和两安装夹具定点、失败历史见[LOCAL07交接](LOCAL-07-CLI.md)。尚待root新冻结十一影响套及新完整head独审，未PR/合并；原八包6/8、LOCAL06/07未完、税局真实接入0。

## 2026-10-23 W2a 实施自测交接（未管理验收、未PR、未合并）

基线为PR74实际merge `c4ae3674988ebefdc80baf12a2a20b06ff623147`，Issue54仍OPEN。本片严格限定21路径窗口，实际改20文件；旧local-backup测试未改，bank/aux旧测试只运行未改。唯一授权fallback没有Git、没有自行派agent，也没有启动后端或税局服务。

已实现：business-audit2保护安装/升级、完整audit1/2结构与内容检查、官方create/verify/restoreNew/again备份、audit先装后bank/aux四顺序、持久pending与私有单用授权、owner-only同步execute与技术receipt、失败真实ROLLBACK后留痕、unknown不自动重跑。格式1历史事件/实例/digest/dedupe保持，旧无路径安装和append/run/deferred/fork写旁路关闭。详细API见[当前审计合同](../LOCAL-AUDIT.md)。

实际自测 cwd `06-workbench`，均用已核node执行：

- `node test/local-audit-install.test.mjs`：24个core/组件/audit组合、四audit先装顺序、真实官方verify损坏与held写锁、错路径/句柄/私密missing路径、真实硬链接/junction拒绝、DDL回滚、BUSY及陈旧源绑定，最终exit0/actualclose。Windows对打开中的源文件实际rename EBUSY，记录系统阻止替换；不冒称产品已看见该换件。
- `node test/local-audit-operation.test.mjs`：真实双连接/双子进程同key竞争callback总1；合成9.79加1.37后11.16、另一账套28.63不变且借贷平衡；单次/伪造/跨句柄/跨实例/关闭授权、outer事务零写且仍在、确定失败attempt、getter0/Proxy/Promise/thenable/伪error属性、真实COMMIT BUSY+ROLLBACK、审计RAISE及失败留痕也失败、callback事务丢失unknown、pending/业务中/提交前/提交后响应丢失四真实kill窗，exit0，所有自有child实际close。
- `node test/local-audit-backup-integration.test.mjs`：WAL与非WAL、v1历史保全/pending忠实恢复而不授执行权、18项结构/内容攻击与CHECK/FK/rowid/UNIQUE四SQL重建攻击，源create/重算snapshot摘要后的verify/restoreNew均拒；漏报组件manifest及audit1/2只读CLI/缺库不创建均通过，最终exit0/actualclose。
- `node test/local-audit.test.mjs`：原A覆盖迁为私有冻结DDL历史fixture的只读/摘要/分页/过滤/隐私/append-only与协议旁路拒绝，纯事务utility单独保留；补真实CLI stats/instances、非法命令/参数/缺db/init禁止、缺库不创建、坏version/column/trigger/instance所有只读命令拒绝且不repair，共8分组，最终单套exit0/actualclose。
- 旧 `node test/local-backup.test.mjs` 29/29、`node test/bank-reconciliation.test.mjs` 43/43、`node test/auxiliary-storage.test.mjs` PASS，均exit0/主child实际close。前两套在同一授权审批环境补验真实links后通过，没有改旧断言。最后仅实例内容validator与新fixture扩充，按root要求未重复已绿旧套。

必要审计4套各次运行前后13源/测试hash一致；最终install/integration追加断言各自前后hash也一致。新增模块与3测试末尾仅单LF、无BOM/尾随空白；11文件syntax check通过，package/lock仍与clean WT依赖安装manifest完全一致，没有npm/加依赖。原88登记逐字原序，仅末尾追加3至静态91，未跑full入口/npm test。

失败历史保留：初次历史行比较因SQLite null-prototype与object spread测试差异失败；首次links沙箱EPERM、旧backup28/29与bank42/43失败，审批同命令真links补验通过；writable_schema攻击被默认defensive拒绝，改测试私有重建DDL而未关闭防护；新增合成小数使测试快照误用安全整数canonical失败，改测试快照JSON；后续WITHOUT ROWID攻击使快照工具ORDER BY rowid失败，移除测试快照对rowid的假设后该套通过。均非删除断言/伪造成功，失败夹具全保留。

本机可核验日志run键：最终operation为 `1dbb5dec-d4d8-48e3-b723-337a5ac3855e`，最终旧audit为 `2c359514-b60e-4176-a3f6-570c5674f69b`；最终install含verify损坏为 `095e6477-797a-4268-8aac-67d5f226778f`；最终backup-integration为 `8682cda5-8d0c-4ec6-8623-831b73ad1d92`；旧backup/bank审批通过为 `951c17b4-ce94-4a1e-a8a4-d354164ebe06`；旧aux为 `1c674ce1-0c77-4b24-a1f6-6ef185418397`。本机忽略目录证据供root核验，不作为另一电脑恢复前提；最终文件SHA清单交管理者保存。

未完：本片只是W2a候选。下一片先W3a batch1/2严格registry与保护升级，再W2b可信业务coordinator，随后W3b统一锁/真实批量链、W4恢复分叉、Windows W2与最终整链。restoreNew仍仅字节恢复，不fork实例/发布/续跑。LOCAL06/07仍未完成，原八包01/02/03/04/05/08为6/8，真实税局0；页面paste/filechooser仍未实操。等待root独立验收与全新未实施者独审，不写未发生的PR/merge。

> 2026-10-23 LOCAL06 W2a 实施候选：基线PR74 merge `c4ae3674988ebefdc80baf12a2a20b06ff623147`，尚未管理验收/独审/PR/合并。audit2保护安装、严格audit1/2官方备份、私有单次授权与技术回执及audit先装bank/aux顺序见[当前合同](../LOCAL-AUDIT.md)。本片不完成LOCAL06，业务coordinator/W3a batch registry/W3b统一锁与批量/W4恢复分叉/Windows与最终整链仍未完。原八包6/8、税局0。下方原A包为历史验收，不能代替本片定点。
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

## W2a 已合事实（W3a 开工核对，2026-10-23）

PR [#75](https://github.com/huxiaoyang-code/youshu-fork/pull/75) 已于 2026-10-23T14:42:07Z 合并；已审完整 head `7220dd10b4e1e3f9bf10c56f5a1cf6638b1ec2a5`，merge/main `4223ccb3ad2c1b71178f2a510ed1f196ff963f03`。此处事实由 root 核实提供，覆盖前文尚待 PR 的历史状态。

root 十套影响回归实际 exit 0；两 profile 独立验收 1000→1067.19、确定失败回滚后仍 1067.19、新 attempt 1055.11；双连接、pending 及官方联合恢复实际 exit 0，连接实际关闭，文件哈希一致。全新未参与实施者对完整 head 独审接受，无 P1/P2；其独立合成金额 423.71→441.94→失败仍 441.94→新 attempt 436.25。真实 COMMIT 后异常为 unknown，只读重放返回已提交终态；历史 audit1、反序安装、联合恢复、receipt 非法字段及 actor 不一致拒绝通过，7 个连接实际 close、20 项哈希一致。首次独审夹具因索引建序失败保留，修正夹具后在新根通过，未改产品。

W2a 交付的是原语、严格 audit1/2 保护安装和官方备份登记，尚不代表领域入口已接线。原八包仍 6/8；LOCAL06/07、W2b 业务 coordinator、W3b 共享写锁与真实 20 企业检查点、W4 恢复和最终 Windows 链仍未完成。

## W3a 后继候选（尚未 root 验收 / 独审 / PR / 合并）

在PR75基础上已实施strict batch1/2官方registry、受保护batch2安装与ready门，audit命名空间准确识别及后装当前NULL关联；未改audit1/2历史DDL/摘要/owner-only/pending协议。实际必要定点、先前失败与最后report历史/释放保全增量边界见[LOCAL07交接](LOCAL-07-CLI.md)。W2b领域coordinator仍待后包，原LOCAL06/07不标完成。
