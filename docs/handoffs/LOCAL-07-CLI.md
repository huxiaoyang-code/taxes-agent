# LOCAL-07 交接：持久批量任务与 CLI

- Issue：[#51](https://github.com/huxiaoyang-code/youshu-fork/issues/51)（`Refs #20 / #13 / #14`；不关闭总体 Issue）
- 负责人：`huxiaoyang-code`；实施：本机 pi 员工（`tokenhub/deepseek-v4.1-flash`，主 / 唯一回退，无子 agent / 模型切换）
- 独立 worktree：本机 `<LOCAL07_WORKTREE>`（仅本机路径，不入 Git / 不入文档）
- 分支：`codex/huxiaoyang-code/local-07-cli`
- 开工基线：`257f96275031eefa484699dd71bd012e2d221e51`（含 LOCAL-01 PR #46、LOCAL-05a PR #52、LOCAL-08 PR #50）
- 交付契约：[docs/LOCAL-BATCH-CLI.md](../LOCAL-BATCH-CLI.md) · [任务单](../tasks/LOCAL-07-CLI.md)
- 状态：**实现 + 自测 + 独立审查 5 个 P1 修复（真实复现后再修）完成；未提交 / 未 PR / 未合并**（员工不执行 Git）。
  最终功能完成仍受 LOCAL-02 / LOCAL-06 依赖约束；`period-check` / `close` / 既有库迁移 / 恢复续跑**未**完成。
- 本轮审查基线（冻结 head）：`dfad680544c279fc065334a02800fc1a7c86e602`；修复只动本包原 10 个文件。

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
7. `test/local-batch-persistence.test.mjs` — 失败隔离、前序失败门禁、一企一套绑定核验、源输入证据与显式快照选择、
   报表依赖证据（含跨年以前期间）、快照异常隔离、崩溃恢复、互斥 / fence、迁移回滚 / 备份依赖。

文档：

8. `docs/LOCAL-BATCH-CLI.md`
9. `docs/tasks/LOCAL-07-CLI.md`
10. `docs/handoffs/LOCAL-07-CLI.md`（本文件）

`git status --short` 只显示这 10 个新文件；**未修改**任何既有 accounting / db / import-* / report-* /
server / Agent / MCP / test-all / package / lock / public / 共享状态索引文件。

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
| `node test/local-batch-cli.test.mjs` | 9 / 9 组通过（A1–A5、B1、B2、C1、C2），约 8.5s | 0 |
| `node test/local-batch-persistence.test.mjs` | 23 / 23 组通过（D1、E1–E4、F1–F7、G1–G3、H1–H3、I1–I5），约 13s；修复版后连续 22 次实跑均 23/23 | 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 | 0 |
| `node test/import-strict.test.mjs` | 54 / 54 | 0 |
| `node test/report-office-export.test.mjs` | 21 / 21 | 0 |
| `node test/report-export.test.mjs` | 21 / 21 | 0 |
| `node test/smoke.test.mjs` | 28 / 28 | 0 |
| `node test/accounting-derived.test.mjs` | 31 / 31 | 0 |
| `node test/accounting-guards.test.mjs` | 23 / 23 | 0 |

原 9 组 CLI + 原 18 组持久性用例**一条未删、未放宽**；新增 I1–I5 五组针对独立审查的 P1，
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

诚实备注：上述过程中出现过 1 次 `22 / 23`，未能捕获到具体组名（不在 I1–I5，五组当时均 PASS），随后连续 22 次均 23/23；
原有用例含 PID 存活 / SIGKILL 时序判断（F3 / F4 / E1–E4），若再现请优先按该方向排查。本轮未改这些语义。

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
- 迁移：既有库（只有核心表）→ `migration_requires_backup`（退出码 3，`details.dependency=LOCAL-06 createBackup/verifyBackup`），
  不留任何 `local_batch_*` 表；同名 view 制造的建表失败 → 事务整体回滚，`integrity_check=ok`。

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
- 未重跑全量 `npm test`（本包未修改上游文件，仅跑了受影响定向套件）；不写「全仓通过」。
