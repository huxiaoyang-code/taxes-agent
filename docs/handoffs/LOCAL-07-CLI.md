# LOCAL-07 交接：持久批量任务与 CLI

- Issue：[#51](https://github.com/huxiaoyang-code/youshu-fork/issues/51)（`Refs #20 / #13 / #14`；不关闭总体 Issue）
- 负责人：`huxiaoyang-code`；实施：本机 pi 员工（`tokenhub/deepseek-v4.1-flash`，主 / 唯一回退，无子 agent / 模型切换）
- 独立 worktree：本机 `<LOCAL07_WORKTREE>`（仅本机路径，不入 Git / 不入文档）
- 分支：`codex/huxiaoyang-code/local-07-cli`
- 开工基线：`257f96275031eefa484699dd71bd012e2d221e51`（含 LOCAL-01 PR #46、LOCAL-05a PR #52、LOCAL-08 PR #50）
- 交付契约：[docs/LOCAL-BATCH-CLI.md](../LOCAL-BATCH-CLI.md) · [任务单](../tasks/LOCAL-07-CLI.md)
- 状态：**实现 + 自测 + 独立审查 5 个 P1 修复（真实复现后再修）+ 独审新增 P2 最小修复（先红后绿）完成；
  未提交 / 未 PR / 未合并**（员工不执行 Git）。
  最终功能完成仍受 LOCAL-02 / LOCAL-06 依赖约束；`period-check` / `close` / 既有库迁移 / 恢复续跑**未**完成。
- 审查 / 修复基线：P1 轮 `dfad680`、P2 轮 `1326adda88b0b941674e41f94de026790895a0eb`；两轮修复都只动本包原 10 个文件。
- 本轮（独审事实纠正）冻结 head：`f0c11d9463aa9d59e298ce03a1c9fc780c0722ed`；只改
  `server/local-batch-storage.mjs` 的**注释**与 3 份本包文档的事实表述，**未改**任何运行语句，**未重跑**测试。

## 1. 本包新增文件（10，精确）

代码 / 测试（`06-workbench`）：

1. `server/local-batch-storage.mjs` — manifest 校验与阶段计划、`local_batch_*` 结构 + component 版本、
   锁 / fencing / 租约、输入快照、报表快照、产物元数据、状态汇总、取消 / 重试。**不 import `db.mjs`**。
2. `server/local-batch-actions.mjs` — 7 类固定本地操作的真实领域适配；仅调用既有
   `importIncremental` / `postVoucher` / `generateDepreciation` / `carryForwardProfit` / `setPeriodStatus` /
   `buildReportExport`，不复制金额或结账规则。未设置 `WORKBENCH_DATA_DIR` 时 import 直接拒绝（不触碰默认库）。
3. `server/local-batch-runner.mjs` — 计划展开、逐账套顺序执行、`job`/`book`/`account-set` 锁、
   worker 线程池（`execArgv: []`）、受控发布、崩溃恢复与证据核验。同样有数据目录守卫。
4. `server/local-batch-report-worker.mjs` — 只消费已冻结 DTO，调用 LOCAL-05 纯渲染函数；
   导入无数据库副作用，返回真实 `threadId` 与可跨线程比较的渲染起止时间。
5. `scripts/local-batch.mjs` — CLI `help/start/status/resume/cancel/retry`；参数 → manifest 校验 →
   数据目录只读检查 → 才动态 import 会打开库的模块。
6. `test/local-batch-cli.test.mjs` — CLI 契约、20 家企业两月真实动作链 + 五类 CSV/XLSX/PDF、并发证据。
7. `test/local-batch-persistence.test.mjs` — 失败隔离、前序失败门禁、一企一套绑定核验（含省略 `accountSetId` 时推断账套的落库与重启核验）、
   源输入证据与显式快照选择、报表依赖证据（含跨年以前期间）、快照异常隔离、崩溃恢复、互斥 / fence、迁移回滚 / 备份依赖。

文档：

8. `docs/LOCAL-BATCH-CLI.md`
9. `docs/tasks/LOCAL-07-CLI.md`
10. `docs/handoffs/LOCAL-07-CLI.md`（本文件）

本包边界仍是这 10 个文件（首轮为新增；随后冻结在 `1326add`）。本轮 P2 + 并发修复只修改其中 **8** 个
（`scripts/local-batch.mjs`、`server/local-batch-{actions,runner,storage}.mjs`、`test/local-batch-persistence.test.mjs`
与 3 份本包文档），另外 2 个文件（`server/local-batch-report-worker.mjs`、`test/local-batch-cli.test.mjs`）未改；
**未新增 / 重命名 / 删除文件**，也**未修改**任何共享入口 / accounting / db / import-* / report-* /
Agent / MCP / test-all / package / lock / public / 共享状态索引文件。

## 2. 已实现能力（真实可用）

- CLI：`--data-dir` 必填；`start` 必填 `--manifest` + `--output-dir`；退出码 `0/1/2/3` 分层；
  stdout 只有受控 JSON，stderr 只有错误码；`status` 只读（不建表 / 不升级 / 不续跑，缺库 `database_not_found`）。
- manifest v1：精确白名单 + 大小 / 数量上限 + 期间 / ID / 路径 / NaN 校验；`jobKey` 与规范 manifest 哈希绑定；
  同 key 同内容幂等、同 key 异内容 `job_key_manifest_conflict`；同 key 不同输出根 `job_output_dir_conflict`。
- 固定阶段顺序：`import → post → depreciation → carryforward → period-check → close → reports`；
  `close` 必须同期间 `periodCheck=true`；`post` 必须显式列出凭证（`voucherId` / `sourceVoucherId`）。
- 持久化：`local_batch_component/jobs/items/stages/locks/artifacts/snapshots/inputs` 全部在同一个 `workbench.db`，
  外键 / 唯一约束真实生效；建表 + component 记录同一事务，失败整体回滚。
- 互斥与 fencing：`job:<id>` / `book:<规范enterpriseKey>` / `account-set:<id>` 数据库行锁 + 单调 token + 租约；
  租约内且 owner 存活或存活不明 → 保守拒绝（`lock_active` / `owner_active`）；PID 确认死亡 → 递增 fence 接管；
  阶段结果写入与 fence 校验同事务，旧 token / 旧 attempt 迟到提交被 `fence_lost` 拒绝。
- 并发启动（本轮附带修复）：共享库初始化的瞬时锁冲突（`database is locked`）有限重试并归一为 `database_busy`
  （退出码 3），不再误报 `database_unreadable`（库本身可读）或外泄 `ERR_SQLITE_ERROR` / 误报参数错误。
- 幂等与恢复：导入沿上游 batchId / 来源 / 内容指纹（commit 后崩溃 → 回放 + 逐张 `sourceTrace` 核验 + 补 checkpoint）；
  过账 / 计提 / 结转 / 封账 effect + checkpoint 同事务；产物发布后崩溃 → 按 `artifact_key + snapshotHash + bytesHash`
  补记、不重新渲染；`resume` 每次都重新核验已成功阶段上游证据（反过账 / 改动 / 删除 → `needs_review`）。
- **前序阶段门禁（本轮修正）**：按「期间 → 阶段顺序」线性推进；任何前序 `failed` / `needs_review` 都不得被越过
  执行后序阶段（后序未开始阶段标 `needs_review` + `prior_stage_unresolved`，证据记 `blockedBy`）；
  同一次执行内某阶段自身登记 `needs_review`（如计提有卡片到期但本次无动作）同样立即停止该 item；
  显式 `retry` 仍可重开未完成阶段（修复后照常完成，已成功阶段不重跑）。
- **一企一套绑定核验（本轮修正）**：每个 item 在**任何**动作前先核验 `import_enterprise_account_sets` 绑定，
  覆盖无 import 的过账 / 计提 / 结转 / 检查 / 结账 / 报表 / 恢复核验；不一致 → `enterprise_binding_mismatch` /
  `account_set_enterprise_mismatch` / `enterprise_binding_missing`，`needs_review` 且**零业务写入**，其它企业继续。
  报表快照函数自身也做同样核验，不只修导入分支。
- **源输入证据（本轮修正）**：首次 `start` 与普通 `resume` 都重新核验源文件指纹；源文件被改 / 丢失时拒绝静默沿用
  旧快照（`input_changed` / `input_missing`，零写入）；只有显式 `--use-saved-inputs` 才用受保护快照，
  并在导入阶段证据写入 `inputEvidence = { mode: "saved_snapshot", reason, sourceHash }`；未用开关时为
  `mode: "source_file_verified"`。已完成项的证据规则不变。
- **推断账套持久化（本轮 P2 修正）**：`accountSetId` 仍是 manifest 可选字段；省略时由 `import_enterprise_account_sets`
  绑定推断，且**在绑定核验通过后立即写入** `local_batch_items.account_set_id`（`account_set_source = enterprise_binding`）。
  后续阶段作用域、产物证据 `accountSetId`、恢复核验都用这个持久值；恢复核验的账套作用域取「证据记录的账套，否则已落库的账套」，
  不再以 `null` 重算业务摘要。错绑定 / 缺绑定仍发生在任何写入之前（零业务写入），也不覆盖 manifest 已声明的账套。
  已转 `needs_review` 的旧任务仍需显式 `retry`（不自动改回成功）。
- **报表依赖证据（本轮修正）**：`businessHash` 从「仅本期 `period=?`」扩展为报表真实依赖范围：账套登记、
  科目定义、全部期初、该账套启用期起至期末的全部已过账凭证 + 分录指纹（以前期间 / 跨年 / 本年累计）、
  期末及以前期间状态；五类报表共用同一边界。以前期间反过账 / 改金额 / 删除后 `resume` 必须转 `needs_review`
  （`evidence_changed` / `report_evidence_changed`），且旧产物不被覆盖（真实重算 hash 与旧产物不同）。
- **快照 / 参数异常隔离（本轮修正）**：报表快照抛错（期间未登记、明细账科目不存在、绑定不符）只把该 item 的
  报表阶段标为 `failed` / `needs_review`（含错误码与证据），其它企业继续；不再让整个 job 以 `exit 2` 中止。
  崩溃 / 取消 / fence 语义未改动。
- 输入快照：读一次字节、hash 与解析同一份、限长、拒非法 JSON；变更 / 缺失 / hash 被改 → `input_changed` /
  `input_missing`（`--use-saved-inputs` 显式仅用受保护快照）。
- 报表：主线程一致只读快照生成 DTO/CSV 并立即释放事务；worker 池真实并发（`1..8`），记录真实 `threadId` 与
  渲染起止时间；合成 / 受控临时文件 → hash 校验 → **不覆盖**发布到受控相对路径；`output_conflict` 拒绝覆盖。
- 取消：`cancel_requested` 只登记意图；存活执行者确认后停止后续阶段，未开始阶段标 `cancelled`；
  已提交会计动作与已发布产物保留；`cancel` 在同步写边界与渲染阶段都有测试。
- 依赖缺失如实标注：`period-check` → `blocked_dependency` + `dependency_unavailable`（LOCAL-02）；
  既有库新增结构 → `migration_requires_backup`（LOCAL-06），无任何绕过开关。

## 3. 实测结果（本轮实际执行，非预报）

工作目录：`06-workbench`；Node `v24.15.0`；依赖 `npm ci --ignore-scripts`（未改 package / lock）。

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node test/local-batch-cli.test.mjs` | 9 / 9 组通过（A1–A5、B1、B2、C1、C2），约 8.5s（本轮 P2 修复后重跑） | 0 |
| `node test/local-batch-persistence.test.mjs` | **25 / 25** 组通过（D1、E1–E4、F1–F7、G1–G3、H1–H3、I1–I7），P2 修复前为 23 / 25 | 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 | 0 |
| `node test/import-strict.test.mjs` | 54 / 54 | 0 |
| `node test/report-office-export.test.mjs` | 21 / 21 | 0 |
| `node test/report-export.test.mjs` | 21 / 21 | 0 |
| `node test/smoke.test.mjs` | 28 / 28 | 0 |
| `node test/accounting-derived.test.mjs` | 31 / 31 | 0 |
| `node test/accounting-guards.test.mjs` | 23 / 23 | 0 |

P1 轮的 9 + 23 与本轮 P2 + 并发修复后的 9 + 25 都已实际重跑；每一轮的**完整 stdout + stderr** 都整份保存在本 worktree 的
`.agent-runs/` 诊断日志（Git 忽略目录，不入 Git），不只保留尾部，便于失败时定位具体组。
并发探针（双进程真实 CLI 同时 `start`）也保存在同一目录：修复前 60 轮复现 2 次失败，修复后 60 + 150 轮 0 次失败（§3.4）。
**该 60 / 150 的“0 次失败”只指该探针自身的观察**，属於新探针结果，**不能**用来覆盖 / 解释历史两次未知故障。
最终定稿代码（含并发修复）又实跑一次：`persistence` **25 / 25**、`cli` **9 / 9**，均 exit 0。

原 9 组 CLI + 原 18 组持久性用例**一条未删、未放宽**；新增 I1–I5 五组针对独立审查的 P1、I6–I7 两组针对独审新增 P2，
G1 按新规则加严（普通 `resume` 也必须拒绝源文件变化，不再只在 `retry` 分支校验）。

### 3.1 先在冻结 head 上真实复现（不是 mock）

把本轮的 4 个源文件临时回退到 `dfad680` 原文（测试保留新版），在真实 CLI 子进程 + 真实 SQLite 上实跑：

| 新组 | 冻结 head 上的真实失败现象 |
|---|---|
| I1 | `failed` 说明：`甲 depreciation 不得被执行` —— post 失败后 resume 仍真实执行了计提 |
| I2 | job `status: succeeded`，item-a 把草稿过账进「不属于该企业」的未绑定账套（`exit 0`） |
| I3 | `AssertionError: [local-batch] period_not_registered` —— 快照异常让整个 job `exit 2`，两家都未完成 |
| I4 | resume 返回 `status: succeeded`、`verified: {ok:true}`，而旧期反过账后真实重算的 CSV hash 已不同 |
| I5 | 源 payload 金额 100→200 后普通 resume `exit 0 / succeeded`，写入旧快照的 100 |
| G1 | 加严后：普通 resume 没有拒绝源文件变化（旧行为只在 retry 校验） |

即在冻结 head 上持久性套件为 `17 / 23`（原 18 组仍全部通过）；修复后 `23 / 23`。
随后已把源文件恢复为修复版，并校验行尾为 LF（`.gitattributes` 要求）。

诚实备注（事实纠正）：P1 阶段出现过**两次** `22 / 23`（不是一次），但当时**只保留了输出尾部、原始完整输出缺失**，
因此这两次失败的**原因至今仍未定位**。本轮的新探针只**独立观察到**两类瞬时 SQLite 锁竞争现象（§3.4），
**不声称**已证明那两次历史失败的根因，也**不绝对排除** PID 存活 / SIGKILL 时序、账务逻辑或断言层面的原因；
后续需另行复现并分别处理「只读探测锁竞争」与「共享 `db.mjs` 初始化锁冲突」两类故障，
**也不得靠多轮绿覆盖未知历史故障**。

### 3.2 主要断言要点（真实数据，非文件存在检查）

- 20 家规范企业 / 每企 1 账套，480 个阶段（440 succeeded + 40 dependency-blocked），300 个产物
  （每企业 15 = 5 类 × 3 格式），逐企业按**独立手算表**核对现金、固定资产、累计折旧、应付职工薪酬、
  本年利润、资产总计 / 负债与权益、利润表净利润（本期 / 累计）、余额表借贷合计、明细账期末余额；
  CSV 与 XLSX 都校对同一金额，PDF 校验头部 / `%%EOF` / 页对象。
- 并发：跨两家企业、不同 worker 线程的渲染区间真实相交，峰值 >1 且 ≤ `concurrency=3`；`concurrency=1`
  完全串行（区间不重叠）。
- 崩溃：import commit 后 SIGKILL → 回放不重复入账（阶段 attempt=2）；计提 / 结转事务中 SIGKILL → 回滚后重做一次；
  产物发布后 SIGKILL → hash 确认补记（`recovered=true`），无重复 `artifactKey`。
- 竞争：同 jobKey 同时 start 只产生 1 个 job / 1 套凭证；同账套第二个任务 `needs_review` 且零写入；
  租约过期但 PID 存活 → 不抢锁（token 仍为 7）；PID 确认死亡 → 接管并正常完成；旧 token / 旧 attempt 提交被拒。
- 失效：原文件被改 / 缺失 / 快照 hash 被改 → 稳定拒绝且零凭证（普通 resume 与 retry 都拒绝；
  显式 `--use-saved-inputs` 才写旧快照内容 100，且证据记 `saved_snapshot / input_changed`）；
  反过账 / 删除 → `evidence_changed`；完成文件丢失 → 只重生成该报表，其他阶段 attempt 与凭证数不变。
- 前序门禁：post 失败（`voucher_not_found` / `source_voucher_not_found`）后计提 attempt 仍为 0、
  `asset_depreciation_runs` 为 0；新任务对已计提期间重跑 → 真实 `depreciation_due_but_no_action`（needs_review）
  并停住结转与报表；补齐来源凭证后显式 `retry` + `resume` 才完成，且只计提一次。
- 一企一套：企业已绑定 set1 而 manifest 传 set2（且指定 set2 草稿）→ `enterprise_binding_mismatch`、零过账；
  报表分支直接调用 `buildReportSnapshots` 同样拒绝；删除企业绑定后 resume → `enterprise_binding_missing` /
  `evidence_changed`，不倒重入账、不改写已发布产物；其它企业照常完成。
- 报表依赖：跨年（2025-12）+ 当期（2026-01）已过账、2026-02 五类报表全部发布；真实反过账 2025-12 →
  五类报表阶段全部 `needs_review`（`report_evidence_changed`），资产负债表 / 现金流量表真实重算 hash 与旧产物不同、
  旧文件未被覆盖；恢复旧凭证后 `retry` + `resume` 按 hash 补记（`recovered=true`）不重复渲染；
  再反过账同年 2026-01 → 再次转复核。
- 快照异常：第一家请求未登记的 2026-02 报表 → 该 item 报表阶段 `failed` / `period_not_registered`、无产物；
  第二家草稿真实过账且报表产物落地（job `failed` → `exit 1`，不再是 `exit 2`）；真实登记期间 + 补科目后
  `retry` + `resume` 可完成。
- **一企一套（新 P2 回归）**：企业已绑定、manifest 省略可选 `accountSetId`、仅请求报表 → `start` 成功且
  `local_batch_items.account_set_id` 与产物证据 `accountSetId` 都是真实绑定账套；数据 / 文件不变的紧接新进程 `resume`
  仍 `succeeded`（`verified.ok=true`，不得 `report_evidence_changed`）；仅 post / 无 import 仅报表 / 含 import 三种形态
  同样成立；错绑定（已绑 A、声明 B）仍 `enterprise_binding_mismatch`、零业务写入、不把账套改成推断值。
- 迁移：既有库（只有核心表）→ `migration_requires_backup`（退出码 3，`details.dependency=LOCAL-06 createBackup/verifyBackup`），
  不留任何 `local_batch_*` 表；同名 view 制造的建表失败 → 事务整体回滚，`integrity_check=ok`。

### 3.3 本轮 P2（独审新增）先红后绿（真实持久化回归，不是 mock）

独立审查在冻结 head `1326add` 上用合成探针证实：企业已绑定账套、manifest 省略 `accountSetId`、仅请求报表时，
`resolveItemBinding` 仅在锁作用域推断成功，账套 ID 未落库 —— `start` 退出码 0 / `succeeded`，而
`local_batch_items.account_set_id` 与产物证据 `accountSetId` 仍为 `null`；数据与文件完全未变的紧接普通 `resume`
却 `exit 1` / `needs_review` / `report_evidence_changed`（用 `null` 重算业务摘要）。

| 阶段 | 命令 | 结果 |
|---|---|---|
| 红（冻结 `1326add`，只加新回归） | `node test/local-batch-persistence.test.mjs` | **23 / 25**，I6 / I7 失败：`AssertionError: 推断得到的账套 ID 必须持久化` / `item-post 推断账套必须落库`（`null !== 1`） |
| 绿（最小修复后） | `node test/local-batch-persistence.test.mjs` | **25 / 25**，exit 0 |

修复只在本包文件内：

1. `local-batch-runner.mjs`：绑定核验通过后立即把解析出的账套写入 `local_batch_items.account_set_id`
   （`source = enterprise_binding`），并用重读后的 item 做 item 锁、阶段执行、报表快照与恢复核验；
   错绑定 / 缺绑定仍在写入前抛错（零写），不覆盖 manifest 已声明的账套。
2. `local-batch-actions.mjs`：`verifyStageEvidence` 的账套作用域改为「证据记录的账套，否则已落库的账套」，
   计提 runs / 封账期间 / 报表业务摘要都用这个值，不再用 `null` 算摘要。
3. `local-batch-persistence.test.mjs`：新增 I6 / I7 两组真实持久化回归（含「停机后新进程 `resume`」与错绑定零写）；
   原 23 组一条未删、未放宽。

旧任务（已因该 P2 转 `needs_review`）不自动改回成功：仍按既有语义需显式 `retry` 重开报表阶段。

### 3.4 附带修复：并发 `start` 的瞬时 SQLite 锁（新探针观察，**不是**历史 22 / 23 的已证明根因）

历史事实：P1 阶段有**两次** 22 / 23 完整失败，但当时**只保留输出尾部、原始完整输出缺失**，**原因至今仍未定位**。
本轮**不**把它归因为某个已证明的根因，也**不**绝对排除 PID 存活 / SIGKILL 时序判断、账务逻辑或断言层面的可能。
本轮新增的是**独立观察**：双进程真实 CLI 探针 60 轮中 2 次失败，完整 stdout + stderr + 堆栈显示**两类**瞬时
SQLite 锁竞争现象（只说明这两类现象真实存在，**不等于**解释历史两次失败）：

| 现象 | 观察到的机制 |
|---|---|
| `exit 3` / `database_unreadable`，`details.reason = "database is locked"` | 只读探测 `inspectDataDir` 撞上另一执行者正在写、或刚关闭连接并清理 `-wal` / `-shm`；库本身可读 |
| `exit 2` / 原生 `ERR_SQLITE_ERROR`，栈 `server/db.mjs:14`（共享库建表 / 建索引初始化） | 共享 `db.mjs` 初始化没有 `busy_timeout`：另一执行者持写锁时，建表语句瞬时 `database is locked` |

后续处理计划（尚**未**整合，也不声称已根除）：分别对「只读探测锁竞争」与「共享 `db.mjs` 初始化锁冲突」两类故障
另行复现并处理，后者需管理者另排共享文件窗口；**不**用后续多轮绿覆盖这两次历史未知故障。

修复（仍只动本包文件）：

1. `local-batch-storage.mjs`：只读探测对瞬时锁**有限重试**，预算如实为「每连接 `busy_timeout = 5000`（毫秒）、
   最多 4 次尝试、重试间额外睡眠合计 300ms（50 + 100 + 150）」，**没有** < 1 秒或其它全局总时长截止；仍失败才如实报
   `database_unreadable`（fail-closed，不猜也不放宽），不会把瞬态当成库损坏或需要备份。
   独审真实观察（非推断）：用另一份 DELETE-journal 模式的 SQLite 库以 `BEGIN EXCLUSIVE` 持锁，另一子进程单次
   `inspectDataDir` 实测 29812ms（wall 29867ms），最终 `readable=false` / `database is locked`。该数字只描述那一次观测，
   不推断「每个环境固定 30 秒」或「总 20 秒上限」；产品未要求 < 1 秒，本轮不新增 deadline、不改行为。
2. `scripts/local-batch.mjs`：`start` / `resume` 在加载编排层前先用本包连接（`busy_timeout`）读一次 schema，
   并在「加载编排层 + 确认批量结构」期间保持该连接存活，把并发初始化窗口降到最小；原生 SQLite 锁错误归一为
   `database_busy`（退出码 3，提示稍后重试），不再外泄 `ERR_SQLITE_ERROR` 或误报为参数错误。

实测（同一探针，双进程真实 CLI 并发 `start`，完整日志在 `.agent-runs/`）：修复前 25 轮 2 次失败 + 60 轮 2 次失败；
修复后 **60 轮 + 150 轮 0 次失败** —— **仅指该探针的观察**，不覆盖历史未知故障、也不证明并发启动已彻底解决。
修复后本包两套测试：`persistence` **25 / 25** 连续 2 次、`cli` **9 / 9**，均 exit 0。

诚实限制：共享 `server/db.mjs` 初始化仍**没有** `busy_timeout`（不在本包 10 文件边界内，**未改**）。本包只能把窗口
压到最小 + 给稳定错误码；要处理共享库初始化锁冲突还需在共享库初始化加 `busy_timeout`，需管理者另排共享文件窗口。因此
不声称「并发启动问题已彻底根除」。

### 3.5 独审本轮的独立观察（与管理侧 9 + 25 是**不同维度**）

以下为独立审查在冻结 head `f0c11d9` 上用自己的探针看到的真实结果，与管理侧本地自测**是不同维度的证据**，
不能互相代替：

- 省略可选 `accountSetId` 的三种形态（**仅 post**（无 import） / **仅报表**（无 import） / **import + report**）
  绑定推断出的账套都**真实持久化**，停机后**新进程 `resume` 成功**（未误报 `report_evidence_changed`）；
- **错绑定未被覆盖**：企业已绑定 A、manifest 声明 B 时仍 `enterprise_binding_mismatch`，不把账套改成推断值；
- **存活 owner 保守拒绝**：租约内 / 存活无法确认时拒绝抢锁；owner 释放后再次 `retry` 才成功（不按超时抢锁）；
- 原独立审查提出的 **5 个 P1 已关闭**（未回退、未放宽断言）；
- LOCAL-02 / LOCAL-06 的**真实全链路依赖尚未整合**：`period-check` / `close`、既有库迁移与恢复后新进程续跑仍未完成。

管理侧本地实跑（`cli` 9 组 + `persistence` 25 组）与上述独审观察**互补**：前者是本包自测覆盖，后者是独立视角的
持久化 / 互斥 / 绑定行为验证。两者**都不**构成 LOCAL-07 最终完成，也不证明 LOCAL-02 / LOCAL-06 已就绪。

## 4. 依赖缺口（管理者下一步）

1. **LOCAL-02（`A.periodEndCheck`）**：合并后把 actions 里的动态探测走通（已按「存在即调用」实现：
   `periodEndCheck` 返回非 ok → `needs_review`），并重跑 20 家企业链路，使 `period-check` / `close` 真实成功、
   任务状态达到 `succeeded`。当前 `close` 在没有成功检查时保持 `blocked_dependency`，不会放宽规则。
   若 02 的最终函数会自己 `BEGIN` / `COMMIT`（与 `withFencedTransaction` 嵌套），需要按 02 实际接口调整事务边界，
   并把该情况写入契约与测试；不要吞掉嵌套事务错误。
2. **LOCAL-06（`createBackup` / `verifyBackup` / `restoreNew`）**：需要真实接线「一致备份 → 事务建 / 迁结构 →
   记录备份」，以及旧结构迁移、迁移中断回滚、含 WAL 已提交数据备份、`restoreNew` 到新目录后新进程续跑、
   恢复时不继承旧运行者执行权。当前对既有库一律拒绝，**未做**上述恢复验收，也没有 `copyFile` 伪备份。
3. **共享 guard（可选）**：若要求批量与手工 HTTP / Agent 入口强互斥，需管理者另排短窗口接线共享 guard；
   本包不扩锁、不改 `server.mjs`。
4. 02 / 06 合并后由管理者更新已审基线并重跑两份测试 + 定向套件，再由未参与实现的独立 reviewer 审查。

## 5. 限制与不宣称

- 未提交 / 未推送 / 未建 PR / 未合并；head / PR / merge SHA 由管理者补。
- 不称 LOCAL-07 最终完成：`period-check` / `close` 与既有库迁移仍处依赖阻塞；本轮**未**伪造 check / close / 恢复完成，
  也未做 `createBackup → verifyBackup → restoreNew` 与恢复后新进程续跑验收。
- LOCAL-02（`A.periodEndCheck`）未合并：`period-check` 仍 `blocked_dependency`，`close` 仍是 `blocked_dependency`；
  I1 中「同一次执行 needs_review 停住后序」是用真实计提 `depreciation_due_but_no_action` 验证的，不是假 check。
- LOCAL-06（备份恢复）未合并：既有库一律 `migration_requires_backup`，未做真实一致备份 / restore-new 验收。
- 共享互斥未接线：本 CLI 只保证批量 runner 之间按账套互斥，手工 HTTP / Agent 入口仍未接共享 guard；
  该窗口未完成，需管理者另排（本轮未改 `server.mjs` / 未扩共享锁）。
- 报表是内部管理报表（`dataStatus.completeness = unverified`、`taxFilingReady = false`），不是税局申报模板；
  PDF 依赖本机中文字体，重新生成的字节可能不同（按记录 hash 校验，重生成 = 新 attempt）。
- 报表失效边界偏审慎：账套登记 / 科目定义 / 期初 / 期间状态变化会让相关期间报表证据失效（`needs_review`），
  即使某个具体科目当期金额未变；本期之后的数据不进入摘要。
- 全部测试为合成临时库 / 临时目录；未使用真实账套、凭据或税局接口；「20 家企业」不代表任何真实客户或
  税务并发验收。真实接入数仍为 0。
- **并发启动仍未彻底根除**：共享 `server/db.mjs` 初始化没有 `busy_timeout`（不在本包 10 文件边界内，未改）；
  历史上两次 22 / 23 完整失败的原始输出缺失，**原因至今未定位**，本轮新探针只观察到两类瞬时锁现象。
  本包已把窗口压到最小并归一为 `database_busy`（退出码 3）；处理共享库初始化锁冲突需管理者另排共享文件窗口。
- **只读探测无全局截止**：每连接 `busy_timeout = 5000`、最多 4 次尝试、额外睡眠合计 300ms；被外部
  `BEGIN EXCLUSIVE` 持锁时实测可达约 30 秒（29812ms / wall 29867ms）才 fail-closed。产品未要求 < 1 秒，本轮未加 deadline。
- 未重跑全量 `npm test`（本包未修改上游文件，仅跑了受影响定向套件）；不写「全仓通过」。
