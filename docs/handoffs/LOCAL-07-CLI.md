# LOCAL-07 交接：持久批量任务与 CLI（B1 已审会计核心接入）

- Issue：[#51](https://github.com/huxiaoyang-code/youshu-fork/issues/51)（`Refs #20 / #13 / #14`；不关闭总体 Issue）
- 负责人：`huxiaoyang-code`；本窗口实施：本机 pi 员工（唯一模型 `tokenhub/deepseek-v4.1-flash`，无子 agent、未执行 Git）
- 分支：`codex/huxiaoyang-code/local-07-cli`
- 本窗口事实基线：root 已实际合并 LOCAL-02 [PR #60](https://github.com/huxiaoyang-code/youshu-fork/pull/60)，actual main `dfefae0553052474b8a9308105443714bc5d9cfb`；管理者把该 main 合入本分支为 `f7ae456f02fbc3b2c606357801f3b1a4b2ba942a`（保留了已审 batch head `11f1877ff7256065387c4c696c546654c4d1f629`）。
- 只读冻结参考：batch `11f1877`、core `bd05415fe6de080b41f0dd9f6f56fb1f57d8dae0`、backup `33995009109cb922c86c9a5e9847e95554faaa4b`；组合 `04c38d4` 不是本包实施基线。
- 状态：**B1 实现 + 自测完成；未提交 / 未 PR / 未合并**（员工不执行 Git）。最终独审由未参与实现 / 本任务规划者承担。

## 1. 本包精确文件（10，未新增 / 未删除 / 未改名）

代码 / 测试（`06-workbench`）：

1. `server/local-batch-storage.mjs` — manifest / 计划 / `local_batch_*` 结构 / 锁与 fence / 输入快照 / 产物 / 状态；**新增独占新建回执与库身份绑定**。
2. `server/local-batch-actions.mjs` — 7 类固定操作的真实领域适配；B1 改为按 LOCAL-02 实际 DTO / 核心入口判定。
3. `server/local-batch-runner.mjs` — 编排 / worker 池 / 受控发布 / 恢复核验；新增核心阻断码转 `needs_review`。
4. `server/local-batch-report-worker.mjs` — 仅 DTO → XLSX / PDF；本窗口未改。
5. `scripts/local-batch.mjs` — CLI；`start` 改为独占回执，其余命令加数据目录别名拒绝。
6. `test/local-batch-cli.test.mjs` — 10 组：CLI 契约 / 20 家两月真实七阶段 / 年末跨年 / 并发证据。
7. `test/local-batch-persistence.test.mjs` — 31 组：失败隔离 / 前序门禁 / 崩溃 / 互斥 / 证据失效 / 迁移 / 真实期末检查与封账 / 卡片状态 / 新建安全。

文档：

8. `docs/LOCAL-BATCH-CLI.md`
9. `docs/tasks/LOCAL-07-CLI.md`
10. `docs/handoffs/LOCAL-07-CLI.md`（本文件）

**未修改** shared `db.mjs` / `accounting.mjs` / `period-end-controls.mjs` / `money.mjs` / import-* / report-* / HTTP / Agent / MCP / test-all / package / lock / backup 及其测试。核心只读调用，发现缺口交 root 登记 owner，未以「顺手兼容」扩 scope。

## 2. B1 交付能力（真实可用，非 mock）

### 2.1 期末检查 / 封账按真实接口

- `A.periodEndCheck(setId, period)` 的真实返回是
  `{ accountSetId, period, ready, steps, blocking, missing, rules }`。
  B1 适配只读 `ready` / `steps` / `blocking`，**不再读不存在的 `ok` / `status` / `checks`**。
- 判定：`ready === true` 且 `steps` 非空且 `blocking.length === 0` → `succeeded`；否则 `needs_review`，
  证据只保留 `{ step, code }` 与步骤 `{ id, status }`，**不落企业 / 资产自由文本 details**。
- `close` 真实调用 `A.setPeriodStatus(setId, period, 'closed')`：保留「同期间 check 成功」阶段门禁，
  但**不信任旧 check 静态结果**；核心会重新校验草稿 / 试算平衡 / 计提 / 卡片总账 / 损益与年末结转 / 连续期间。
  close 效果 + checkpoint 同一 `BEGIN IMMEDIATE` 事务（核心领域用 SAVEPOINT，不套第二 BEGIN）；
  查库确认 `periods.status='closed'`；故障整段回滚。
- 新增核心阻断码统一转 `needs_review`：`period_end_check_failed` / `period_has_draft_vouchers` /
  `period_unbalanced` / `period_not_found` / `period_before_start` / `depreciation_run_stale` /
  `depreciation_draft_exists` / `depreciation_global_over_depreciable` / `asset_ledger_pending` /
  `carryforward_stale` 等；不制造 ready、不直接 SQL 置 closed、不复制封账算法。
- **恢复核验**：早前期间 `period-check` 在后续期间合法封账后会重查出 `later_period_closed`。B1 只有
  「阻断全部是该合法后续效果且目标期间仍 closed」才继续认成功；其它变化 → `needs_review`
  （`period_check_regressed`）。因此不会因自己完成 close 误判旧 check 失效，也不完全跳过真实核验。
  已失败 check 不能被 resume 越过（仍按前序门禁停住）。

### 2.2 折旧 / 结转按核心领域状态

- 计提**不再**用 `start_period <= period && remaining > EPS` 自算应提；改为逐卡调用已合入的纯规则
  `assetCardPeriodStatus(db, card, period)`：
  `not_existed`（取得期间未到）/ `not_started` / `ledger_pending`（未入账）/ `no_amount_due`（按分取整为 0）/
  `fully_depreciated`（已提足）/ `posted`（已计提）/ `due`（本期应提）/ `posted_stale` 等。
- `generateDepreciation` 无凭证时：只有存在真实 `due` 卡才 `needs_review` +
  `depreciation_due_but_no_action`；其余真实「不适用」如实 `not_applicable`，证据记录每卡状态与应提 / 已提分金额。
- 生成凭证时仍核 runs 与凭证借 / 贷金额一致；核心抛出的 `asset_ledger_pending` / `depreciation_run_stale` /
  `depreciation_global_over_depreciable` / `depreciation_draft_exists` 全部转 `needs_review`，不静默补提。
- 结转沿用真实已过账凭证 + 余额证据；`carryforward_stale` / `year_end_carry_expected` 不再只靠异常名字。
- 测试用正式建卡 / 期初 / 凭证入口准备数据，未伪造卡片与总账一致。

### 2.3 独占新建事实（仍**不**开放现库批量组件安装）

- 旧的「`assertInitializable` 返回 fresh 布尔 → `ensureBatchSchema({freshDatabase: init.fresh})`」已移除；
  **布尔值 / 自造回执不再能建立结构**（无回执一律 `migration_requires_backup`）。
- 新流程：只允许「数据目录里根本没有 `workbench.db`」的显式新目标；`claimFreshDataDir` 先校验目录真实身份，
  再以 `O_EXCL` 原子创建 `.local-batch-create` 所有权标记和**零字节 `workbench.db` 本身**，把
  `dev/ino` 绑定进进程内不可伪造回执（`WeakSet`）。
- `ensureBatchSchema` 必须收到本进程回执；建表前后都核验：目录 realpath 与显式路径一致、库文件非符号链接、
  `PRAGMA database_list` 的 main 文件一致、`dev/ino` 未被替换、所有权标记 nonce 仍属于本进程。
  事务失败整体回滚；成功后才释放标记。
- 并发抢同一新目标：`O_EXCL` 保证最多一个拥有创建资格；另一个稳定 `fresh_target_claimed`（退出码 3），
  只有能确认完整已初始化结构时才按已有库路径继续，否则拒绝，不「帮忙修半库」。
- 已有核心库（空业务 / 非空 / **零字节文件** / 缺批量表）继续 `migration_requires_backup`；
  符号链接 / junction 目标稳定 `data_dir_alias`。故障清理只删除本进程证明创建的标记 / 空库文件。
- 已合法安装 batch 的原库继续 `start` / `resume` 正常（不再要求 fresh）。

## 3. 实测结果（本窗口实际执行）

工作目录 `06-workbench`；Node `v24.15.0`；合成临时 SQLite / 临时目录；未连真实账套、凭据或税局。

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node test/local-batch-cli.test.mjs` | **10 / 10** 组通过（A1–A5、B1、B2、B3、C1、C2） | 0 |
| `node test/local-batch-persistence.test.mjs` | **31 / 31** 组通过（D1、E1–E6、F1–F7、G1–G3、H1–H4、I1–I7、J1–J3） | 0 |
| `node test/accounting-period-integrity.test.mjs` | 45 / 45 | 0 |
| `node test/accounting-period-http.test.mjs` | 通过（随机回环服务，不碰既有税局后端） | 0 |
| `node test/report-office-export.test.mjs` | 21 / 21（含真实 PDF 几何抽查） | 0 |
| `node test/report-export.test.mjs` | 21 / 21 | 0 |
| `node test/import-incremental.test.mjs` | 49 / 49 | 0 |

本包两套测试的完整 stdout + stderr 已整份保存在本 worktree 的 `.agent-runs/`（Git 忽略，不入 Git）。
历史上的 **9 + 25** 是旧基线事实；B1 新结果是 **10 + 31**，不是删断言保数字。

### 3.1 20 企业 × 连续两月真实七阶段

- 新临时目录由**正式 CLI `start`** 建立批量结构（独占回执；不是预建 core 库 + fresh 布尔豁免）。
- 20 个不同规范 `enterpriseKey`，各自唯一账套；月 1 首次 `create`，月 2 向同一账套 `append`；
  月 1 另有跨批同来源幂等回放，真实核验 `sourceTrace`。
- 每月真实执行 `import → post → depreciation → carryforward → period-check → close → reports`；
  两月都真实 `period-check` / `close` 成功，期间 `closed`。
- 任务计划实际条数：主任务 **840 个 stage** =
  20 企业 × [2 月 × 6 个动作阶段（import / post / depreciation / carryforward / period-check / close）
  + 2 月 × 15 个报表阶段 = 12 + 30]；全部 `succeeded`。
  另有 provisioning 任务的 20 个 import stage（首次 create）。
- 业务事实：每企业 8 张已过账凭证（两月各 2 导入 + 1 计提 + 1 结转）、2 条计提 run、
  3 个 completed 批次（provision create + 月 1 跨批回放 + 月 2 append）。
- 报表产物：每企业每月 15 = 5 类 × 3 格式（CSV / XLSX / PDF），共 **600 个**，
  逐个核对文件存在、字节 hash、MIME、受控相对路径；XLSX 读工作簿值，PDF 核头 / `%%EOF` / 页对象。
- 独立手算表（元，金额按分断言）：
  - 公司 1 完全采用任务样例：期初银行 10000 + 设备 1200 = 资本 11200；设备零残值 12 期、每期 100；
    月 1 收入 2000 / 费用 300 / 折旧 100 → 银行 11700、设备净值 1100、月利润 1600、权益 12800；
    月 2 收入 1500 / 费用 250 / 折旧 100 → 银行 12950、设备净值 1000、月利润 1150、累计 2750、权益 13950。
  - 其余 19 家使用不同银行期初 / 设备原值 / 寿命（6 / 12 / 24 期）/ 收入 / 费用，逐家独立核对；
    未串读同一账套。
  - 核对的报表项：资产总计、负债合计、所有者权益、固定资产净值、累计折旧、资产负债表平衡、
    利润表本期 / 年累计净利润、余额表借贷合计、明细账期末余额、现金流勾稽，CSV 与 XLSX 同金额。
- 同 `jobKey` / 同 manifest 再次 `start`：不新增账套 / 凭证 / run / 产物，stage `attempt` 不变；
  新进程 `resume` 同样不重跑，早前 `period-check` 不被后续 close 误判失效。

### 3.2 年末跨年样例（B3，独立核对）

- 2026-12：收入 12000、费用 2000 → 年利润 10000；`yearEnd=true` 结转后 3103 = 0、3104 = 10000；
  资产负债表未分配利润 10000；利润表本期 / 年累计 10000。
- 2027-01：收入 3000、费用 1000 → 月利润 2000；普通结转后 3103 = 2000、3104 仍 10000；
  2027 年期初未分配利润 10000、期末 12000；利润表本期 / 2027 年累计 2000（按年重置）。
- 两期 `period-check` / `close` 均真实成功；新进程 `resume` 不重跑。

### 3.3 失败隔离、陈旧 check 与 close 崩溃点

- J1：3 家企业中 1 家故意缺计提 → 该家 `period-check` 真实 `needs_review`（blocking 含 depreciation 步），
  close / reports 被前序门禁停住；另 2 家照常 check / close / report 成功。
  按核心顺序反过账旧结转 → 独立任务真实计提 → `resume` 把失效结转标 `needs_review` →
  显式 `retry` 只重开 carryforward / period-check / close / report → `resume` 完成；
  另 2 家 stage `attempt` 与凭证完全不变。
- J2：`period-check` 成功后、`close` 之前用受控 hook 真实新增一张草稿凭证；core `setPeriodStatus` 重新拒绝
  `period_has_draft_vouchers`，close 阶段 `needs_review`，期间保持 open。旧 check 成功不代替核心前置。
- E5：close 事务中 SIGKILL → 期间保持 open（close 效果未提交）；重启后重新封账一次，结转不重复。
- E6：close 已提交后 SIGKILL → 期间 closed、close 阶段与 checkpoint 同事务已 `succeeded`；
  新进程 `resume` 识别已提交合法效果，不重复封账。
- J3 卡片状态适配：取得期间未到 → `not_existed`；未入账 → `asset_ledger_pending`（needs_review）；
  0 分分期 → `no_amount_due`；期初累计已提足 → `fully_depreciated`；已计提 → `posted`；
  后四类不适用状态均不生成凭证。

### 3.4 并发与新建负例

- C1：至少两家企业、不同 worker 线程的 XLSX / PDF 渲染区间真实相交；本窗口实测峰值 **3**（= `concurrency=3`），
  跨企业重叠线程为两个不同线程（本次运行 3 / 1，threadId 随运行变化，不作固定值），区间重叠 = true；
  记录真实 `worker_thread_id` 与可跨线程比较的起止时间。
- C2：`concurrency=1` 对照，渲染区间不重叠、峰值 = **1**。
- 并发口径如实说明：SQLite 业务写事务始终串行；并发只发生在 **XLSX / PDF 报表渲染 worker 线程**，
  不是账务写并发，也不是队列长度或 mock 延时。
- H4：同进程 / 跨进程第二个新建占用者均 `fresh_target_claimed`；零字节既有库 / 非空目录 /
  探测后库文件被替换 / 伪造回执都不能建立批量结构或改动他人文件。

## 4. 历史事实与限制（不得删除 / 不得用本轮绿色覆盖）

- **历史两次 22 / 23 完整失败**：P1 阶段出现过**两次**，当时**只保留输出尾部，原始完整输出缺失**，
  **原因至今仍未定位**。本窗口的新结果**不能**用来覆盖、解释或声称已修复这两次历史故障；
  也不把它归因到某个新探针问题。
- **只读探测无全局 deadline**：每连接 `busy_timeout = 5000` 毫秒、最多 4 次尝试、重试间额外睡眠合计 300ms
  （50 + 100 + 150），**没有** < 1 秒或其它总时长截止。独立审查曾用 DELETE-journal 库 `BEGIN EXCLUSIVE`
  持锁，实测另一子进程单次 `inspectDataDir` 29812ms（wall 29867ms）后才 fail-closed
  （`readable=false` / `database is locked`）。该数字只描述那一次观察，不承诺固定总时长。
- 共享 `server/db.mjs` 初始化仍**没有** `busy_timeout`（不在本包 10 文件边界内，未改）；
  CLI 只能把并发初始化窗口压到最小并归一为 `database_busy`（退出码 3），不声称并发启动已彻底根除。
- 本包**未**实现现库安装 backup / component、全产品共享手工入口互斥、`restoreNew` 实例分叉；
  这些仍归 W3 / W4，不能写成 LOCAL-07 整包完成。
- 报表仍是内部管理报表（`dataStatus.completeness = unverified`、`taxFilingReady = false`），不是税局申报模板；
  PDF 依赖本机中文字体，重新生成字节可能变化（按记录 hash 校验）。
- 未接税局、未使用真实账套 / 凭据；「20 家企业」为合成数据，真实接入数仍为 0。

## 5. 租约 / PID 分支的事实边界（§3.5 纠正）

> **租约已过期、PID 确认仍存活时拒绝抢锁；owner 释放后再次 retry 成功。本次独审没有实测 PID 存活无法确认分支。**

代码对「租约内且 PID 确认死亡」也会接管，对「PID 存活无法确认」保守拒绝；这些是**代码策略**，
不等于独审已实测所有分支。F3 用真实存活子进程覆盖「租约过期 + PID 存活 → `owner_active`」，
F4 用确认死亡 owner 覆盖接管与 fence 递增；本轮**未**新增「PID 存活无法确认」的真实受控验证，
因此不把该分支写成已测。

## 6. 依赖缺口与下一包

1. **W3（现库组件安装 / 备份支持 / 共享手工入口互斥）**：把已审 backup `createBackup → verifyBackup`
   接到「既有库新增 / 升级 batch 组件」，并接线批量与手工 HTTP / Agent 入口的共享互斥。
   当前本 CLI 对既有库仍 `migration_requires_backup`，只保证批量 runner 之间按账套互斥。
2. **W4（restoreNew / 实例分叉 / 旧锁与路径 / 报表重建）**：真实 `createBackup → verifyBackup → restoreNew`、
   恢复后新进程续跑、旧锁 / 路径处理与报表重建；本窗口未做，也没有 `copyFile` 伪备份。
3. 共享 `test-all` / docs 索引由对应 owner 另窗口接线；本包只显式列出所跑命令，
   **不**声称已进入总测试入口或全仓通过。
4. 若 #53 / #03 / #45→#44 同期有 main 变动，串行整合，不覆盖 owner 成果；基线变化需重验受影响范围并锁完整已审 head 后 PR。

完成本包验收 / PR 合并 / 交接后关闭本窗口 pi；下一包使用新进程、新会话，只载入任务所需材料。
